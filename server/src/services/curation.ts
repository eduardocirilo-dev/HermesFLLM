// HermesFLLM curation: keep routing on the most reliable, most capable free models.
//
// 1. Default policy (applied once, only where the operator has not chosen): 'custom' strategy
//    weighted towards reliability and intelligence, plus a minimum reliability floor.
// 2. Every HERMESFLLM_CURATION_INTERVAL_MS (3h) a curation pass sends real probe requests to the
//    stalest model+key pairs (model-probe), so dead models are found before a user turn hits them.
// 3. routeRequest skips a model whose recent probes all came back 'unavailable' and none
//    'working' (isCuratedOut). The verdict expires with the probe window, so a recovered model
//    returns on the next pass.
import { getDb, getSetting, setSetting } from '../db/index.js';
import type { Scheduler } from '../lib/scheduler.js';
import { runModelProbePass } from './model-probe.js';

export const CURATION_INTERVAL_MS = positiveInt(process.env.HERMESFLLM_CURATION_INTERVAL_MS, 3 * 60 * 60 * 1000);
export const CURATION_MAX_PROBES = positiveInt(process.env.HERMESFLLM_CURATION_MAX_PROBES, 20);
// A verdict older than two passes is too old to exclude a model on.
export const CURATION_VERDICT_TTL_MS = CURATION_INTERVAL_MS * 2;

export const DEFAULT_WEIGHTS = { reliability: 0.6, speed: 0.05, intelligence: 0.35 };
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

const modelKey = (platform: string, modelId: string, scope: string | null | undefined) => `${platform}\u0000${modelId}\u0000${scope ?? ''}`;

let cache: { at: number; out: Set<string> } | null = null;
const CACHE_MS = 60 * 1000;

/** Models whose fresh probes are all 'unavailable' (none 'working'). */
export function curatedOutModels(now = Date.now()): Set<string> {
  if (cache && now - cache.at < CACHE_MS) return cache.out;
  const since = new Date(now - CURATION_VERDICT_TTL_MS).toISOString();
  const rows = getDb().prepare(`
    SELECT platform, model_id, endpoint_scope
      FROM model_probe_status
     WHERE last_probed_at >= ?
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
}

let running = false;
let lastPass: { at: string; probed: number } | null = null;
let startedAt: number | null = null;

/** For the dashboard: when the last pass ran and when the next one is due. */
export function curationSchedule(now = Date.now()): { lastPassAt: string | null; lastProbed: number | null; nextPassAt: string | null } {
  let next: number | null = null;
  if (startedAt !== null) {
    const elapsed = Math.max(0, now - startedAt);
    next = startedAt + (Math.floor(elapsed / CURATION_INTERVAL_MS) + 1) * CURATION_INTERVAL_MS;
  }
  return { lastPassAt: lastPass?.at ?? null, lastProbed: lastPass?.probed ?? null, nextPassAt: next ? new Date(next).toISOString() : null };
}

export async function runCurationPass(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await runModelProbePass({ maxProbes: CURATION_MAX_PROBES });
    lastPass = { at: new Date().toISOString(), probed: Array.isArray((result as any)?.probed) ? (result as any).probed.length : 0 };
    resetCurationCache();
    console.log(`[Curation] pass done: ${JSON.stringify(result)}; curated out: ${curatedOutModels().size} model(s)`);
  } finally {
    running = false;
  }
}

let cancel: (() => void) | null = null;
export function startCuration(scheduler: Scheduler): void {
  if (cancel) return;
  if (process.env.HERMESFLLM_CURATION_ENABLED === '0') return;
  const { applied } = applyDefaultPolicy();
  if (applied) console.log('[Curation] applied HermesFLLM routing defaults (custom: reliability 0.6, intelligence 0.35, speed 0.05; min reliability 0.9)');
  console.log(`[Curation] re-evaluating models every ${CURATION_INTERVAL_MS / 3_600_000}h (max ${CURATION_MAX_PROBES} probes/pass)`);
  // First pass shortly after boot so a fresh install learns quickly, then on the interval.
  scheduler.after(2 * 60 * 1000, () => runCurationPass().catch(err => console.error('[Curation] pass failed:', err)));
  startedAt = Date.now();
  cancel = scheduler.every(CURATION_INTERVAL_MS, () => runCurationPass().catch(err => console.error('[Curation] pass failed:', err)), { name: 'hermesfllm-curation' });
}

export function stopCuration(): void {
  cancel?.();
  cancel = null;
}
