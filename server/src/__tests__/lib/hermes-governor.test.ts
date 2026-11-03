// HermesFLLM Turn Governor: progress-based stall, drip, ceiling and runaway-loop rules.

import { describe, it, expect } from 'vitest';
import { governorConfig, repetitionRatio, TurnGovernor, type GovernorConfig } from '../../lib/hermes-governor.js';

const cfg: GovernorConfig = { stallMs: 30_000, committedStallMs: 90_000, ceilingMs: 300_000, runawayRatio: 20, runawayMinChars: 8192 };

function harness(overrides: Partial<GovernorConfig> = {}, committed = false) {
  let t = 0;
  const trips: Error[] = [];
  const state = { committed };
  const gov = new TurnGovernor({ ...cfg, ...overrides }, {
    displayName: 'Test Model',
    isCommitted: () => state.committed,
    onTrip: err => trips.push(err),
    now: () => t,
    manual: true,
  });
  return { gov, trips, state, advance: (ms: number) => { t += ms; gov.check(); } };
}

/** Varied, non-repeating text, like real output. */
function realText(n: number): string {
  let out = '';
  let i = 0;
  while (out.length < n) {
    out += `const value${i} = compute(${(i * 7919) % 1009}, "${(i * 104729).toString(36)}");\n`;
    i++;
  }
  return out.slice(0, n);
}

describe('repetitionRatio', () => {
  it('separates real output from degenerate loops by a wide margin', () => {
    expect(repetitionRatio(realText(8192))).toBeLessThan(8);
    expect(repetitionRatio(JSON.stringify({ path: 'a.ts', content: realText(8000) }))).toBeLessThan(8);
    expect(repetitionRatio('I will call the tool now to get the result.\n'.repeat(300))).toBeGreaterThan(40);
    expect(repetitionRatio('\n'.repeat(9000))).toBeGreaterThan(100);
  });
});

describe('TurnGovernor', () => {
  it('leaves the turn alone before the first token (the agent deadline owns that window)', () => {
    const { trips, advance } = harness();
    advance(120_000);
    expect(trips).toEqual([]);
  });

  it('trips on a stall after the first token, before anything reached the agent', () => {
    const { gov, trips, advance } = harness();
    gov.progress('{"command": "ls');
    advance(29_000);
    expect(trips).toEqual([]);
    advance(2_000);
    expect(trips).toHaveLength(1);
    expect(trips[0].message).toMatch(/agent governor: Test Model stopped making progress/);
    expect((trips[0] as any).governorKind).toBe('stall');
    expect((trips[0] as any).skipModelForRequest).toBe(true);
    expect(trips[0].message).toMatch(/timeout/); // retryable
  });

  it('counts a drip (a few characters now and then) as a stall', () => {
    const { gov, trips, advance } = harness();
    gov.progress(realText(200));
    for (let i = 0; i < 4; i++) { advance(10_000); gov.progress('x'); }
    expect(trips.map(e => (e as any).governorKind)).toEqual(['stall']);
  });

  it('never trips while output keeps flowing', () => {
    const { gov, trips, advance } = harness();
    const long = realText(280 * 40);
    for (let i = 0; i < 280; i++) { gov.progress(long.slice(i * 40, i * 40 + 40)); advance(1_000); }
    expect(trips).toEqual([]);
  });

  it('gives a committed stream 90s, not 30s', () => {
    const { gov, trips, advance } = harness({}, true);
    gov.progress('Hello');
    advance(60_000);
    expect(trips).toEqual([]);
    advance(31_000);
    expect(trips.map(e => (e as any).governorKind)).toEqual(['stall']);
  });

  it('enforces the ceiling only while nothing has reached the agent', () => {
    const quiet = harness({ stallMs: 0 });
    quiet.gov.progress('x');
    quiet.advance(300_000);
    expect(quiet.trips.map(e => (e as any).governorKind)).toEqual(['ceiling']);

    const streaming = harness({ stallMs: 0, committedStallMs: 0 }, true);
    streaming.gov.progress('x');
    streaming.advance(600_000);
    expect(streaming.trips).toEqual([]);
  });

  it('trips on a runaway loop, but not on long real output', () => {
    const loop = harness();
    for (let i = 0; i < 40; i++) loop.gov.progress('echo "retrying the same step"; '.repeat(16));
    expect(loop.trips.map(e => (e as any).governorKind)).toEqual(['runaway']);
    expect(loop.trips[0].message).toMatch(/is looping/);

    // 20KB of continuous, varied output (a long write_file), streamed in 512-char deltas.
    const real = harness();
    const long = realText(20_480);
    for (let i = 0; i < long.length; i += 512) real.gov.progress(long.slice(i, i + 512));
    expect(real.trips).toEqual([]);
  });

  it('trips at most once', () => {
    const { gov, trips, advance } = harness();
    gov.progress('x');
    advance(31_000);
    advance(31_000);
    gov.progress('a'.repeat(20_000));
    expect(trips).toHaveLength(1);
  });
});

describe('governorConfig', () => {
  it('defaults to 30s / 90s / 5 min / 20x', () => {
    expect(governorConfig({})).toEqual({ stallMs: 30_000, committedStallMs: 90_000, ceilingMs: 300_000, runawayRatio: 20, runawayMinChars: 8192 });
  });
  it('can be switched off or tuned', () => {
    expect(governorConfig({ HERMESFLLM_GOVERNOR: '0' })).toBeNull();
    expect(governorConfig({ HERMESFLLM_STALL_MS: '0', HERMESFLLM_TURN_CEILING_MS: '60000' })).toMatchObject({ stallMs: 0, ceilingMs: 60_000 });
  });
});
