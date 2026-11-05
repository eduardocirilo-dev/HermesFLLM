// HermesFLLM context fit: compact a long agent session only when its size is what keeps the best
// models out.
//
// Agent sessions grow: every tool result stays in the transcript, so a few dozen turns reach tens
// of thousands of tokens. Every model whose context window (with the router's safety margin) or
// free-tier tokens-per-minute cap is smaller than the prompt silently drops out of routing, and it
// drops out exactly on the long, hard turns where the best models matter most.
//
// FreeLLMAPI's compression pipeline can shrink a transcript, but it is either always on (and so
// rewrites short sessions that never needed it) or size-triggered into its lossy 'aggressive' mode
// (relevance filtering, aging, hard budget). Context fit runs only when the prompt does not fit the
// top-ranked candidates, aims at exactly the size the best excluded model accepts, and only uses
// the 'standard' engines: duplicate blocks, superseded file reads, oversized tool output and JSON
// tables. Nothing the agent said or decided is condensed. Every engine still passes the pipeline's
// fidelity gate, and if the result does not get smaller the original messages are kept.
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getDb } from '../db/index.js';
import { estimateInputTokens } from './content.js';
import { CONTEXT_WINDOW_SAFETY_FACTOR, fitsContextWindow, getRoutingScores, hasUsableKeyForModel } from '../services/router.js';
import { compressRequest } from '../services/compression/pipeline.js';

/** How many of the top-ranked candidates the prompt must fit; below that, compact. */
export const TOP_CANDIDATES = 5;
/** Aim a little under the target model's capacity, since the token count is an estimate. */
const TARGET_HEADROOM = 0.9;
/** Below this, compaction cannot be worth a rewrite. */
const MIN_TOKENS = 8_000;

export function isContextFitEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HERMESFLLM_CONTEXT_FIT?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

interface Candidate {
  modelDbId: number;
  platform: string;
  modelId: string;
  contextWindow: number | null;
  tpmLimit: number | null;
  supportsTools: boolean;
}

/**
 * The largest prompt (estimated input tokens) this model accepts, or null when it has no known
 * limit. Mirrors the router, which compares input + output reserve against both limits and scales
 * only the input part by the context-window safety margin.
 */
export function promptCapacity(c: Pick<Candidate, 'contextWindow' | 'tpmLimit'>, outputReserve: number): number | null {
  const reserve = Math.max(0, outputReserve);
  const caps: number[] = [];
  if (c.contextWindow != null) caps.push(Math.floor((c.contextWindow - reserve) / CONTEXT_WINDOW_SAFETY_FACTOR));
  if (c.tpmLimit != null) caps.push(c.tpmLimit - reserve);
  return caps.length > 0 ? Math.min(...caps) : null;
}

/** Same test the router applies, with `tokens` the estimated input. */
function fits(c: Candidate, tokens: number, outputReserve: number): boolean {
  const total = tokens + Math.max(0, outputReserve);
  if (!fitsContextWindow(c.platform, c.contextWindow, total, outputReserve)) return false;
  return c.tpmLimit == null || total <= c.tpmLimit;
}

/**
 * Chain models that could serve right now (enabled, with a usable key out of cooldown), best routing
 * score first; tool-capable only when the turn has tools.
 */
export function rankedCandidates(wantsTools: boolean): Candidate[] {
  const ranked = getRoutingScores().scores.filter(s => s.enabled).sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return [];
  const rows = getDb().prepare(`
    SELECT id, context_window, tpm_limit, supports_tools FROM models WHERE id IN (${ranked.map(() => '?').join(',')})
  `).all(...ranked.map(s => s.modelDbId)) as Array<{ id: number; context_window: number | null; tpm_limit: number | null; supports_tools: number }>;
  const byId = new Map(rows.map(r => [r.id, r]));
  const out: Candidate[] = [];
  for (const s of ranked) {
    const row = byId.get(s.modelDbId);
    if (!row) continue;
    const c = { modelDbId: s.modelDbId, platform: s.platform, modelId: s.modelId, contextWindow: row.context_window, tpmLimit: row.tpm_limit, supportsTools: row.supports_tools === 1 };
    if (wantsTools && !c.supportsTools) continue;
    if (!hasUsableKeyForModel(c.modelDbId)) continue;
    out.push(c);
  }
  return out;
}

export interface ContextFitPlan {
  /** Estimated prompt tokens to aim for, or null when the prompt already fits the top candidates. */
  targetTokens: number | null;
  /** The top-ranked model the prompt does not fit, which the target is sized for. */
  forModel: string | null;
  eligibleBefore: number;
  candidates: number;
}

/** Decide whether and how far to compact, from the ranked candidates' limits. Pure. */
export function planContextFit(candidates: Candidate[], tokens: number, outputReserve: number, topN = TOP_CANDIDATES): ContextFitPlan {
  const eligibleBefore = candidates.filter(c => fits(c, tokens, outputReserve)).length;
  const base = { eligibleBefore, candidates: candidates.length };
  if (tokens < MIN_TOKENS) return { ...base, targetTokens: null, forModel: null };
  const top = candidates.slice(0, topN);
  // The best-ranked model the prompt is too big for, among those a smaller prompt can reach (a
  // model under the operator's context floor, or whose reserve alone overflows it, never can).
  for (const c of top) {
    if (fits(c, tokens, outputReserve)) continue;
    const capacity = promptCapacity(c, outputReserve);
    if (capacity == null || capacity < 1) continue;
    const target = Math.max(1, Math.floor(capacity * TARGET_HEADROOM));
    if (!fits(c, target, outputReserve)) continue;
    return { ...base, targetTokens: target, forModel: `${c.platform}/${c.modelId}` };
  }
  return { ...base, targetTokens: null, forModel: null };
}

export interface ContextFitResult {
  messages: ChatMessage[];
  applied: boolean;
  tokensBefore: number;
  tokensAfter: number;
  eligibleBefore: number;
  eligibleAfter: number;
  forModel: string | null;
}

// ── Stats for the health board ────────────────────────────────────────────────

let stats = freshStats();
function freshStats() {
  return { turns: 0, compacted: 0, tokensSaved: 0, modelsRegained: 0, since: new Date().toISOString() };
}
export function contextFitStats() {
  return { enabled: isContextFitEnabled(), ...stats };
}
export function resetContextFitStats(): void {
  stats = freshStats();
}

/**
 * Compact `messages` when their size keeps top-ranked models out. Returns the original messages
 * (applied: false) whenever compaction is off, not needed, or does not help.
 */
export function fitContext(messages: ChatMessage[], opts: { tools?: unknown[]; outputReserve: number; cacheControlPrefixLength?: number }): ContextFitResult {
  const tokensBefore = estimateInputTokens(messages, opts.tools);
  const unchanged = (eligible = 0): ContextFitResult => ({
    messages, applied: false, tokensBefore, tokensAfter: tokensBefore, eligibleBefore: eligible, eligibleAfter: eligible, forModel: null,
  });
  // Cheap checks first: the candidate ranking scores the whole catalogue.
  if (!isContextFitEnabled() || tokensBefore < MIN_TOKENS) return unchanged();
  const wantsTools = (opts.tools?.length ?? 0) > 0;
  let candidates: Candidate[];
  try {
    candidates = rankedCandidates(wantsTools);
  } catch {
    return unchanged(); // never let the scoring query break a request
  }
  stats.turns++;
  const plan = planContextFit(candidates, tokensBefore, opts.outputReserve);
  if (plan.targetTokens == null) return unchanged(plan.eligibleBefore);

  // The pipeline's target covers the messages only; tool schemas are sent as they are.
  const toolTokens = estimateInputTokens([], opts.tools);
  const result = compressRequest(messages, {
    previewMode: 'standard',
    targetTokens: Math.max(1, plan.targetTokens - toolTokens),
    tools: opts.tools as never,
    cacheControlPrefixLength: opts.cacheControlPrefixLength,
    recordStats: false,
  });
  const tokensAfter = estimateInputTokens(result.messages, opts.tools);
  if (tokensAfter >= tokensBefore) return unchanged(plan.eligibleBefore);

  const eligibleAfter = candidates.filter(c => fits(c, tokensAfter, opts.outputReserve)).length;
  stats.compacted++;
  stats.tokensSaved += tokensBefore - tokensAfter;
  stats.modelsRegained += Math.max(0, eligibleAfter - plan.eligibleBefore);
  return { messages: result.messages, applied: true, tokensBefore, tokensAfter, eligibleBefore: plan.eligibleBefore, eligibleAfter, forModel: plan.forModel };
}
