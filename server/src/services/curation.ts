// HermesFLLM curation: keep routing on the most reliable, most capable free models, continuously.
//
// 1. Default policy (applied once, only where the operator has not chosen): 'custom' strategy
//    weighted towards reliability and intelligence, plus a minimum reliability floor.
// 2. Small probe rounds every HERMESFLLM_CURATION_INTERVAL_MS (10 min, up to 4 probes each),
//    in priority order: models that just failed real traffic, models currently excluded (to see
//    if they recovered), the warm reserve (the most reliable models the router fails over to),
//    then whatever has gone longest without a probe. A daily cap per platform protects free quota.
//    Each probe is an agent probe: one real tool call, validated by the Agent Guard.
// 3. A failure in live traffic queues that model for a probe within seconds, not hours.
// 4. routeRequest skips a model whose fresh probes all failed (isCuratedOut). Verdicts expire
//    after HERMESFLLM_CURATION_VERDICT_TTL_MS (1h), so a recovered model comes back quickly.
import { getDb, getSetting, setSetting } from '../db/index.js';
import type { Scheduler } from '../lib/scheduler.js';
import { probeModel, probeRequest, recordProbeResult, selectProbeCandidates, type ProbeCandidate, type ModelProbeRequestDeps, type ProbeOutcome } from './model-probe.js';
import { agentGuardReasons } from '../lib/tool-validate.js';

export const CURATION_INTERVAL_MS = positiveInt(process.env.HERMESFLLM_CURATION_INTERVAL_MS, 10 * 60 * 1000);
export const CURATION_MAX_PROBES = positiveInt(process.env.HERMESFLLM_CURATION_MAX_PROBES, 4);
export const CURATION_VERDICT_TTL_MS = positiveInt(process.env.HERMESFLLM_CURATION_VERDICT_TTL_MS, 60 * 60 * 1000);
export const CURATION_DAILY_CAP_PER_PLATFORM = positiveInt(process.env.HERMESFLLM_CURATION_DAILY_CAP, 60);
export const RESERVE_SIZE = 4;
// How soon each priority class may be probed again.
const REPROBE_URGENT_MS = 2 * 60 * 1000;
const REPROBE_EXCLUDED_MS = 10 * 60 * 1000;
const REPROBE_RESERVE_MS = 20 * 60 * 1000;
// A live failure probes its model this soon (debounced), instead of waiting for the next round.
const URGENT_DELAY_MS = 30 * 1000;

// Speed carries real weight: an agent times out on a slow model even when its answer is right.
export const DEFAULT_WEIGHTS = { reliability: 0.55, speed: 0.15, intelligence: 0.3 };
export const DEFAULT_MIN_RELIABILITY = 0.9;
const POLICY_APPLIED_KEY = 'hermesfllm_policy_applied';
const STRATEGY_KEY = 'routing_strategy';
const CUSTOM_WEIGHTS_KEY = 'routing_custom_weights';
const MIN_RELIABILITY_KEY = 'routing_min_reliability_floor';

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Applies the HermesFLLM defaults once. Never overrides a value the operator already set. */
export function applyDefaultPolicy(): { applied: boolean } {
  if (getSetting(POLICY_APPLIED_KEY) === '1') return { applied: false };
  if (!getSetting(STRATEGY_KEY)) setSetting(STRATEGY_KEY, 'custom');
  if (!getSetting(CUSTOM_WEIGHTS_KEY)) setSetting(CUSTOM_WEIGHTS_KEY, JSON.stringify(DEFAULT_WEIGHTS));
  if (!getSetting(MIN_RELIABILITY_KEY)) setSetting(MIN_RELIABILITY_KEY, String(DEFAULT_MIN_RELIABILITY));
  setSetting(POLICY_APPLIED_KEY, '1');
  return { applied: true };
}

// last_probed_at holds two formats: verdicts are written as ISO ('2026-11-03T14:00:00.000Z'), the
// inconclusive path as SQLite datetime('now') ('2026-11-03 14:00:00'). Compared as text, ' ' sorts
// before 'T', so a fresh SQLite-format row read as older than any same-day ISO cutoff and a busy
// probe silently lifted an exclusion. Compare and order through julianday(), which reads both.
const modelKey = (platform: string, modelId: string, scope: string | null | undefined) => `${platform}\u0000${modelId}\u0000${scope ?? ''}`;
const parseTs = (ts: string) => Date.parse(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');

// ── Exclusion verdicts ───────────────────────────────────────────────────────

let cache: { at: number; out: Set<string> } | null = null;
const CACHE_MS = 30 * 1000;

/** Models whose fresh probes are all 'unavailable' (none 'working'). */
export function curatedOutModels(now = Date.now()): Set<string> {
  if (cache && now - cache.at < CACHE_MS) return cache.out;
  const since = new Date(now - CURATION_VERDICT_TTL_MS).toISOString();
  const rows = getDb().prepare(`
    SELECT platform, model_id, endpoint_scope
      FROM model_probe_status
     WHERE julianday(last_probed_at) >= julianday(?)
     GROUP BY platform, model_id, endpoint_scope
    HAVING SUM(status = 'unavailable') > 0 AND SUM(status = 'working') = 0
  `).all(since) as Array<{ platform: string; model_id: string; endpoint_scope: string | null }>;
  const out = new Set(rows.map(r => modelKey(r.platform, r.model_id, r.endpoint_scope)));
  cache = { at: now, out };
  return out;
}

export function isCuratedOut(entry: { platform: string; model_id: string; endpoint_scope?: string | null }, now = Date.now()): boolean {
  return curatedOutModels(now).has(modelKey(entry.platform, entry.model_id, entry.endpoint_scope));
}

export function resetCurationCache(): void {
  cache = null;
  slowCache = null;
}

// ── Latency ceiling ──────────────────────────────────────────────────────────
// An agent waits on every turn and gives up at its own timeout (Hermes: 180s). A model that is
// right but takes minutes still breaks the workflow, so routing sends models whose recent
// successful answers average above the ceiling to the back of the chain (never excluded).

export const MAX_LATENCY_MS = positiveInt(process.env.HERMESFLLM_MAX_LATENCY_MS, 60 * 1000);
const LATENCY_WINDOW = '-6 hours';
const LATENCY_MIN_SAMPLES = 3;

let slowCache: { at: number; ids: Set<number> } | null = null;

/** Models whose successful answers in the last 6h average above MAX_LATENCY_MS. */
export function slowModelIds(now = Date.now()): Set<number> {
  if (slowCache && now - slowCache.at < CACHE_MS) return slowCache.ids;
  const rows = getDb().prepare(`
    SELECT model_db_id AS id
      FROM requests
     WHERE status = 'success' AND model_db_id IS NOT NULL AND created_at >= datetime('now', ?)
     GROUP BY model_db_id
    HAVING COUNT(*) >= ? AND AVG(latency_ms) > ?
  `).all(LATENCY_WINDOW, LATENCY_MIN_SAMPLES, MAX_LATENCY_MS) as Array<{ id: number }>;
  const ids = new Set(rows.map(r => r.id));
  slowCache = { at: now, ids };
  return ids;
}

export function isTooSlow(modelDbId: number, now = Date.now()): boolean {
  return slowModelIds(now).has(modelDbId);
}

// ── Candidate selection ──────────────────────────────────────────────────────

export type CurationReason = 'live-failure' | 'excluded' | 'reserve' | 'stale';
export interface CurationCandidate extends ProbeCandidate { reason: CurationReason }

/** One probe target per model: an enabled healthy key, the one probed longest ago. */
function candidateForModel(modelDbId: number): (ProbeCandidate & { lastProbedAt: string }) | null {
  const row = getDb().prepare(`
    SELECT m.id AS modelDbId, m.platform, m.model_id AS modelId, m.endpoint_scope AS endpointScope,
           k.id AS keyId, COALESCE(p.last_probed_at, '') AS lastProbedAt
      FROM models m
      JOIN api_keys k ON k.platform = m.platform AND k.enabled = 1 AND k.status IN ('healthy', 'unknown')
     LEFT JOIN model_probe_status p
            ON p.platform = m.platform AND p.model_id = m.model_id
           AND p.endpoint_scope = m.endpoint_scope AND p.key_id = k.id
     WHERE m.id = ? AND m.enabled = 1 AND m.supports_tools = 1
     ORDER BY (p.last_probed_at IS NULL) DESC, julianday(p.last_probed_at) ASC, k.id ASC
     LIMIT 1
  `).get(modelDbId) as (ProbeCandidate & { lastProbedAt: string }) | undefined;
  return row ?? null;
}

/** Newest probe of any key of this model, in ms; 0 when never probed. */
function lastProbedMs(c: { platform: string; modelId: string; endpointScope: string }): number {
  const row = getDb().prepare(`
    SELECT last_probed_at AS at FROM model_probe_status
     WHERE platform = ? AND model_id = ? AND endpoint_scope = ? AND last_probed_at IS NOT NULL
     ORDER BY julianday(last_probed_at) DESC
     LIMIT 1
  `).get(c.platform, c.modelId, c.endpointScope) as { at: string } | undefined;
  return row?.at ? parseTs(row.at) : 0;
}

/** The warm reserve: the models with the best live success rate in the last 24h. */
export function reserveModelIds(limit = RESERVE_SIZE): number[] {
  const rows = getDb().prepare(`
    SELECT r.model_db_id AS id
      FROM requests r
      JOIN models m ON m.id = r.model_db_id AND m.enabled = 1
     WHERE r.created_at >= datetime('now', '-1 day') AND r.status IN ('success', 'error') AND r.model_db_id IS NOT NULL
     GROUP BY r.model_db_id
    HAVING COUNT(*) >= 5
     ORDER BY (1.0 * SUM(r.status = 'success') / COUNT(*)) DESC, COUNT(*) DESC
     LIMIT ?
  `).all(limit) as Array<{ id: number }>;
  return rows.map(r => r.id);
}

function excludedModelIds(now: number): number[] {
  const since = new Date(now - CURATION_VERDICT_TTL_MS).toISOString();
  const rows = getDb().prepare(`
    SELECT m.id AS id
      FROM model_probe_status p
      JOIN models m ON m.platform = p.platform AND m.model_id = p.model_id AND m.endpoint_scope = p.endpoint_scope
     WHERE julianday(p.last_probed_at) >= julianday(?) AND m.enabled = 1
     GROUP BY m.id
    HAVING SUM(p.status = 'unavailable') > 0 AND SUM(p.status = 'working') = 0
  `).all(since) as Array<{ id: number }>;
  return rows.map(r => r.id);
}

const urgentQueue = new Set<number>();
const dailyProbes = new Map<string, { day: string; count: number }>();

function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

// The daily cap protects free quota, so it must survive restarts: launchd restarts the server on
// every crash and login, and an in-memory counter reset each time let a crash loop probe without
// limit. The counts live in one settings row, written once per probe (at most 4 per round).
const PROBE_COUNTS_KEY = 'hermesfllm_probe_counts';
let probeCountsLoaded = false;

function loadProbeCounts(): void {
  if (probeCountsLoaded) return;
  probeCountsLoaded = true;
  try {
    const raw = getSetting(PROBE_COUNTS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { day?: string; counts?: Record<string, number> };
    if (typeof saved.day !== 'string' || !saved.counts) return;
    for (const [platform, count] of Object.entries(saved.counts)) {
      if (Number.isInteger(count) && count > 0) dailyProbes.set(platform, { day: saved.day, count });
    }
  } catch {
    // A corrupt row only costs today's history; never block curation on it.
  }
}

function saveProbeCounts(day: string): void {
  const counts: Record<string, number> = {};
  for (const [platform, entry] of dailyProbes) if (entry.day === day) counts[platform] = entry.count;
  try {
    setSetting(PROBE_COUNTS_KEY, JSON.stringify({ day, counts }));
  } catch (err) {
    console.warn('[Curation] could not persist the daily probe counts:', (err as Error)?.message);
  }
}

export function probesToday(platform: string, now = Date.now()): number {
  loadProbeCounts();
  const entry = dailyProbes.get(platform);
  return entry && entry.day === dayOf(now) ? entry.count : 0;
}

export function totalProbesToday(now = Date.now()): number {
  loadProbeCounts();
  let total = 0;
  for (const platform of dailyProbes.keys()) total += probesToday(platform, now);
  return total;
}

function countProbe(platform: string, now: number): void {
  loadProbeCounts();
  const day = dayOf(now);
  const entry = dailyProbes.get(platform);
  dailyProbes.set(platform, entry && entry.day === day ? { day, count: entry.count + 1 } : { day, count: 1 });
  saveProbeCounts(day);
}

/** The next round's targets, highest priority first, at most `limit`, one per model. */
export function selectCurationCandidates(limit = CURATION_MAX_PROBES, now = Date.now()): CurationCandidate[] {
  const out: CurationCandidate[] = [];
  const seen = new Set<number>();
  const tryAdd = (modelDbId: number, reason: CurationReason, minAgeMs: number): void => {
    if (out.length >= limit || seen.has(modelDbId)) return;
    const c = candidateForModel(modelDbId);
    if (!c) return;
    seen.add(modelDbId);
    if (probesToday(c.platform, now) >= CURATION_DAILY_CAP_PER_PLATFORM) return;
    if (now - lastProbedMs(c) < minAgeMs) return;
    out.push({ keyId: c.keyId, platform: c.platform, modelId: c.modelId, modelDbId: c.modelDbId, endpointScope: c.endpointScope, reason });
  };

  for (const id of urgentQueue) tryAdd(id, 'live-failure', REPROBE_URGENT_MS);
  for (const id of excludedModelIds(now)) tryAdd(id, 'excluded', REPROBE_EXCLUDED_MS);
  for (const id of reserveModelIds()) tryAdd(id, 'reserve', REPROBE_RESERVE_MS);
  if (out.length < limit) {
    for (const row of selectProbeCandidates(getDb(), limit * 2, now)) tryAdd(row.modelDbId, 'stale', CURATION_VERDICT_TTL_MS);
  }
  return out;
}

// ── Agent probe ──────────────────────────────────────────────────────────────
// "Reply with OK" proves a model answers, not that it can drive an agent, and one easy tool call
// is passed by weak models too. The probe is a short agent task instead: two tools are needed to
// answer, and the final answer must USE the tool results (values the model cannot guess). That is
// where weak models break agent work: they call one tool and stop, or answer from imagination.
// A model that fails is recorded 'unavailable' and is only tried after every passing model.
// Up to 3 requests per probe (call, maybe a second call, answer).

export const AGENT_PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
} as const;

export const AGENT_PROBE_TIME_TOOL = {
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Get the current local time in a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
} as const;

const AGENT_PROBE_TOOLS = [AGENT_PROBE_TOOL, AGENT_PROBE_TIME_TOOL];

const AGENT_PROBE_MESSAGES = [
  { role: 'system', content: 'You are an agent. Use the provided tools, then answer from their results.' },
  { role: 'user', content: 'What are the weather and the local time in Lisbon right now? Use the tools, then answer in one sentence.' },
];

// What the tools "return": values the model cannot guess, so the answer proves it read them.
const AGENT_PROBE_RESULTS: Record<string, unknown> = {
  get_weather: { city: 'Lisbon', temperature_c: 17.3, condition: 'light rain' },
  get_time: { city: 'Lisbon', local_time: '14:52' },
};
const AGENT_PROBE_MAX_REQUESTS = 3;

/** Throws (→ 'unavailable') unless the reply carries valid calls to the probe tools. */
export function assertAgentProbeReply(reply: any): void {
  const calls = reply?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    const text = String(reply?.choices?.[0]?.message?.content ?? '').trim().slice(0, 80);
    throw new Error(`no valid tool call: answered without calling a tool${text ? ` ("${text}")` : ''}`);
  }
  const reasons = agentGuardReasons(calls, AGENT_PROBE_TOOLS as any);
  if (reasons.length > 0) throw new Error(`no valid tool call: ${reasons.slice(0, 2).join('; ')}`);
}

/** True when the answer carries both tool results (17.3 °C, 14:52), however it is phrased. */
export function answerUsesProbeResults(text: string): boolean {
  return /\b17(?:[.,]3)?\b/.test(text) && /\b(?:14|2)[:.h]52\b/i.test(text);
}

/**
 * The probe task, with the transport injected: `send` posts the conversation so far and returns
 * the reply. Throws a model failure ("no valid tool call" / "agent probe failed") or the
 * transport's own error (a busy provider stays inconclusive).
 */
export async function runAgentProbe(send: (messages: any[]) => Promise<any>): Promise<void> {
  const messages: any[] = [...AGENT_PROBE_MESSAGES];
  const called = new Set<string>();
  for (let step = 0; step < AGENT_PROBE_MAX_REQUESTS; step++) {
    const reply = await send(messages);
    const msg = reply?.choices?.[0]?.message ?? {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length === 0) {
      if (called.size === 0) assertAgentProbeReply(reply); // throws: answered without a tool
      const text = String(msg.content ?? '');
      if (called.size < AGENT_PROBE_TOOLS.length) {
        throw new Error(`agent probe failed: answered after calling only ${[...called].join(', ')} (needed get_weather and get_time)`);
      }
      if (!answerUsesProbeResults(text)) {
        throw new Error(`agent probe failed: the answer ignores the tool results ("${text.trim().slice(0, 80)}")`);
      }
      return;
    }
    assertAgentProbeReply(reply);
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
    calls.forEach((c: any, i: number) => {
      const name = c.function?.name as string;
      called.add(name);
      messages.push({ role: 'tool', tool_call_id: c.id ?? `call_${step}_${i}`, content: JSON.stringify(AGENT_PROBE_RESULTS[name]) });
    });
  }
  throw new Error(`agent probe failed: kept calling tools after ${AGENT_PROBE_MAX_REQUESTS} requests without answering`);
}

async function agentProbeChat(candidate: ProbeCandidate): Promise<void> {
  await runAgentProbe(messages => probeRequest(candidate, messages, {
    tools: AGENT_PROBE_TOOLS,
    tool_choice: 'auto',
    max_tokens: 512,
  }));
}

// A busy provider is not a broken model: a 429/5xx or "high demand" answer to a probe says
// nothing about whether the model can drive an agent. Treat it as inconclusive (keep the last
// verdict) instead of excluding the model for an hour and shrinking the pool Hermes routes over.
const BUSY_PROBE_ERROR = /\b(429|5\d\d)\b|high demand|busy|overloaded|temporarily unavailable|capacity|rate.?limit|try again later/i;

export function isBusyProbeError(message: string | undefined): boolean {
  return !!message && BUSY_PROBE_ERROR.test(message) && !/no valid tool call|agent probe failed/i.test(message);
}

// ── Rounds ───────────────────────────────────────────────────────────────────

export interface CurationRound {
  at: string;
  results: Array<{ platform: string; modelId: string; reason: CurationReason; status: ProbeOutcome['status']; latencyMs?: number }>;
}

let running = false;
let lastRound: CurationRound | null = null;
let startedAt: number | null = null;

export async function runCurationRound(deps: ModelProbeRequestDeps = {}, now = Date.now()): Promise<CurationRound | null> {
  if (running) return null;
  running = true;
  try {
    const candidates = selectCurationCandidates(CURATION_MAX_PROBES, now);
    const results: CurationRound['results'] = [];
    for (const c of candidates) {
      countProbe(c.platform, now);
      let outcome = await probeModel(c, { chat: deps.chat ?? agentProbeChat });
      if (outcome.status === 'unavailable' && isBusyProbeError(outcome.error)) {
        outcome = { status: 'error', error: `inconclusive (provider busy): ${outcome.error}` };
      }
      recordProbeResult(getDb(), c, outcome);
      // Answered or truly down: either way the urgent question is settled.
      if (outcome.status !== 'error') urgentQueue.delete(c.modelDbId);
      results.push({ platform: c.platform, modelId: c.modelId, reason: c.reason, status: outcome.status, latencyMs: outcome.latencyMs });
    }
    resetCurationCache();
    lastRound = { at: new Date().toISOString(), results };
    if (results.length > 0) {
      console.log(`[Curation] round: ${results.map(r => `${r.platform}/${r.modelId}=${r.status}(${r.reason})`).join(', ')}; excluded now: ${curatedOutModels().size}`);
    }
    return lastRound;
  } finally {
    running = false;
  }
}

let urgentTimer: ReturnType<typeof setTimeout> | null = null;

/** Called on a real-traffic failure: probe that model within seconds instead of next round. */
export function noteLiveFailure(modelDbId: number): void {
  if (!cancel) return; // curation not running (tests, disabled)
  urgentQueue.add(modelDbId);
  if (urgentTimer) return;
  urgentTimer = setTimeout(() => {
    urgentTimer = null;
    runCurationRound().catch(err => console.error('[Curation] urgent round failed:', err));
  }, URGENT_DELAY_MS);
  urgentTimer.unref?.();
}

/** For the dashboard. */
export function curationStatus(now = Date.now()) {
  let next: number | null = null;
  if (startedAt !== null) {
    const elapsed = Math.max(0, now - startedAt);
    next = startedAt + (Math.floor(elapsed / CURATION_INTERVAL_MS) + 1) * CURATION_INTERVAL_MS;
  }
  return {
    lastRound,
    nextRoundAt: next ? new Date(next).toISOString() : null,
    urgentQueued: urgentQueue.size,
    probesToday: totalProbesToday(now),
  };
}

let cancel: (() => void) | null = null;
export function startCuration(scheduler: Scheduler): void {
  if (cancel) return;
  if (process.env.HERMESFLLM_CURATION_ENABLED === '0') return;
  const { applied } = applyDefaultPolicy();
  if (applied) console.log('[Curation] applied HermesFLLM routing defaults (custom: reliability 0.55, intelligence 0.3, speed 0.15; min reliability 0.9)');
  console.log(`[Curation] continuous: every ${CURATION_INTERVAL_MS / 60_000}m up to ${CURATION_MAX_PROBES} probes, verdicts last ${CURATION_VERDICT_TTL_MS / 60_000}m, cap ${CURATION_DAILY_CAP_PER_PLATFORM}/platform/day`);
  startedAt = Date.now();
  const round = async (): Promise<void> => {
    await runCurationRound().catch(err => console.error('[Curation] round failed:', err));
  };
  cancel = scheduler.every(CURATION_INTERVAL_MS, round, { name: 'hermesfllm-curation' });
  scheduler.after(60 * 1000, round);
}

export function stopCuration(): void {
  cancel?.();
  cancel = null;
  if (urgentTimer) clearTimeout(urgentTimer);
  urgentTimer = null;
}

/**
 * Test seam: forget curation state between tests. `{ restartOnly: true }` keeps what is persisted
 * (the daily probe counts), which is what a process restart does.
 */
export function resetCurationState(opts: { restartOnly?: boolean } = {}): void {
  urgentQueue.clear();
  dailyProbes.clear();
  probeCountsLoaded = false;
  if (!opts.restartOnly) {
    try { setSetting(PROBE_COUNTS_KEY, ''); } catch { /* DB not ready */ }
  }
  lastRound = null;
  startedAt = null;
  resetCurationCache();
}

/** Test seam: mark curation as running without a scheduler. */
export function markCurationRunningForTest(on: boolean): void {
  cancel = on ? () => {} : null;
}
