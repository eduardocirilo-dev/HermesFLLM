import { deflateRawSync } from 'zlib';

// HermesFLLM Turn Governor: no agent turn stays frozen.
//
// The agent deadline and the first-token race protect the START of a turn. After the first
// token nothing bounded it: the upstream stall watchdog only fires after 90s without a single
// byte, and Hermes raises its own no-event watchdog to 900s for a local provider. Observed: a
// model that "answered" and then trickled output for 25 minutes before stalling, and turns of
// 2-5 minutes that ended in a provider timeout.
//
// The governor watches real progress (characters of text, reasoning and tool-call arguments,
// not bytes, so heartbeats and empty deltas do not count) and trips on:
//  - stall:   less than MIN_GROWTH new characters for stallMs (30s) before anything reached the
//             client, or committedStallMs (90s) after;
//  - runaway: the last 8KB of output compresses better than runawayRatio (20x). Calibrated on
//             real text: code, README, lockfile JSON, escaped write_file arguments, CSV and
//             markdown tables compress 2.2-7.4x; degenerate repetition loops compress 43-315x;
//  - ceiling: the turn has run ceilingMs (5 min) without sending anything to the client.
// Before the commit the turn fails over to the next model, invisibly. After it, the stream
// ends with a clean error so the agent retries instead of waiting.

export interface GovernorConfig {
  stallMs: number;
  committedStallMs: number;
  ceilingMs: number;
  runawayRatio: number;
  runawayMinChars: number;
}

const MIN_GROWTH = 32;
const RUNAWAY_WINDOW = 8192;
const RUNAWAY_CHECK_EVERY = 4096;
const TAIL_KEEP = 16384;
const CHECK_INTERVAL_MS = 1000;

function ms(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 0 disables a rule. HERMESFLLM_GOVERNOR=0 disables the governor entirely. */
export function governorConfig(env: Record<string, string | undefined> = process.env): GovernorConfig | null {
  const switchRaw = (env.HERMESFLLM_GOVERNOR ?? '').trim().toLowerCase();
  if (switchRaw === '0' || switchRaw === 'false' || switchRaw === 'off') return null;
  return {
    stallMs: ms(env, 'HERMESFLLM_STALL_MS', 30_000),
    committedStallMs: ms(env, 'HERMESFLLM_COMMITTED_STALL_MS', 90_000),
    ceilingMs: ms(env, 'HERMESFLLM_TURN_CEILING_MS', 300_000),
    runawayRatio: Number(env.HERMESFLLM_RUNAWAY_RATIO) > 0 ? Number(env.HERMESFLLM_RUNAWAY_RATIO) : 20,
    runawayMinChars: RUNAWAY_WINDOW,
  };
}

export type GovernorKind = 'stall' | 'runaway' | 'ceiling';

/**
 * Model-scoped and retryable (the message carries "timeout"): before the commit the loop fails
 * over to the next model and penalises this one, without ruling out its whole provider.
 * `governor` lets the loop renew its time budget so a late rescue still has models to try.
 */
export function governorError(kind: GovernorKind, displayName: string, detail: string): Error {
  const what = kind === 'stall' ? 'stopped making progress'
    : kind === 'runaway' ? 'is looping (repeating output)'
      : 'exceeded the turn ceiling';
  return Object.assign(
    new Error(`agent governor: ${displayName} ${what} — ${detail} (timeout), failing over`),
    { governor: true, governorKind: kind, skipModelForRequest: true },
  );
}

/** How much better than plain text the tail compresses; ~2-7 for real output, 40+ for loops. */
export function repetitionRatio(text: string, window = RUNAWAY_WINDOW): number {
  const tail = Buffer.from(text.length > window ? text.slice(-window) : text);
  if (tail.length === 0) return 1;
  return tail.length / Math.max(1, deflateRawSync(tail).length);
}

export interface GovernorOptions {
  displayName: string;
  /** True once anything (content or a keep-alive) reached the client. */
  isCommitted: () => boolean;
  /** Called once when a rule trips; the caller aborts the upstream request with this error. */
  onTrip: (err: Error) => void;
  now?: () => number;
  /** Tests drive `check()` themselves. */
  manual?: boolean;
}

export class TurnGovernor {
  private readonly now: () => number;
  private readonly startedAt: number;
  private progressChars = 0;
  private markChars = 0;
  private markAt: number;
  private firstTokenSeen = false;
  private tail = '';
  private charsAtLastRunawayCheck = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tripped = false;

  constructor(private readonly cfg: GovernorConfig, private readonly opts: GovernorOptions) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.markAt = this.startedAt;
    if (!opts.manual) {
      this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  /** Feed every meaningful delta (text, reasoning, tool-call name/arguments). */
  progress(delta: string): void {
    if (this.tripped || delta.length === 0) return;
    this.firstTokenSeen = true;
    this.progressChars += delta.length;
    if (this.progressChars - this.markChars >= MIN_GROWTH) {
      this.markChars = this.progressChars;
      this.markAt = this.now();
    }
    this.tail += delta;
    if (this.tail.length > TAIL_KEEP) this.tail = this.tail.slice(-TAIL_KEEP);
    if (
      this.cfg.runawayRatio > 0
      && this.progressChars >= this.cfg.runawayMinChars
      && this.progressChars - this.charsAtLastRunawayCheck >= RUNAWAY_CHECK_EVERY
    ) {
      this.charsAtLastRunawayCheck = this.progressChars;
      const ratio = repetitionRatio(this.tail);
      if (ratio >= this.cfg.runawayRatio) {
        this.trip('runaway', `last 8KB compress ${ratio.toFixed(0)}x after ${this.progressChars} chars`);
      }
    }
  }

  /** Evaluate the time rules; runs every second unless `manual`. */
  check(): void {
    if (this.tripped) return;
    const now = this.now();
    const committed = this.opts.isCommitted();
    if (!committed && this.cfg.ceilingMs > 0 && now - this.startedAt >= this.cfg.ceilingMs) {
      this.trip('ceiling', `${Math.round((now - this.startedAt) / 1000)}s with nothing sent to the agent`);
      return;
    }
    // Before the first token the agent deadline owns the turn.
    if (!this.firstTokenSeen) return;
    const stallMs = committed ? this.cfg.committedStallMs : this.cfg.stallMs;
    if (stallMs > 0 && now - this.markAt >= stallMs) {
      this.trip('stall', `under ${MIN_GROWTH} new characters in ${Math.round((now - this.markAt) / 1000)}s`);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get hasTripped(): boolean {
    return this.tripped;
  }

  private trip(kind: GovernorKind, detail: string): void {
    this.tripped = true;
    this.stop();
    this.opts.onTrip(governorError(kind, this.opts.displayName, detail));
  }
}
