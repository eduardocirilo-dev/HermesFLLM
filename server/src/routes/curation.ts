import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { getCustomWeights, getMinReliabilityFloor, getRoutingStrategy } from '../services/router.js';
import { CURATION_DAILY_CAP_PER_PLATFORM, CURATION_INTERVAL_MS, CURATION_MAX_PROBES, CURATION_VERDICT_TTL_MS, MAX_LATENCY_MS, curationStatus, reserveModelIds, slowModelIds } from '../services/curation.js';
import { isAgentGuardEnabled } from '../lib/tool-validate.js';
import { isRaceEnabled, raceDelayBounds, raceStats } from '../lib/hermes-race.js';
import { governorConfig } from '../lib/hermes-governor.js';
import { shadowStats } from '../lib/hermes-shadow.js';
import { DEFAULT_DEMOTION_FACTOR, getDemotions, setDemotion } from '../lib/hermes-demotions.js';
import { qualityByModel } from '../lib/hermes-feedback.js';

// HermesFLLM model health board: what the router prefers right now, what curation
// excluded and why, and how many broken agent turns the Agent Guard caught.
export const curationRouter = Router();

// Models need some traffic before their success rate means anything.
const MIN_REQUESTS = 5;

/** The warm reserve with each model's freshest probe verdict. */
function reserve() {
  const ids = reserveModelIds();
  if (ids.length === 0) return [];
  const db = getDb();
  return ids.map(id => {
    const m = db.prepare('SELECT platform, model_id, display_name, endpoint_scope FROM models WHERE id = ?').get(id) as { platform: string; model_id: string; display_name: string | null; endpoint_scope: string | null } | undefined;
    if (!m) return null;
    const p = db.prepare(`SELECT status, last_probed_at FROM model_probe_status
                           WHERE platform = ? AND model_id = ? AND endpoint_scope = ?
                           ORDER BY julianday(last_probed_at) DESC LIMIT 1`).get(m.platform, m.model_id, m.endpoint_scope ?? '') as { status: string; last_probed_at: string } | undefined;
    return { platform: m.platform, modelId: m.model_id, name: m.display_name ?? m.model_id, lastStatus: p?.status ?? null, lastProbedAt: p?.last_probed_at ?? null };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
}

export function buildHealthBoard(now = Date.now()) {
  const db = getDb();
  const since = new Date(now - CURATION_VERDICT_TTL_MS).toISOString();

  const probes = db.prepare(`
    SELECT p.platform, p.model_id, p.status, p.last_probed_at, p.latency_ms, p.last_error,
           m.display_name, m.intelligence_rank
      FROM model_probe_status p
      LEFT JOIN models m ON m.platform = p.platform AND m.model_id = p.model_id AND COALESCE(m.endpoint_scope, '') = COALESCE(p.endpoint_scope, '')
     -- julianday(): last_probed_at mixes ISO and SQLite datetime formats (see services/curation.ts).
     WHERE julianday(p.last_probed_at) >= julianday(?)
     ORDER BY julianday(p.last_probed_at) DESC
  `).all(since) as Array<{ platform: string; model_id: string; status: string; last_probed_at: string; latency_ms: number | null; last_error: string | null; display_name: string | null; intelligence_rank: number | null }>;

  // A model is excluded when every fresh probe failed (same rule as services/curation.ts).
  const byModel = new Map<string, { platform: string; modelId: string; name: string; working: number; unavailable: number; lastError: string | null; lastProbedAt: string }>();
  for (const p of probes) {
    const key = `${p.platform}\u0000${p.model_id}`;
    const row = byModel.get(key) ?? { platform: p.platform, modelId: p.model_id, name: p.display_name ?? p.model_id, working: 0, unavailable: 0, lastError: null, lastProbedAt: p.last_probed_at };
    if (p.status === 'working') row.working++;
    if (p.status === 'unavailable') { row.unavailable++; row.lastError ??= p.last_error; }
    byModel.set(key, row);
  }
  const excluded = [...byModel.values()].filter(m => m.unavailable > 0 && m.working === 0);

  const top = db.prepare(`
    SELECT r.platform, r.model_id, COALESCE(m.display_name, r.model_id) AS name, m.intelligence_rank,
           MAX(r.model_db_id) AS model_db_id,
           COUNT(*) AS requests,
           SUM(r.status = 'success') AS successes,
           CAST(AVG(CASE WHEN r.status = 'success' THEN r.latency_ms END) AS INTEGER) AS avg_latency_ms
      FROM requests r
      LEFT JOIN models m ON m.id = r.model_db_id
     WHERE r.created_at >= datetime('now', '-1 day') AND r.status IN ('success', 'error')
     GROUP BY r.platform, r.model_id
    HAVING COUNT(*) >= ?
     ORDER BY (1.0 * SUM(r.status = 'success') / COUNT(*)) DESC, COUNT(*) DESC
     LIMIT 12
  `).all(MIN_REQUESTS) as Array<{ platform: string; model_id: string; name: string; intelligence_rank: number | null; model_db_id: number | null; requests: number; successes: number; avg_latency_ms: number | null }>;
  // The same verdict routing uses (6h window): a slow model ranks here by success, but the router
  // sends it to the back of the chain, and the board must say so.
  const slow = slowModelIds();

  const guard = db.prepare(`
    SELECT SUM(created_at >= datetime('now', '-1 day')) AS day,
           SUM(created_at >= datetime('now', '-7 day')) AS week
      FROM requests
     WHERE error LIKE '%agent guard:%' AND created_at >= datetime('now', '-7 day')
  `).get() as { day: number | null; week: number | null };

  // Every attempt a HermesFLLM protection took away from the agent: failed over before anything
  // reached it, or (Turn Governor after the commit) ended cleanly instead of freezing.
  const rescueRows = db.prepare(`
    SELECT SUM(error LIKE '%agent guard:%') AS guard,
           SUM(error LIKE '%agent deadline:%') AS deadline,
           SUM(error LIKE '%agent governor:%stopped making progress%') AS stall,
           SUM(error LIKE '%agent governor:%is looping%') AS runaway,
           SUM(error LIKE '%agent governor:%exceeded the turn ceiling%') AS ceiling,
           SUM(created_at < datetime('now', '-1 day')) AS older
      FROM requests
     WHERE status = 'error' AND created_at >= datetime('now', '-7 day')
       AND (error LIKE '%agent guard:%' OR error LIKE '%agent deadline:%' OR error LIKE '%agent governor:%')
  `).get() as Record<'guard' | 'deadline' | 'stall' | 'runaway' | 'ceiling' | 'older', number | null>;
  const rescues24h = db.prepare(`
    SELECT SUM(error LIKE '%agent guard:%') AS guard,
           SUM(error LIKE '%agent deadline:%') AS deadline,
           SUM(error LIKE '%agent governor:%stopped making progress%') AS stall,
           SUM(error LIKE '%agent governor:%is looping%') AS runaway,
           SUM(error LIKE '%agent governor:%exceeded the turn ceiling%') AS ceiling
      FROM requests
     WHERE status = 'error' AND created_at >= datetime('now', '-1 day')
  `).get() as Record<'guard' | 'deadline' | 'stall' | 'runaway' | 'ceiling', number | null>;
  const last24h = {
    guard: rescues24h.guard ?? 0,
    deadline: rescues24h.deadline ?? 0,
    stall: rescues24h.stall ?? 0,
    runaway: rescues24h.runaway ?? 0,
    ceiling: rescues24h.ceiling ?? 0,
  };
  const total24h = Object.values(last24h).reduce((a, b) => a + b, 0);
  const total7d = total24h + (rescueRows.older ?? 0);

  const traffic = db.prepare(`
    SELECT COUNT(*) AS total, SUM(status = 'success') AS ok
      FROM requests WHERE created_at >= datetime('now', '-1 day') AND status IN ('success', 'error')
  `).get() as { total: number; ok: number | null };

  return {
    policy: {
      strategy: getRoutingStrategy(),
      weights: getCustomWeights(),
      minReliability: getMinReliabilityFloor() ?? null,
    },
    curation: {
      intervalMinutes: CURATION_INTERVAL_MS / 60_000,
      maxProbesPerRound: CURATION_MAX_PROBES,
      verdictTtlMinutes: CURATION_VERDICT_TTL_MS / 60_000,
      dailyCapPerPlatform: CURATION_DAILY_CAP_PER_PLATFORM,
      ...curationStatus(now),
      reserve: reserve(),
      probedModels: byModel.size,
      working: [...byModel.values()].filter(m => m.working > 0).length,
      excluded: excluded.map(m => ({ platform: m.platform, modelId: m.modelId, name: m.name, reason: m.lastError, lastProbedAt: m.lastProbedAt })),
    },
    agentGuard: {
      enabled: isAgentGuardEnabled(),
      savedLast24h: guard.day ?? 0,
      savedLast7d: guard.week ?? 0,
    },
    rescues: {
      governorEnabled: governorConfig() !== null,
      last24h,
      total24h,
      total7d,
    },
    race: (() => {
      const { min, max } = raceDelayBounds();
      return { enabled: isRaceEnabled(), ...raceStats(), minDelayMs: min, maxDelayMs: max };
    })(),
    shadow: shadowStats(),
    traffic: {
      requests24h: traffic.total,
      successRate24h: traffic.total > 0 ? (traffic.ok ?? 0) / traffic.total : null,
    },
    topModels: top.map(t => ({
      platform: t.platform,
      modelId: t.model_id,
      name: t.name,
      intelligenceRank: t.intelligence_rank,
      requests: t.requests,
      successRate: t.successes / t.requests,
      avgLatencyMs: t.avg_latency_ms,
      slow: (t.model_db_id != null && slow.has(t.model_db_id)) || (t.avg_latency_ms ?? 0) > MAX_LATENCY_MS,
    })),
  };
}

curationRouter.get('/', (_req: Request, res: Response) => {
  res.json(buildHealthBoard());
});

// ── Model forensics: where the agent's time goes ─────────────────────────────
// The health board counts rescues; it did not say WHICH model costs the agent time, so diagnosing
// meant SQL against the database. This ranks models by time lost on failed attempts in 24h (every
// failed attempt is time the agent waited for nothing before failover), split by cause, and
// carries the runtime demotion each model has so the board can act on it in one click.

export interface ModelForensics {
  platform: string;
  modelId: string;
  name: string;
  requests: number;
  successes: number;
  failed: number;
  wastedMs: number;
  avgFirstMs: number | null;
  causes: { stall: number; runaway: number; guard: number; deadline: number; rateLimit: number; other: number };
  demotion: number | null;
}

export function buildForensics(limit = 15): { totalWastedMs: number; totalFailed: number; models: ModelForensics[] } {
  const rows = getDb().prepare(`
    SELECT r.platform, r.model_id, COALESCE(MAX(m.display_name), r.model_id) AS name,
           COUNT(*) AS requests,
           SUM(r.status = 'success') AS ok,
           SUM(r.status = 'error') AS failed,
           SUM(CASE WHEN r.status = 'error' THEN MAX(r.latency_ms, 0) ELSE 0 END) AS wasted_ms,
           CAST(AVG(CASE WHEN r.status = 'success' THEN COALESCE(r.ttfb_ms, r.latency_ms) END) AS INTEGER) AS avg_first_ms,
           SUM(r.error LIKE '%agent governor:%stopped making progress%') AS stall,
           SUM(r.error LIKE '%agent governor:%is looping%' OR r.error LIKE '%agent governor:%exceeded the turn ceiling%') AS runaway,
           SUM(r.error LIKE '%agent guard:%') AS guard,
           SUM(r.error LIKE '%agent deadline:%') AS deadline,
           SUM(r.status = 'error' AND r.error NOT LIKE '%agent %' AND (r.error LIKE '%429%' OR LOWER(r.error) LIKE '%rate limit%' OR LOWER(r.error) LIKE '%rate_limit%')) AS rate_limit
      FROM requests r
      LEFT JOIN models m ON m.id = r.model_db_id
     WHERE r.created_at >= datetime('now', '-1 day') AND r.status IN ('success', 'error')
     GROUP BY r.platform, r.model_id
  `).all() as Array<{ platform: string; model_id: string; name: string; requests: number; ok: number; failed: number; wasted_ms: number; avg_first_ms: number | null; stall: number; runaway: number; guard: number; deadline: number; rate_limit: number }>;

  const demotions = getDemotions();
  const models = rows
    .filter(r => r.failed > 0)
    .map((r): ModelForensics => {
      const named = r.stall + r.runaway + r.guard + r.deadline + r.rate_limit;
      return {
        platform: r.platform,
        modelId: r.model_id,
        name: r.name,
        requests: r.requests,
        successes: r.ok,
        failed: r.failed,
        wastedMs: r.wasted_ms,
        avgFirstMs: r.avg_first_ms,
        causes: { stall: r.stall, runaway: r.runaway, guard: r.guard, deadline: r.deadline, rateLimit: r.rate_limit, other: Math.max(0, r.failed - named) },
        demotion: demotions.get(r.model_id) ?? null,
      };
    })
    .sort((a, b) => b.wastedMs - a.wastedMs || b.failed - a.failed);

  return {
    totalWastedMs: models.reduce((sum, m) => sum + m.wastedMs, 0),
    totalFailed: models.reduce((sum, m) => sum + m.failed, 0),
    models: models.slice(0, limit),
  };
}

curationRouter.get('/forensics', (_req: Request, res: Response) => {
  res.json({ ...buildForensics(), demotions: Object.fromEntries(getDemotions()) });
});

/** Body: { modelId, demote: true } applies the default demotion, { modelId, demote: false } restores. */
curationRouter.put('/demotions', (req: Request, res: Response) => {
  const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
  const demote = req.body?.demote;
  if (!modelId || modelId.length > 300 || typeof demote !== 'boolean') {
    res.status(400).json({ error: { message: 'expected { modelId: string, demote: boolean }' } });
    return;
  }
  const next = setDemotion(modelId, demote ? DEFAULT_DEMOTION_FACTOR : null);
  console.log(`[Demotions] ${modelId} ${demote ? `demoted to x${DEFAULT_DEMOTION_FACTOR}` : 'restored'} from the dashboard`);
  res.json({ demotions: Object.fromEntries(next) });
});

// What the agent did with each model's answers, as reported by the Hermes plugin (7 days).
curationRouter.get('/quality', (_req: Request, res: Response) => {
  res.json(qualityByModel(7));
});
