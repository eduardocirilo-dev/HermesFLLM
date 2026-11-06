// HermesFLLM sealed turns: configuration, scope, the hold/release verdict and how failures inside
// the seal are named.

import { afterEach, describe, expect, it } from 'vitest';
import {
  isHermesTraffic, noteSealDelivery, noteSealRescue, resetSealState, sealConfig, sealHeader, sealRescueKind,
  sealRescueKindFromText, sealStats, sealVerdict, SEALED_MARK,
} from '../../lib/hermes-seal.js';
import { governorError } from '../../lib/hermes-governor.js';
import { agentGuardError, invalidToolArgumentsError } from '../../lib/tool-validate.js';

describe('sealConfig', () => {
  it('is on by default with an 800-character answer release and a 60s valve', () => {
    expect(sealConfig({})).toEqual({ releaseChars: 800, maxMs: 60_000 });
  });

  it('turns off with 0, false or off', () => {
    for (const v of ['0', 'false', 'off', ' OFF ']) expect(sealConfig({ HERMESFLLM_SEAL: v })).toBeNull();
    expect(sealConfig({ HERMESFLLM_SEAL: '1' })).not.toBeNull();
  });

  it('clamps the knobs to sane bounds and ignores junk', () => {
    expect(sealConfig({ HERMESFLLM_SEAL_RELEASE_CHARS: '10', HERMESFLLM_SEAL_MAX_MS: '1000' })).toEqual({ releaseChars: 200, maxMs: 15_000 });
    expect(sealConfig({ HERMESFLLM_SEAL_RELEASE_CHARS: '999999', HERMESFLLM_SEAL_MAX_MS: '9999999' })).toEqual({ releaseChars: 20_000, maxMs: 240_000 });
    expect(sealConfig({ HERMESFLLM_SEAL_RELEASE_CHARS: 'lots' })).toEqual({ releaseChars: 800, maxMs: 60_000 });
  });
});

describe('isHermesTraffic', () => {
  it('is the autoTOP-hermes model or a client classified as hermes-agent, nothing else', () => {
    expect(isHermesTraffic('autoTOP-hermes', 'unknown')).toBe(true);
    expect(isHermesTraffic('auto', 'hermes-agent')).toBe(true);
    expect(isHermesTraffic('auto', 'openai-sdk')).toBe(false);
    expect(isHermesTraffic(undefined, null)).toBe(false);
  });
});

describe('sealVerdict', () => {
  const cfg = { releaseChars: 800, maxMs: 60_000 };
  it('holds a short preamble, with or without a tool call', () => {
    expect(sealVerdict({ heldChars: 200, toolCallStarted: false, elapsedMs: 2_000 }, cfg)).toBe('hold');
    expect(sealVerdict({ heldChars: 200, toolCallStarted: true, elapsedMs: 2_000 }, cfg)).toBe('hold');
  });

  it('releases a long text with no tool call as a final answer', () => {
    expect(sealVerdict({ heldChars: 800, toolCallStarted: false, elapsedMs: 2_000 }, cfg)).toBe('answer');
  });

  it('keeps holding a long preamble once a tool call has started; only the valve releases it', () => {
    expect(sealVerdict({ heldChars: 1_600, toolCallStarted: true, elapsedMs: 2_000 }, cfg)).toBe('hold');
    expect(sealVerdict({ heldChars: 1_600, toolCallStarted: true, elapsedMs: 61_000 }, cfg)).toBe('valve');
  });

  it('opens the valve for any turn still producing after maxMs', () => {
    expect(sealVerdict({ heldChars: 10, toolCallStarted: false, elapsedMs: 60_000 }, cfg)).toBe('valve');
  });
});

describe('naming a failure inside the seal', () => {
  it('maps the real error constructors', () => {
    expect(sealRescueKind(governorError('stall', 'M', '30s'))).toBe('stall');
    expect(sealRescueKind(governorError('runaway', 'M', 'x'))).toBe('loop');
    expect(sealRescueKind(governorError('ceiling', 'M', 'x'))).toBe('loop');
    expect(sealRescueKind(agentGuardError('M', ['undeclared tool read_terminal']))).toBe('guard');
    expect(sealRescueKind(invalidToolArgumentsError('M', ['bad']))).toBe('guard');
    expect(sealRescueKind(new Error('unparseable inline tool-call dialect from M: <tool_call>{'))).toBe('inline');
    expect(sealRescueKind(new Error('in-band provider error from M: overloaded'))).toBe('cut');
    expect(sealRescueKind(new Error('stream ended unexpectedly (no [DONE], no finish_reason)'))).toBe('cut');
    expect(sealRescueKind(new Error('empty completion from M (upstream classification output)'))).toBe('other');
  });

  it('reads the same kinds back from stored error rows', () => {
    const stored = (err: Error) => `${err.message}${SEALED_MARK}`;
    expect(sealRescueKindFromText(stored(governorError('stall', 'M', '30s')))).toBe('stall');
    expect(sealRescueKindFromText(stored(governorError('runaway', 'M', 'x')))).toBe('loop');
    expect(sealRescueKindFromText(stored(agentGuardError('M', ['x'])))).toBe('guard');
    expect(sealRescueKindFromText(null)).toBe('other');
  });
});

describe('sealHeader', () => {
  it('says how the answering attempt was delivered and how many half-turns were kept back', () => {
    expect(sealHeader(null, 0)).toBe('sealed');
    expect(sealHeader(null, 2)).toBe('sealed; 2 rescued');
    expect(sealHeader('answer', 0)).toBe('released (answer)');
    expect(sealHeader('valve', 1)).toBe('released (valve); 1 rescued');
  });
});

describe('seal stats', () => {
  afterEach(() => resetSealState());
  it('counts deliveries and rescues until reset', () => {
    noteSealDelivery('whole', true);
    noteSealDelivery('whole', false);
    noteSealDelivery('answer', true);
    noteSealDelivery('valve', true);
    noteSealRescue('stall');
    noteSealRescue('guard');
    noteSealRescue('guard');
    const s = sealStats();
    expect(s).toMatchObject({ turns: 4, whole: 2, held: 1, released: { answer: 1, valve: 1 } });
    expect(s.rescued).toEqual({ stall: 1, loop: 0, guard: 2, inline: 0, cut: 0, other: 0 });
    resetSealState();
    expect(sealStats().turns).toBe(0);
  });
});
