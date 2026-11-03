// `autoTOP-hermes`: the HermesFLLM name for "let the router pick". It routes exactly like
// `auto` (reliability/intelligence policy, curation, Agent Guard) and is listed first in
// /v1/models so agent UIs show a HermesFLLM model instead of a bare `auto`.
export const HERMES_AUTO_MODEL_ID = 'autoTOP-hermes';
export const HERMES_AUTO_MODEL_NAME = 'HermesFLLM';

export function isHermesAutoModel(modelId: string | undefined | null): boolean {
  return !!modelId && modelId.trim().toLowerCase() === HERMES_AUTO_MODEL_ID.toLowerCase();
}
