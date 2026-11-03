import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { agentGuardReasons } from './tool-validate.js';
import { isHermesAutoModel } from './hermes-auto.js';

// HermesFLLM shadow comparison: the same agent traffic, side by side with the original
// FreeLLMAPI. For a sample of agent turns (tool-bearing /v1/chat/completions), an invisible
// copy of the request goes to FreeLLMAPI in parallel. The agent only ever gets the HermesFLLM
// answer; the copy is read, judged and thrown away. Both answers are judged by the same rules:
//  - error:        HTTP error, in-band error frame, or no answer in time
//  - tool_invalid: tool calls the Agent Guard would reject (bad JSON, unknown tool, schema)
//  - tool_ok:      tool calls the agent can run
//  - text:         a non-empty text answer
//  - empty:        nothing usable
// The panel reads three metrics, the same for both sides, over complete pairs:
//  1. valid tool call: share of turns that end with a tool call the agent can run (tool_ok);
//  2. first token p50/p90: for HermesFLLM split by turns where the first-token race launched a
//     backup and turns where it did not (FreeLLMAPI has no race);
//  3. no answer: share of turns ending in an error, a timeout or an empty answer.
// No verdict below MIN_PAIRS pairs. Only outcomes and timings are stored, never the content. Off by default: it doubles the
// free quota spent on sampled turns and needs FreeLLMAPI running. Env:
//   HERMESFLLM_SHADOW=1, HERMESFLLM_SHADOW_RATE (0.1), HERMESFLLM_SHADOW_URL
//   (http://127.0.0.1:3001), HERMESFLLM_SHADOW_TIMEOUT_MS (300000).

export interface ShadowConfig {
  rate: number;
  url: string;
  timeoutMs: number;
  maxInFlight: number;
}

export type ShadowOutcome = 'tool_ok' | 'tool_invalid' | 'text' | 'empty' | 'error';

const SHADOW_HEADER = 'x-hermesfllm-shadow';
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MIN_PAIRS = 30;

// Per sampled turn, so the first-token race can say it launched a backup for this turn.
const turnContext = new AsyncLocalStorage<{ raced: boolean }>();

/** Called by the first-token race when it starts a backup; a no-op outside a sampled turn. */
export function markTurnRaced(): void {
  const turn = turnContext.getStore();
  if (turn) turn.raced = true;
}

export function shadowConfig(env: Record<string, string | undefined> = process.env): ShadowConfig | null {
  const on = (env.HERMESFLLM_SHADOW ?? '').trim().toLowerCase();
  if (!(on === '1' || on === 'true' || on === 'on')) return null;
  const rate = Number(env.HERMESFLLM_SHADOW_RATE);
  const timeout = Number(env.HERMESFLLM_SHADOW_TIMEOUT_MS);
  return {
    rate: env.HERMESFLLM_SHADOW_RATE !== undefined && Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0.1,
    url: (env.HERMESFLLM_SHADOW_URL?.trim() || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 300_000,
    maxInFlight: 2,
  };
}

type Tools = Parameters<typeof agentGuardReasons>[1];

/** Judges one chat/completions answer (SSE stream or JSON body) the way the agent would live it. */
export function judgeAnswer(status: number, raw: string, tools: Tools): { outcome: ShadowOutcome; error: string | null } {
  let content = '';
  let errorMsg: string | null = status >= 400 ? `HTTP ${status}` : null;
  const calls = new Map<number, { function: { name: string; arguments: string } }>();
  const take = (msg: any) => {
    if (typeof msg?.content === 'string') content += msg.content;
    for (const [i, tc] of (msg?.tool_calls ?? []).entries()) {
      const idx = typeof tc.index === 'number' ? tc.index : i;
      const call = calls.get(idx) ?? { function: { name: '', arguments: '' } };
      if (tc.function?.name) call.function.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') call.function.arguments += tc.function.arguments;
      calls.set(idx, call);
    }
  };
  const readError = (obj: any) => {
    if (obj?.error) errorMsg = String(obj.error.message ?? obj.error).slice(0, 200);
  };

  if (/^data: /m.test(raw)) {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ') || line.startsWith('data: [DONE]')) continue;
      let chunk: any;
      try { chunk = JSON.parse(line.slice(6)); } catch { continue; }
      readError(chunk);
      take(chunk.choices?.[0]?.delta);
    }
  } else if (raw.trim() !== '') {
    try {
      const body = JSON.parse(raw);
      readError(body);
      take(body.choices?.[0]?.message);
    } catch {
      errorMsg ??= 'unparseable answer';
    }
  }

  if (errorMsg) return { outcome: 'error', error: errorMsg };
  if (calls.size > 0) {
    const reasons = agentGuardReasons([...calls.values()], tools);
    return reasons.length > 0 ? { outcome: 'tool_invalid', error: reasons.slice(0, 2).join('; ').slice(0, 200) } : { outcome: 'tool_ok', error: null };
  }
  return content.trim() !== '' ? { outcome: 'text', error: null } : { outcome: 'empty', error: null };
}

/** A keep-alive comment (": ping") is not an answer; the first real bytes are. */
function isRealBytes(text: string): boolean {
  return text.trim() !== '' && !text.trimStart().startsWith(':');
}

type Side = 'h' | 'f';

function saveSide(id: string, side: Side, v: { outcome: string; status: number | null; ttfbMs: number | null; latencyMs: number; error: string | null; raced?: boolean }) {
  try {
    getDb().prepare(`
      INSERT INTO hermes_shadow_pairs (request_id, ${side}_outcome, ${side}_status, ${side}_ttfb_ms, ${side}_latency_ms, ${side}_error${side === 'h' ? ', h_raced' : ''})
      VALUES (?, ?, ?, ?, ?, ?${side === 'h' ? ', ?' : ''})
      ON CONFLICT(request_id) DO UPDATE SET
        ${side}_outcome = excluded.${side}_outcome, ${side}_status = excluded.${side}_status,
        ${side}_ttfb_ms = excluded.${side}_ttfb_ms, ${side}_latency_ms = excluded.${side}_latency_ms,
        ${side}_error = excluded.${side}_error${side === 'h' ? ', h_raced = excluded.h_raced' : ''}
    `).run(id, v.outcome, v.status, v.ttfbMs, v.latencyMs, v.error, ...(side === 'h' ? [v.raced ? 1 : 0] : []));
  } catch (err: any) {
    console.warn(`[shadow] could not save the ${side === 'h' ? 'HermesFLLM' : 'FreeLLMAPI'} side: ${err?.message}`);
  }
}

async function runShadow(cfg: ShadowConfig, id: string, body: unknown, tools: Tools, authorization: string | undefined) {
  const started = Date.now();
  let ttfbMs: number | null = null;
  let status: number | null = null;
  let raw = '';
  try {
    const res = await fetch(`${cfg.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SHADOW_HEADER]: '1', ...(authorization ? { Authorization: authorization } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    status = res.status;
    const decoder = new TextDecoder();
    for await (const part of res.body ?? []) {
      const text = decoder.decode(part as Uint8Array, { stream: true });
      if (ttfbMs === null && isRealBytes(text)) ttfbMs = Date.now() - started;
      if (raw.length < MAX_CAPTURE_BYTES) raw += text;
    }
    const verdict = judgeAnswer(status, raw, tools);
    saveSide(id, 'f', { ...verdict, status, ttfbMs, latencyMs: Date.now() - started });
  } catch (err: any) {
    // FreeLLMAPI not running says nothing about its quality: kept apart from real errors.
    const refused = err?.cause?.code === 'ECONNREFUSED';
    const timedOut = err?.name === 'TimeoutError';
    // A stream cut part-way is still judged on what arrived (an agent would see the same).
    const verdict = refused ? { outcome: 'unreachable', error: 'FreeLLMAPI not reachable' }
      : timedOut ? { outcome: 'error', error: `no complete answer within ${Math.round(cfg.timeoutMs / 1000)}s` }
        : raw ? judgeAnswer(status ?? 200, raw, tools)
          : { outcome: 'error', error: String(err?.message ?? err).slice(0, 200) };
    saveSide(id, 'f', { ...verdict, status, ttfbMs, latencyMs: Date.now() - started });
  }
}

let inFlight = 0;

/**
 * Mounted in front of POST /v1/chat/completions. Never changes the request or the answer:
 * it only copies sampled agent turns to FreeLLMAPI and watches what the agent receives.
 */
export function shadowMiddleware(req: Request, res: Response, next: NextFunction): void {
  const cfg = shadowConfig();
  const tools = req.body?.tools;
  if (
    !cfg || req.method !== 'POST' || req.headers[SHADOW_HEADER]
    || !Array.isArray(tools) || tools.length === 0
    || inFlight >= cfg.maxInFlight || Math.random() >= cfg.rate
  ) return next();

  const id = randomUUID();
  const started = Date.now();
  // FreeLLMAPI has no autoTOP-hermes; its own router pick is `auto`.
  const body = isHermesAutoModel(req.body.model) ? { ...req.body, model: 'auto' } : req.body;
  inFlight++;
  void runShadow(cfg, id, body, tools, req.headers.authorization).finally(() => { inFlight--; });

  let raw = '';
  let ttfbMs: number | null = null;
  const capture = (chunk: unknown, encoding: unknown) => {
    if (chunk == null || typeof chunk === 'function') return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8')
      : typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8').toString('utf8')
        : String(chunk);
    if (ttfbMs === null && isRealBytes(text)) ttfbMs = Date.now() - started;
    if (raw.length < MAX_CAPTURE_BYTES) raw += text;
  };
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = ((chunk: unknown, ...rest: unknown[]) => { capture(chunk, rest[0]); return (write as any)(chunk, ...rest); }) as typeof res.write;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => { capture(chunk, rest[0]); return (end as any)(chunk, ...rest); }) as typeof res.end;

  const turn = { raced: false };
  res.once('close', () => {
    const latencyMs = Date.now() - started;
    if (!res.writableFinished) {
      saveSide(id, 'h', { outcome: 'aborted', status: res.statusCode, ttfbMs, latencyMs, error: 'agent closed the connection', raced: turn.raced });
      return;
    }
    saveSide(id, 'h', { ...judgeAnswer(res.statusCode, raw, tools), status: res.statusCode, ttfbMs, latencyMs, raced: turn.raced });
  });
  turnContext.run(turn, () => next());
}

/** Nearest-rank percentile of `values` (unsorted); null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export interface Ttfb { p50: number | null; p90: number | null; n: number }
const ttfb = (values: number[]): Ttfb => ({ p50: percentile(values, 50), p90: percentile(values, 90), n: values.length });

export interface PairRow {
  h_outcome: string; h_ttfb_ms: number | null; h_raced: number;
  f_outcome: string; f_ttfb_ms: number | null;
}

/** The three metrics over complete pairs; turns the agent itself rejected or abandoned are left out. */
export function shadowStats(days = 7) {
  const cfg = shadowConfig();
  let rows: PairRow[] = [];
  let pending = 0;
  let unreachable = 0;
  try {
    const db = getDb();
    const window = `created_at >= datetime('now', '-${Math.max(1, Math.floor(days))} days')`;
    rows = db.prepare(`
      SELECT h_outcome, h_ttfb_ms, h_raced, f_outcome, f_ttfb_ms FROM hermes_shadow_pairs
       WHERE ${window} AND h_outcome IS NOT NULL AND f_outcome IS NOT NULL
         AND h_outcome != 'aborted' AND f_outcome != 'unreachable'
         AND COALESCE(h_status, 200) NOT IN (400, 401, 403, 404, 413)
    `).all() as PairRow[];
    const extra = db.prepare(`
      SELECT SUM(h_outcome IS NULL OR f_outcome IS NULL) AS pending, SUM(f_outcome = 'unreachable') AS unreachable
        FROM hermes_shadow_pairs WHERE ${window}
    `).get() as { pending: number | null; unreachable: number | null };
    pending = extra.pending ?? 0;
    unreachable = extra.unreachable ?? 0;
  } catch {
    rows = []; // table not migrated yet: an empty comparison rather than a failed board
  }
  const pairs = rows.length;
  const share = (n: number) => (pairs > 0 ? n / pairs : null);
  const count = (pred: (r: PairRow) => boolean) => rows.filter(pred).length;
  const times = (pick: (r: PairRow) => number | null, pred: (r: PairRow) => boolean = () => true) =>
    rows.filter(pred).map(pick).filter((v): v is number => v !== null);
  const noAnswer = (o: string) => o === 'error' || o === 'empty';

  const hermes = {
    validToolCallRate: share(count(r => r.h_outcome === 'tool_ok')),
    noAnswerRate: share(count(r => noAnswer(r.h_outcome))),
    ttfb: ttfb(times(r => r.h_ttfb_ms)),
    ttfbRaced: ttfb(times(r => r.h_ttfb_ms, r => r.h_raced === 1)),
    ttfbNotRaced: ttfb(times(r => r.h_ttfb_ms, r => r.h_raced !== 1)),
  };
  const freellmapi = {
    validToolCallRate: share(count(r => r.f_outcome === 'tool_ok')),
    noAnswerRate: share(count(r => noAnswer(r.f_outcome))),
    ttfb: ttfb(times(r => r.f_ttfb_ms)),
  };

  // Per metric, the better side; nothing is decided on a small sample.
  type Winner = 'hermes' | 'freellmapi' | 'tie' | null;
  const better = (h: number | null, f: number | null, higherIsBetter: boolean): Winner => {
    if (pairs < MIN_PAIRS || h === null || f === null) return null;
    if (h === f) return 'tie';
    return (h > f) === higherIsBetter ? 'hermes' : 'freellmapi';
  };
  return {
    enabled: cfg !== null,
    sampleRate: cfg?.rate ?? null,
    days,
    pairs,
    minPairs: MIN_PAIRS,
    pending,
    unreachable,
    hermes,
    freellmapi,
    winners: {
      validToolCall: better(hermes.validToolCallRate, freellmapi.validToolCallRate, true),
      ttfbP50: better(hermes.ttfb.p50, freellmapi.ttfb.p50, false),
      ttfbP90: better(hermes.ttfb.p90, freellmapi.ttfb.p90, false),
      noAnswer: better(hermes.noAnswerRate, freellmapi.noAnswerRate, false),
    },
  };
}
