// HermesFLLM session anchor: one model per agent session, changed only for real failures, and never
// for a weaker one if a peer or a stronger one can serve.
//
// The upstream sticky session remembers the LAST model that answered. One failover is enough to make
// it drift: the strong model hits a rate limit, a smaller model answers that turn, and from then on
// the smaller model is the session's model until it fails too. A long agent task slides down the
// catalogue one hiccup at a time, and every switch costs coherence (a different style of tool calls,
// a different reading of the plan).
//
// The anchor fixes both halves:
// - It is the strongest model that has served the session (by size tier, then intelligence rank).
//   A weaker model that answers after a failover does not replace it: the next turn goes back to
//   the anchor as soon as it can serve (the router still skips it while it is cooling down).
// - While a session has an anchor, the router tries models of the anchor's size tier or above first,
//   in their usual score order, and only then the rest. A failure escalates or stays level; it drops
//   a tier only when nothing at the anchor's tier can serve.
// - A stronger model that serves the session becomes the new anchor (escalation).
//
// Agent turns only (auto-routed, with tools, after the first turn); pinned models and model groups
// keep their own rules. HERMESFLLM_SESSION_ANCHOR=0 disables it.
import { getDb } from '../db/index.js';
import { intelligenceComposite, tierValue } from '../services/scoring.js';

const TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 1000;

export function isSessionAnchorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HERMESFLLM_SESSION_ANCHOR?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

interface Anchor {
  modelDbId: number;
  modelId: string;
  tier: number;
  composite: number;
  /** A weaker model answered since the anchor last did. */
  displaced: boolean;
  lastUsed: number;
}

const anchors = new Map<string, Anchor>();

function strength(modelDbId: number): { modelId: string; tier: number; composite: number } | null {
  const row = getDb().prepare('SELECT model_id, size_label, intelligence_rank FROM models WHERE id = ?')
    .get(modelDbId) as { model_id: string; size_label: string | null; intelligence_rank: number | null } | undefined;
  if (!row) return null;
  const size = row.size_label ?? '';
  return { modelId: row.model_id, tier: tierValue(size), composite: intelligenceComposite(size, row.intelligence_rank ?? 1000) };
}

/** The session's anchor, or null when it has none (first turn, expired, disabled). */
export function sessionAnchor(key: string, now = Date.now()): { modelDbId: number; modelId: string; tier: number; displaced: boolean } | null {
  if (!key || !isSessionAnchorEnabled()) return null;
  const a = anchors.get(key);
  if (!a) return null;
  if (now - a.lastUsed > TTL_MS) {
    anchors.delete(key);
    return null;
  }
  return { modelDbId: a.modelDbId, modelId: a.modelId, tier: a.tier, displaced: a.displaced };
}

export type AnchorEvent = 'anchored' | 'kept' | 'returned' | 'escalated' | 'displaced';

/** Record the model that just served the session (not a race backup) and update its anchor. */
export function noteSessionModel(key: string, modelDbId: number, now = Date.now()): AnchorEvent | null {
  if (!key || !isSessionAnchorEnabled()) return null;
  let s: ReturnType<typeof strength>;
  try {
    s = strength(modelDbId);
  } catch {
    return null;
  }
  if (!s) return null;
  const current = sessionAnchor(key, now) ? anchors.get(key)! : undefined;
  let event: AnchorEvent;
  if (!current) {
    anchors.set(key, { modelDbId, ...s, displaced: false, lastUsed: now });
    event = 'anchored';
  } else if (current.modelDbId === modelDbId) {
    event = current.displaced ? 'returned' : 'kept';
    current.displaced = false;
    current.lastUsed = now;
  } else if (s.composite > current.composite) {
    anchors.set(key, { modelDbId, ...s, displaced: false, lastUsed: now });
    event = 'escalated';
  } else {
    current.displaced = true;
    current.lastUsed = now;
    event = 'displaced';
  }
  if (event !== 'kept') stats[event]++;
  if (anchors.size > MAX_SESSIONS) prune(now);
  return event;
}

function prune(now: number): void {
  for (const [k, a] of anchors) if (now - a.lastUsed > TTL_MS) anchors.delete(k);
  if (anchors.size <= MAX_SESSIONS) return;
  const oldest = [...anchors.entries()].sort((x, y) => x[1].lastUsed - y[1].lastUsed);
  for (const [k] of oldest.slice(0, anchors.size - MAX_SESSIONS)) anchors.delete(k);
}

// ── Stats for the board ───────────────────────────────────────────────────────

let stats = freshStats();
function freshStats() {
  return { anchored: 0, escalated: 0, displaced: 0, returned: 0, since: new Date().toISOString() };
}
export function sessionAnchorStats() {
  return { enabled: isSessionAnchorEnabled(), activeSessions: anchors.size, ...stats };
}
export function resetSessionAnchors(): void {
  anchors.clear();
  stats = freshStats();
}
