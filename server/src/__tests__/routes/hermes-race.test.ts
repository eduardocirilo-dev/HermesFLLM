// HermesFLLM first-token race: a silent model races the next-best one, the first token wins, the
// loser is cancelled before writing anything, and nothing changes for fast or failing models.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, getProvider: () => fakeProvider, resolveProvider: () => fakeProvider };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');
const { resetModelFailureWindows } = await import('../../lib/fallback-loop.js');
const { raceStats, resetRaceState, raceDelayMs, isRaceLostError } = await import('../../lib/hermes-race.js');

async function post(app: Express, body: any, key: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  return { status: res.status, raw };
}

function content(raw: string): string {
  let out = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try { out += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? ''; } catch { /* comment or error frame */ }
  }
  return out;
}

function toolCallNames(raw: string): string[] {
  const names: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try {
      for (const tc of JSON.parse(line.slice(6)).choices?.[0]?.delta?.tool_calls ?? []) if (tc.function?.name) names.push(tc.function.name);
    } catch { /* comment or error frame */ }
  }
  return names;
}

/** Resolves after `ms`, or rejects with the abort reason when cancelled (like a real fetch). */
function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

/** Records how each streamed call ended, so tests can see who was cancelled and why. */
const endings: Array<{ model: string; ended: 'answered' | 'aborted'; reason?: any }> = [];

/** A stream that stays silent for `delay` ms, then answers `text`. Honours cancellation. */
function streamAfter(delay: number, text: string) {
  return async function* (_k: string, _m: unknown, model: string, opts: { signal?: AbortSignal }) {
    try {
      await wait(delay, opts.signal);
    } catch (err) {
      endings.push({ model, ended: 'aborted', reason: err });
      throw err;
    }
    endings.push({ model, ended: 'answered' });
    yield { choices: [{ delta: { content: text } }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  };
}

/** Fails this model only (like a deadline or Agent Guard rejection), not its whole provider: the
 *  test catalog serves every model from one platform, so a provider-wide 503 would empty the pool. */
function streamFails(delay: number, message: string) {
  return async function* (_k: string, _m: unknown, _model: string, opts: { signal?: AbortSignal }) {
    await wait(delay, opts.signal);
    throw Object.assign(new Error(message), { skipModelForRequest: true });
    yield {}; // unreachable; keeps this a generator
  };
}

function streamToolCallAfter(delay: number) {
  return async function* (_k: string, _m: unknown, _model: string, opts: { signal?: AbortSignal }) {
    await wait(delay, opts.signal);
    yield { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] };
    yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] } }] };
    yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
  };
}

function completionAfter(delay: number, text: string) {
  return async (_k: string, _m: unknown, model: string, opts: { signal?: AbortSignal }) => {
    await wait(delay, opts.signal);
    return { id: 'x', object: 'chat.completion', created: 0, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
  };
}

const READ_FILE_TOOL = {
  type: 'function',
  function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
};

const errorRows = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM requests WHERE status = 'error'`).get() as { n: number }).n;
const msg = [{ role: 'user', content: 'hi' }];

describe('first-token race', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
                     VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)`).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    streamChatCompletion.mockReset();
    chatCompletion.mockReset();
    endings.length = 0;
    resetRaceState();
    resetModelFailureWindows();
    for (const t of ['rate_limit_cooldowns', 'rate_limit_usage', 'requests']) getDb().prepare(`DELETE FROM ${t}`).run();
    process.env.HERMESFLLM_RACE_MIN_DELAY_MS = '0';
    process.env.HERMESFLLM_RACE_DELAY_MS = '120';
  });

  afterEach(() => {
    delete process.env.HERMESFLLM_RACE_MIN_DELAY_MS;
    delete process.env.HERMESFLLM_RACE_DELAY_MS;
    delete process.env.HERMESFLLM_RACE;
  });

  it('a silent model is raced, the backup answers, and the silent one is cancelled without blame', async () => {
    streamChatCompletion
      .mockImplementationOnce(streamAfter(10_000, 'too late'))
      .mockImplementationOnce(streamAfter(20, 'backup answer'));

    const started = Date.now();
    const { status, raw } = await post(app, { model: 'autoTOP-hermes', stream: true, messages: msg }, key);

    expect(status).toBe(200);
    expect(content(raw)).toBe('backup answer');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const primary = endings.find(e => e.ended === 'aborted');
    expect(primary && isRaceLostError(primary.reason)).toBe(true);
    expect(errorRows()).toBe(0); // being slower than a rival is not a failure
    expect(raceStats()).toMatchObject({ races: 1, backupWins: 1, primaryWins: 0 });
  });

  it('a backup that wins answers that turn only; the next turn goes back to the session\'s own model', async () => {
    const first = [{ role: 'user', content: 'sticky check: list the files' }];
    streamChatCompletion
      .mockImplementationOnce(streamAfter(10_000, 'too late'))
      .mockImplementationOnce(streamAfter(20, 'backup answer'));
    await post(app, { model: 'autoTOP-hermes', stream: true, messages: first }, key);
    const primaryModel = endings.find(e => e.ended === 'aborted')!.model;
    const backupModel = endings.find(e => e.ended === 'answered')!.model;
    expect(backupModel).not.toBe(primaryModel);

    endings.length = 0;
    streamChatCompletion.mockImplementation(streamAfter(10, 'next turn'));
    const next = [...first, { role: 'assistant', content: 'backup answer' }, { role: 'user', content: 'and now?' }];
    await post(app, { model: 'autoTOP-hermes', stream: true, messages: next }, key);
    // The session was not handed to the backup: the next turn starts on the original pick.
    expect(endings[0].model).toBe(primaryModel);
  });

  it('a model that wins on its own still becomes the session\'s model', async () => {
    const first = [{ role: 'user', content: 'sticky check: primary wins' }];
    streamChatCompletion.mockImplementation(streamAfter(10, 'primary answer'));
    await post(app, { model: 'autoTOP-hermes', stream: true, messages: first }, key);
    const chosen = endings[0].model;
    endings.length = 0;
    const next = [...first, { role: 'assistant', content: 'primary answer' }, { role: 'user', content: 'and now?' }];
    await post(app, { model: 'autoTOP-hermes', stream: true, messages: next }, key);
    expect(endings[0].model).toBe(chosen);
  });

  it('the primary still wins if it produces its first token before the backup', async () => {
    streamChatCompletion
      .mockImplementationOnce(streamAfter(200, 'primary answer'))
      .mockImplementationOnce(streamAfter(10_000, 'backup too slow'));

    const { status, raw } = await post(app, { model: 'auto', stream: true, messages: msg }, key);

    expect(status).toBe(200);
    expect(content(raw)).toBe('primary answer');
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(endings.find(e => e.ended === 'aborted')).toBeTruthy();
    expect(raceStats()).toMatchObject({ races: 1, backupWins: 0, primaryWins: 1 });
  });

  it('a model that answers within its hedge delay never starts a backup', async () => {
    streamChatCompletion.mockImplementation(streamAfter(10, 'fast'));
    const { raw } = await post(app, { model: 'auto', stream: true, messages: msg }, key);
    expect(content(raw)).toBe('fast');
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
    expect(raceStats().races).toBe(0);
  });

  it('a model that fails fast fails over exactly as before, without a race', async () => {
    streamChatCompletion
      .mockImplementationOnce(streamFails(5, 'model stalled: no output (timeout)'))
      .mockImplementation(streamAfter(10, 'second model'));
    const { raw } = await post(app, { model: 'auto', stream: true, messages: msg }, key);
    expect(content(raw)).toBe('second model');
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(raceStats().races).toBe(0);
  });

  it('a backup that fails is booked as a failure while the primary keeps going', async () => {
    streamChatCompletion
      .mockImplementationOnce(streamAfter(400, 'primary answer'))
      .mockImplementationOnce(streamFails(20, 'model stalled: no output (timeout)'));
    const { status, raw } = await post(app, { model: 'auto', stream: true, messages: msg }, key);
    expect(status).toBe(200);
    expect(content(raw)).toBe('primary answer');
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(errorRows()).toBe(1);
    expect(raceStats()).toMatchObject({ races: 1, primaryWins: 1 });
  });

  it('when both racers fail the loop moves on to the next model', async () => {
    streamChatCompletion
      .mockImplementationOnce(streamFails(300, 'model stalled: no output (timeout)'))
      .mockImplementationOnce(streamFails(20, 'model stalled: no output (timeout)'))
      .mockImplementation(streamAfter(10, 'third model'));
    const { status, raw } = await post(app, { model: 'auto', stream: true, messages: msg }, key);
    expect(status).toBe(200);
    expect(content(raw)).toBe('third model');
    expect(streamChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(raceStats()).toMatchObject({ races: 1, bothFailed: 1 });
  });

  it('a streamed tool call from the winning backup reaches the agent exactly once', async () => {
    streamChatCompletion
      .mockImplementationOnce(streamAfter(10_000, 'too late'))
      .mockImplementationOnce(streamToolCallAfter(20));
    const { status, raw } = await post(app, { model: 'autoTOP-hermes', stream: true, tools: [READ_FILE_TOOL], messages: msg }, key);
    expect(status).toBe(200);
    expect(toolCallNames(raw)).toEqual(['read_file']);
    expect(raceStats().backupWins).toBe(1);
  });

  it('races non-streaming turns too, and returns only the winner', async () => {
    chatCompletion
      .mockImplementationOnce(completionAfter(10_000, 'too late'))
      .mockImplementationOnce(completionAfter(20, 'backup answer'));
    const { status, raw } = await post(app, { model: 'auto', messages: msg }, key);
    expect(status).toBe(200);
    expect(JSON.parse(raw).choices[0].message.content).toBe('backup answer');
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(raceStats().backupWins).toBe(1);
  });

  it('never races a model the client pinned', async () => {
    const pinned = (getDb().prepare(`SELECT model_id FROM models WHERE platform = 'groq' AND enabled = 1 LIMIT 1`).get() as { model_id: string }).model_id;
    streamChatCompletion.mockImplementation(streamAfter(300, 'pinned answer'));
    const { raw } = await post(app, { model: pinned, stream: true, messages: msg }, key);
    expect(content(raw)).toBe('pinned answer');
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
    expect(raceStats().races).toBe(0);
  });

  it('counts a winner that fails after its first token, so every race lands in one bucket', async () => {
    // The backup claims the turn with its first tool-call fragment, then calls a tool the agent never
    // declared: the Agent Guard rejects it and the loop fails over to a third model.
    const undeclaredCall = async function* (_k: string, _m: unknown, _model: string, opts: { signal?: AbortSignal }) {
      await wait(20, opts.signal);
      yield { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'delete_everything', arguments: '' } }] } }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
    };
    streamChatCompletion
      .mockImplementationOnce(streamAfter(10_000, 'too late'))
      .mockImplementationOnce(undeclaredCall)
      .mockImplementation(streamToolCallAfter(10));
    const { status, raw } = await post(app, { model: 'auto', stream: true, tools: [READ_FILE_TOOL], messages: msg }, key);
    expect(status).toBe(200);
    expect(toolCallNames(raw)).toEqual(['read_file']);
    const s = raceStats();
    expect(s).toMatchObject({ races: 1, winnerFailed: 1, backupWins: 0, primaryWins: 0, bothFailed: 0 });
    expect(s.backupWins + s.primaryWins + s.bothFailed + s.winnerFailed).toBe(s.races);
  });

  it('HERMESFLLM_RACE=0 turns it off', async () => {
    process.env.HERMESFLLM_RACE = '0';
    streamChatCompletion.mockImplementation(streamAfter(300, 'only answer'));
    const { raw } = await post(app, { model: 'auto', stream: true, messages: msg }, key);
    expect(content(raw)).toBe('only answer');
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('race delay', () => {
  beforeEach(() => {
    resetRaceState();
    getDb().prepare('DELETE FROM requests').run();
    delete process.env.HERMESFLLM_RACE_MIN_DELAY_MS;
    delete process.env.HERMESFLLM_RACE_DELAY_MS;
  });

  const insert = getDbInsert();
  function getDbInsert() {
    return (modelDbId: number, ttfb: number) => getDb().prepare(
      `INSERT INTO requests (platform, model_id, model_db_id, status, latency_ms, ttfb_ms) VALUES ('groq', 'm', ?, 'success', ?, ?)`,
    ).run(modelDbId, ttfb * 2, ttfb);
  }

  it('uses the 8s default until a model has enough history', () => {
    expect(raceDelayMs(undefined)).toBe(8_000);
    for (let i = 0; i < 5; i++) insert(901, 1_000);
    expect(raceDelayMs(901)).toBe(8_000);
  });

  it('follows the model\'s own p90 time to first token, with headroom and bounds', () => {
    for (let i = 1; i <= 20; i++) insert(902, i * 200); // 200ms .. 4000ms, p90 = 3600ms
    expect(raceDelayMs(902)).toBe(4_500);
    for (let i = 0; i < 20; i++) insert(903, 500); // fast model: clamped up to the 3s floor
    expect(raceDelayMs(903)).toBe(3_000);
    for (let i = 0; i < 20; i++) insert(904, 60_000); // slow model: capped at 15s
    expect(raceDelayMs(904)).toBe(15_000);
  });
});
