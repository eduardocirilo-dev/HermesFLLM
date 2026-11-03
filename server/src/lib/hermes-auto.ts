// `autoTOP-hermes`: the HermesFLLM name for "let the router pick". It routes exactly like
// `auto` (reliability/intelligence policy, curation, Agent Guard) and is listed first in
// /v1/models so agent UIs show a HermesFLLM model instead of a bare `auto`.
export const HERMES_AUTO_MODEL_ID = 'autoTOP-hermes';
export const HERMES_AUTO_MODEL_NAME = 'HermesFLLM';

export function isHermesAutoModel(modelId: string | undefined | null): boolean {
  return !!modelId && modelId.trim().toLowerCase() === HERMES_AUTO_MODEL_ID.toLowerCase();
}

// Agent deadline: an attempt that has not committed any output within this many ms is cancelled
// and the turn fails over to the next model, invisibly. Covers attempt 0 too, which the upstream
// time-budget hedge deliberately exempts. 0 disables. Env HERMESFLLM_ATTEMPT_DEADLINE_MS.
export const DEFAULT_ATTEMPT_DEADLINE_MS = 30_000;

export function attemptDeadlineMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HERMESFLLM_ATTEMPT_DEADLINE_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ATTEMPT_DEADLINE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_ATTEMPT_DEADLINE_MS;
}

/**
 * Retryable (its message carries "timeout"), so the loop fails over and penalises the model.
 * `skipModelForRequest`: a slow model says nothing about its provider's other models, so only
 * this model is ruled out for the request (without it, "timeout" would skip the whole platform).
 */
export function agentDeadlineError(displayName: string, ms: number): Error {
  return Object.assign(
    new Error(`agent deadline: ${displayName} sent no output within ${(ms / 1000).toFixed(1)}s (timeout), failing over`),
    { agentDeadline: true, skipModelForRequest: true },
  );
}
