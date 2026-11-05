// HermesFLLM first-token race (hedged requests for agent turns).
//
// The upstream fallback loop is strictly sequential: a model that is slow to start keeps the agent
// waiting until it answers or its deadline fires, and only then does the next model start, cold.
// On free tiers, where queueing is the norm, that waiting dominates an agent's turn time.
//
// The race fixes the tail without paying for every turn twice. The routed model starts alone. If it
// has produced no token after its own hedge delay (its recent p90 time to first token, see
// raceDelayMs), the next-best model starts in parallel. The first one to produce a token wins and the
// other is cancelled at once, before it can write a byte, so the client only ever sees one answer.
// Fast models never trigger a backup; only the turns that would have stalled pay for a second
// prompt.
//
// Rules, in order:
// - A winner is decided at the first token (dispatch calls ctx.firstToken()). Losers are aborted
//   through ctx.raceSignal and are not penalised: being slower than a rival is not a fault.
// - A racer that fails while its rival is still running is recorded as a normal failure (cooldown,
//   trail, analytics) and the rival keeps going. If the primary fails before the backup started,
//   nothing changes from the plain loop: the error goes straight back to it.
// - A winner that fails after claiming (e.g. Agent Guard rejects its tool call) fails over through
//   the loop as usual.
// - Client aborts, time-budget aborts and non-retryable errors end the race immediately.
import type { RouteResult } from '../services/router.js';
import { getDb } from '../db/index.js';
import { withKeyProxy } from './proxy.js';
import { isClientAbortError, isHedgeAbortError, isKeyAuthError, isRetryableError } from './error-classify.js';

/** Minimal shapes, kept local so this module does not import the loop (which imports it). */
export type RaceOutcome = 'done' | 'committed';
export interface RaceDispatchContext {
  disarmHedge(): void;
  firstToken(): boolean;
  raceSignal: AbortSignal;
  raceBackup: boolean;
}

// ── Configuration ───────────────────────────────────────────────────────────

function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** ON by default; HERMESFLLM_RACE=0|false|off disables it. */
export function isRaceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HERMESFLLM_RACE?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

export function raceDelayBounds(env: Record<string, string | undefined> = process.env) {
  const min = envNumber(env.HERMESFLLM_RACE_MIN_DELAY_MS, 3_000);
  const max = Math.max(min, envNumber(env.HERMESFLLM_RACE_MAX_DELAY_MS, 15_000));
  const fallback = Math.min(max, Math.max(min, envNumber(env.HERMESFLLM_RACE_DELAY_MS, 8_000)));
  return { min, max, fallback };
}

const MIN_SAMPLES = 8;
const SAMPLE_WINDOW = 200;
const DELAY_CACHE_MS = 60_000;
const delayCache = new Map<number, { at: number; ms: number }>();

/**
 * How long to let a model run alone before racing a backup against it: 1.25 x its p90 time to first
 * token over its last 200 successful requests in 24h (total latency where no TTFB was recorded),
 * clamped to [min, max]. A model with fewer than 8 samples gets the default. A model that normally
 * answers in 2s is hedged after ~3s; one that normally takes 9s is left alone for ~11s.
 */
export function raceDelayMs(modelDbId: number | undefined, now = Date.now()): number {
  const { min, max, fallback } = raceDelayBounds();
  if (!modelDbId) return fallback;
  const hit = delayCache.get(modelDbId);
  if (hit && now - hit.at < DELAY_CACHE_MS) return hit.ms;
  let ms = fallback;
  try {
    const rows = getDb().prepare(`
      SELECT t FROM (
        SELECT COALESCE(ttfb_ms, latency_ms) AS t
          FROM requests
         WHERE model_db_id = ? AND status = 'success' AND created_at >= datetime('now', '-1 day')
           AND COALESCE(ttfb_ms, latency_ms) > 0
         ORDER BY id DESC
         LIMIT ${SAMPLE_WINDOW}
      ) ORDER BY t ASC
    `).all(modelDbId) as Array<{ t: number }>;
    if (rows.length >= MIN_SAMPLES) {
      const p90 = rows[Math.floor(0.9 * (rows.length - 1))].t;
      ms = Math.min(max, Math.max(min, Math.round(p90 * 1.25)));
    }
  } catch {
    ms = fallback; // never let analytics break routing
  }
  delayCache.set(modelDbId, { at: now, ms });
  return ms;
}

// ── Errors and stats ────────────────────────────────────────────────────────

export function raceLostError(): Error {
  return Object.assign(new Error('race lost: another model produced its first token sooner'), { raceLost: true });
}

export function isRaceLostError(err: any): boolean {
  return !!err?.raceLost;
}

export interface RaceStats {
  /** Turns where a backup was started. */
  races: number;
  /** Races the backup won (the turn would otherwise have kept waiting on the primary). */
  backupWins: number;
  /** Races the primary still won after the backup started. */
  primaryWins: number;
  /** Races where both failed and the loop moved on. */
  bothFailed: number;
  /** Races whose winner failed after its first token (e.g. Agent Guard rejected its tool call). */
  winnerFailed: number;
  /** Sum over backup wins of (time the winner answered - when the primary started). */
  backupWinMs: number;
  since: string;
}

let stats: RaceStats = freshStats();
function freshStats(): RaceStats {
  return { races: 0, backupWins: 0, primaryWins: 0, bothFailed: 0, winnerFailed: 0, backupWinMs: 0, since: new Date().toISOString() };
}
export function raceStats(): RaceStats {
  return { ...stats };
}
export function resetRaceState(): void {
  stats = freshStats();
  delayCache.clear();
}

// ── The race ────────────────────────────────────────────────────────────────

export interface RaceArgs {
  primary: RouteResult;
  attempt: number;
  delayMs: number;
  dispatch(route: RouteResult, attempt: number, ctx: RaceDispatchContext): Promise<RaceOutcome>;
  disarmHedge(): void;
  /** The next-best route with the primary's model excluded, or null when there is none. */
  pickBackup(): RouteResult | null;
  /** Book a failure of a racer whose rival is still running (the loop's normal failure path). */
  recordSideFailure(route: RouteResult, err: any): void;
  /** Tell the loop which route owns this attempt (its trace, its errors, its lease). */
  setRoute(route: RouteResult): void;
}

interface Racer {
  route: RouteResult;
  backup: boolean;
  ac: AbortController;
  settled: boolean;
  promise: Promise<Settled>;
}
type Settled = { racer: Racer; ok: true; outcome: RaceOutcome } | { racer: Racer; ok: false; err: any };

/**
 * Run one loop attempt as a race. Resolves with the winner's outcome, or throws the error the loop
 * should handle, after calling setRoute() with the route that error belongs to. Every racer's lease
 * except the final owner's is released here; the loop releases the owner's, as it always does.
 */
export async function raceDispatch(a: RaceArgs): Promise<RaceOutcome> {
  const startedAt = Date.now();
  const racers: Racer[] = [];
  let winner: Racer | null = null;
  let backupWindowOpen = true;
  let timer: NodeJS.Timeout | undefined;
  let wake: () => void = () => {};
  const woken = new Promise<null>(resolve => { wake = () => resolve(null); });

  const closeWindow = () => {
    backupWindowOpen = false;
    if (timer) { clearTimeout(timer); timer = undefined; }
  };

  const claim = (r: Racer): boolean => {
    if (winner) return winner === r;
    winner = r;
    closeWindow();
    for (const other of racers) {
      if (other !== r && !other.settled) other.ac.abort(raceLostError());
    }
    return true;
  };

  const start = (route: RouteResult, backup: boolean): Racer => {
    const ac = new AbortController();
    const racer = { route, backup, ac, settled: false } as Racer;
    const ctx: RaceDispatchContext = { disarmHedge: a.disarmHedge, firstToken: () => claim(racer), raceSignal: ac.signal, raceBackup: backup };
    racer.promise = Promise.resolve()
      .then(() => withKeyProxy(route.proxyUrl, () => a.dispatch(route, a.attempt, ctx)))
      .then(
        (outcome): Settled => { racer.settled = true; return { racer, ok: true, outcome }; },
        (err): Settled => { racer.settled = true; return { racer, ok: false, err }; },
      );
    racers.push(racer);
    return racer;
  };

  const primary = start(a.primary, false);
  const raced = () => racers.length > 1;

  timer = setTimeout(() => {
    timer = undefined;
    if (!backupWindowOpen || winner) return;
    backupWindowOpen = false;
    let backup: RouteResult | null = null;
    try { backup = a.pickBackup(); } catch { backup = null; }
    if (backup) {
      stats.races++;
      console.log(`[Race] ${a.primary.platform}/${a.primary.modelId} silent for ${a.delayMs}ms, racing ${backup.platform}/${backup.modelId}`);
      start(backup, true);
    }
    wake();
  }, a.delayMs);
  timer.unref?.();

  /** Hand the attempt to `owner`; abort and release everyone else once they settle. */
  const finish = (owner: Racer): void => {
    closeWindow();
    a.setRoute(owner.route);
    for (const r of racers) {
      if (r === owner) continue;
      if (!r.settled) r.ac.abort(raceLostError());
      void r.promise.then(() => r.route.release?.());
    }
  };

  const pending = new Set<Racer>([primary]);
  let lastFailure: Settled | null = null;

  for (;;) {
    const waits: Array<Promise<Settled | null>> = [...pending].map(r => r.promise);
    if (backupWindowOpen) waits.push(woken);
    if (waits.length === 0) {
      // Everyone settled without a result: hand the last failure to the loop.
      const last = lastFailure ?? { racer: primary, ok: false as const, err: new Error('race ended without a result') };
      if (raced() && !winner) stats.bothFailed++;
      finish(last.racer);
      throw (last as { err: any }).err;
    }

    const settled = await Promise.race(waits);
    if (settled === null) {
      for (const r of racers) if (!r.settled) pending.add(r);
      continue;
    }
    pending.delete(settled.racer);
    const r = settled.racer;

    if (settled.ok) {
      claim(r); // a dispatch that finished without calling firstToken() still wins outright
      if (raced()) {
        if (r.backup) {
          stats.backupWins++;
          stats.backupWinMs += Date.now() - startedAt;
          console.log(`[Race] ${r.route.platform}/${r.route.modelId} beat ${a.primary.platform}/${a.primary.modelId}`);
        } else {
          stats.primaryWins++;
        }
      }
      finish(r);
      return settled.outcome;
    }

    // Aborted because a rival claimed first: not a failure, just forget it.
    if (winner && winner !== r && r.ac.signal.aborted) continue;

    const err = settled.err;
    const rivalsRunning = pending.size > 0;
    // The winner itself failed after claiming, or nobody else is left: the loop takes it from here
    // exactly as it would without a race. Closing the window first means a primary that fails
    // before its hedge delay never starts a backup, so fast failures fail over as before.
    if (winner === r || !rivalsRunning
      || isClientAbortError(err) || isHedgeAbortError(err)
      || (!isRetryableError(err) && !isKeyAuthError(err))) {
      if (raced() && winner === r) stats.winnerFailed++;
      else if (raced() && !rivalsRunning) stats.bothFailed++;
      finish(r);
      throw err;
    }

    // A rival is still running: book this failure normally and keep waiting for the rival.
    a.recordSideFailure(r.route, err);
    lastFailure = settled;
  }
}
