import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { getCustomWeights, getMinReliabilityFloor, getRoutingStrategy } from '../services/router.js';
import { CURATION_DAILY_CAP_PER_PLATFORM, CURATION_INTERVAL_MS, CURATION_MAX_PROBES, CURATION_VERDICT_TTL_MS, curationStatus, reserveModelIds } from '../services/curation.js';
import { isAgentGuardEnabled } from '../lib/tool-validate.js';
import { isRaceEnabled, raceDelayBounds, raceStats } from '../lib/hermes-race.js';
import { governorConfig } from '../lib/hermes-governor.js';
import { shadowStats } from '../lib/hermes-shadow.js';

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
  `).all(MIN_REQUESTS) as Array<{ platform: string; model_id: string; name: string; intelligence_rank: number | null; requests: number; successes: number; avg_latency_ms: number | null }>;

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
    })),
  };
}

curationRouter.get('/', (_req: Request, res: Response) => {
  res.json(buildHealthBoard());
});
