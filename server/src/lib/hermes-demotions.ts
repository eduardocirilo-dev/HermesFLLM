// HermesFLLM runtime model demotions: the dashboard's "lower priority" button.
//
// MODEL_ROUTING_OVERRIDES does the same job but lives in .env, so acting on what the health board
// shows meant editing a file and restarting the service. Demotions are kept in one settings row,
// apply on the next request, and multiply the routing score exactly like an env override (by model
// id, across every platform serving it). They never disable a model: a demoted model still serves
// when nothing better can, and a Manual priority chain ignores scores altogether.
import { getSetting, setSetting } from '../db/index.js';

export const DEMOTIONS_SETTING = 'hermesfllm_model_demotions';
/** What the dashboard button applies: well behind healthy models, still reachable. */
export const DEFAULT_DEMOTION_FACTOR = 0.4;

let cache: Map<string, number> | null = null;

function load(): Map<string, number> {
  if (cache) return cache;
  const out = new Map<string, number>();
  try {
    const raw = getSetting(DEMOTIONS_SETTING);
    if (raw) {
      for (const [modelId, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1) out.set(modelId, value);
      }
    }
  } catch {
    // A corrupt row only loses the demotions; routing must never fail on it.
  }
  cache = out;
  return out;
}

export function getDemotions(): Map<string, number> {
  return new Map(load());
}

/** Score multiplier for a model id: 1 when not demoted. */
export function demotionFactor(modelId: string): number {
  return load().get(modelId) ?? 1;
}

/** Demote a model (factor in [0, 1)) or restore it (null). Returns the new map. */
export function setDemotion(modelId: string, factor: number | null): Map<string, number> {
  const next = new Map(load());
  if (factor === null) next.delete(modelId);
  else next.set(modelId, factor);
  setSetting(DEMOTIONS_SETTING, JSON.stringify(Object.fromEntries(next)));
  cache = next;
  return new Map(next);
}

/** Test seam. */
export function resetDemotionCache(): void {
  cache = null;
}
