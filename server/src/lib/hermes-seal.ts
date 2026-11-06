// HermesFLLM sealed turns: the agent never receives half a turn.
//
// A tool-bearing stream used to commit at the model's first word: as soon as the text could no
// longer be an inline tool-call marker ("I'll check the file…"), the SSE headers went out and the
// prose streamed live. From that moment every protection that relies on "nothing has been sent
// yet" was gone for any model that talks before it acts:
// - a stall became the Turn Governor's committed regime (90s instead of 30s) and ended in a
//   visible stream_error, and the failure was not booked, so the agent's retry went straight back
//   to the model that had just stalled;
// - an Agent Guard rejection after prose was spliced out and the turn ended with finish_reason
//   'stop', so the agent read "I'll list the files now." as its final answer;
// - an inline <tool_call> written after prose leaked out as text.
//
// The seal holds the prose of an agent turn (and, for Hermes, its reasoning) until the turn's
// shape is known. A turn that ends with tool calls, or a short answer, is delivered whole, after
// the same end-of-stream checks a silent tool-call turn already gets: dialect rescue, Agent Guard,
// empty-completion detection. Anything that fails inside the seal fails over invisibly. Two
// releases keep long answers live:
// - 'answer': releaseChars of text and no tool call yet. This is a final answer being written.
//   It streams from then on.
// - 'valve': the turn is still producing after maxMs. It is released so the 5-minute uncommitted
//   ceiling never cuts a healthy turn. A stalled turn produces nothing, so it is never released;
//   the governor's 30s pre-commit rule fails it over.
// After a release the turn behaves as before, with two fixes: a broken tool call ends the stream
// with a retryable error instead of a silent 'stop', and a failure after the commit is booked
// (cooldown, failure window, urgent probe), so the agent's retry goes to another model.
//
// Scope: streamed, auto-routed chat/completions requests with tools from Hermes (model
// autoTOP-hermes or a hermes-agent client), without response_format (JSON mode already holds
// everything) and without #1642 keep-alive pings (they commit the response). Other clients keep
// the upstream behaviour. HERMESFLLM_SEAL=0 turns it off.
import { isHermesAutoModel } from './hermes-auto.js';

export interface SealConfig {
  /** Characters of text without a tool call after which the turn is a final answer and streams. */
  releaseChars: number;
  /** A turn still producing after this long is released (the valve). */
  maxMs: number;
}

function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** null when HERMESFLLM_SEAL is 0, false or off. */
export function sealConfig(env: Record<string, string | undefined> = process.env): SealConfig | null {
  const raw = env.HERMESFLLM_SEAL?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return null;
  return {
    releaseChars: envInt(env.HERMESFLLM_SEAL_RELEASE_CHARS, 800, 200, 20_000),
    maxMs: envInt(env.HERMESFLLM_SEAL_MAX_MS, 60_000, 15_000, 240_000),
  };
}

/** Hermes traffic: the autoTOP-hermes model id, or a client the classifier names hermes-agent. */
export function isHermesTraffic(requestedModel: string | undefined, clientAgent: string | null | undefined): boolean {
  return isHermesAutoModel(requestedModel) || clientAgent === 'hermes-agent';
}

export type SealVerdict = 'hold' | 'answer' | 'valve';

/**
 * Decide, as a chunk arrives, whether a sealed turn keeps holding. Only called when the turn just
 * produced something, so "still producing" is implied: a stalled turn never reaches this.
 */
export function sealVerdict(
  s: { heldChars: number; toolCallStarted: boolean; elapsedMs: number },
  cfg: SealConfig,
): SealVerdict {
  if (s.elapsedMs >= cfg.maxMs) return 'valve';
  if (!s.toolCallStarted && s.heldChars >= cfg.releaseChars) return 'answer';
  return 'hold';
}

export const SEAL_RESCUE_KINDS = ['stall', 'loop', 'guard', 'inline', 'cut', 'other'] as const;
export type SealRescueKind = typeof SEAL_RESCUE_KINDS[number];

/** The kind of a sealed failure from its (stored) error text. */
export function sealRescueKindFromText(text: string | null | undefined): SealRescueKind {
  const msg = String(text ?? '').toLowerCase();
  if (msg.includes('agent governor:')) return msg.includes('stopped making progress') ? 'stall' : 'loop';
  if (msg.includes('agent guard:') || msg.startsWith('invalid tool arguments')) return 'guard';
  if (msg.includes('inline tool-call dialect')) return 'inline';
  if (msg.includes('in-band provider error') || msg.includes('stream ended unexpectedly')
    || msg.includes('no [done], no finish_reason') || msg.startsWith('terminated') || msg.includes('stream interrupted')) return 'cut';
  return 'other';
}

/** What a failure inside the seal would have looked like to the agent. */
export function sealRescueKind(err: any): SealRescueKind {
  if (err?.governor === true) return err.governorKind === 'stall' ? 'stall' : 'loop';
  if (err?.agentGuard === true) return 'guard';
  return sealRescueKindFromText(err?.message);
}

/** Suffix on the stored error of a failure the agent never saw, so the board can count them. */
export const SEALED_MARK = ' [sealed]';
/** Suffix on the stored error of a Hermes turn that failed after reaching the agent. */
export const VISIBLE_MARK = ' [reached Hermes]';

/** The X-HermesFLLM-Seal header value for the attempt that answers. */
export function sealHeader(release: 'answer' | 'valve' | null, rescued: number): string {
  const head = release ? `released (${release})` : 'sealed';
  return rescued > 0 ? `${head}; ${rescued} rescued` : head;
}

// ── Stats for the board ───────────────────────────────────────────────────────

export type SealDelivery = 'whole' | 'answer' | 'valve';

let stats = freshStats();
function freshStats() {
  return {
    /** Agent turns delivered under the seal. */
    turns: 0,
    /** Delivered whole, after the end-of-stream checks. */
    whole: 0,
    /** Of those, turns whose prose or reasoning the old commit rule would already have streamed. */
    held: 0,
    released: { answer: 0, valve: 0 },
    rescued: Object.fromEntries(SEAL_RESCUE_KINDS.map(k => [k, 0])) as Record<SealRescueKind, number>,
    since: new Date().toISOString(),
  };
}

export function noteSealDelivery(how: SealDelivery, held: boolean): void {
  stats.turns++;
  if (how === 'whole') {
    stats.whole++;
    if (held) stats.held++;
  } else {
    stats.released[how]++;
  }
}

export function noteSealRescue(kind: SealRescueKind): void {
  stats.rescued[kind]++;
}

export function sealStats() {
  return {
    turns: stats.turns,
    whole: stats.whole,
    held: stats.held,
    released: { ...stats.released },
    rescued: { ...stats.rescued },
    since: stats.since,
  };
}

export function resetSealState(): void {
  stats = freshStats();
}
