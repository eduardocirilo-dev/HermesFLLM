// HermesFLLM shadow comparison, end to end: a sampled agent turn is copied to a fake
// FreeLLMAPI, the agent only gets the HermesFLLM answer, and both are judged the same way.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
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
const { judgeAnswer, shadowConfig, shadowStats, percentile, MIN_PAIRS } = await import('../../lib/hermes-shadow.js');
const { resetRaceState } = await import('../../lib/hermes-race.js');

const BASH_TOOL = {
  type: 'function',
  function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
};
const TOOLS = [BASH_TOOL] as any;

// The fake FreeLLMAPI: records what it got, answers with whatever the test sets.
let freeAnswer: { status: number; body: string } = { status: 200, body: '' };
const freeSeen: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
const free = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    freeSeen.push({ headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(freeAnswer.status, { 'Content-Type': 'application/json' });
    res.end(freeAnswer.body);
  });
});

function sseToolCall(args: string): string {
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: args } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

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

async function pairWhenComplete(): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const row = getDb().prepare('SELECT * FROM hermes_shadow_pairs WHERE h_outcome IS NOT NULL AND f_outcome IS NOT NULL').get();
    if (row) return row;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('the pair was never completed');
}

describe('judgeAnswer', () => {
  it('judges streams and JSON bodies by the same rules', () => {
    expect(judgeAnswer(200, sseToolCall('{"command": "ls"}'), TOOLS).outcome).toBe('tool_ok');
    expect(judgeAnswer(200, sseToolCall('{"command": "ls"'), TOOLS)).toMatchObject({ outcome: 'tool_invalid', error: expect.stringMatching(/not valid JSON/) });
    expect(judgeAnswer(200, sseToolCall('{"nope": 1}'), TOOLS).outcome).toBe('tool_invalid');
    expect(judgeAnswer(200, JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), TOOLS).outcome).toBe('text');
    expect(judgeAnswer(200, JSON.stringify({ choices: [{ message: { content: '' } }] }), TOOLS).outcome).toBe('empty');
    expect(judgeAnswer(502, JSON.stringify({ error: { message: 'all models failed' } }), TOOLS)).toEqual({ outcome: 'error', error: 'all models failed' });
    expect(judgeAnswer(200, `data: ${JSON.stringify({ choices: [{ delta: { content: 'half' } }] })}\n\ndata: ${JSON.stringify({ error: { message: 'stream interrupted' } })}\n\n`, TOOLS).outcome).toBe('error');
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([7], 90)).toBe(7);
  });
});

describe('shadowConfig', () => {
  it('is off unless asked for, samples 1 in 10 by default', () => {
    expect(shadowConfig({})).toBeNull();
    expect(shadowConfig({ HERMESFLLM_SHADOW: '1' })).toMatchObject({ rate: 0.1, url: 'http://127.0.0.1:3001', timeoutMs: 300_000 });
    expect(shadowConfig({ HERMESFLLM_SHADOW: 'on', HERMESFLLM_SHADOW_RATE: '0', HERMESFLLM_SHADOW_URL: 'http://x:9/' })).toMatchObject({ rate: 0, url: 'http://x:9' });
  });
});

describe('shadow comparison', () => {
  let app: Express;
  let key: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
                     VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)`).run(encrypted, iv, authTag);
    await new Promise<void>(resolve => free.listen(0, '127.0.0.1', () => resolve()));
  });

  afterAll(() => { free.close(); });

  beforeEach(() => {
    streamChatCompletion.mockReset();
    freeSeen.length = 0;
    for (const t of ['rate_limit_cooldowns', 'rate_limit_usage', 'requests', 'hermes_shadow_pairs']) getDb().prepare(`DELETE FROM ${t}`).run();
    resetModelFailureWindows();
    process.env.HERMESFLLM_RACE = '0';
    process.env.HERMESFLLM_SHADOW = '1';
    process.env.HERMESFLLM_SHADOW_RATE = '1';
    process.env.HERMESFLLM_SHADOW_URL = `http://127.0.0.1:${(free.address() as any).port}`;
    streamChatCompletion.mockImplementation(async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command": "ls"}' } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
    });
  });

  afterEach(() => {
    for (const k of ['HERMESFLLM_RACE', 'HERMESFLLM_SHADOW', 'HERMESFLLM_SHADOW_RATE', 'HERMESFLLM_SHADOW_URL']) delete process.env[k];
  });

  const turn = { model: 'autoTOP-hermes', stream: true, tools: [BASH_TOOL], messages: [{ role: 'user', content: 'list the files' }] };

  it('copies a sampled turn to FreeLLMAPI, gives the agent only the HermesFLLM answer, and judges both', async () => {
    freeAnswer = { status: 200, body: JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'x', type: 'function', function: { name: 'Bash', arguments: '{"cmd": "ls"}' } }] } }] }) };
    const { status, raw } = await post(app, turn, key);
    expect(status).toBe(200);
    expect(raw).toContain('{\\"command\\": \\"ls\\"}'); // HermesFLLM's call, not FreeLLMAPI's
    expect(raw).not.toContain('cmd');

    const pair = await pairWhenComplete();
    expect(pair).toMatchObject({ h_outcome: 'tool_ok', h_status: 200, f_outcome: 'tool_invalid', f_status: 200 });
    expect(pair.h_ttfb_ms).toBeGreaterThanOrEqual(0);

    // Same request, FreeLLMAPI's own router pick, marked so it is never mirrored again.
    expect(freeSeen).toHaveLength(1);
    expect(freeSeen[0].body).toMatchObject({ model: 'auto', messages: turn.messages, tools: turn.tools, stream: true });
    expect(freeSeen[0].headers['x-hermesfllm-shadow']).toBe('1');
    expect(freeSeen[0].headers.authorization).toBe(`Bearer ${key}`);

    const stats = shadowStats();
    expect(stats).toMatchObject({ enabled: true, pairs: 1 });
    expect(stats.hermes).toMatchObject({ validToolCallRate: 1, noAnswerRate: 0, ttfbNotRaced: { n: 1 }, ttfbRaced: { n: 0 } });
    expect(stats.freellmapi).toMatchObject({ validToolCallRate: 0, noAnswerRate: 0, ttfb: { n: 1 } });
    // One pair decides nothing.
    expect(stats.winners).toEqual({ validToolCall: null, ttfbP50: null, ttfbP90: null, noAnswer: null });
  });

  it('marks a turn where the first-token race launched a backup', async () => {
    delete process.env.HERMESFLLM_RACE;
    process.env.HERMESFLLM_RACE_MIN_DELAY_MS = '0';
    process.env.HERMESFLLM_RACE_DELAY_MS = '100';
    resetRaceState();
    freeAnswer = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
    streamChatCompletion
      .mockImplementationOnce(async function* (_k: string, _m: unknown, _id: string, opts: { signal?: AbortSignal }) {
        await new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(opts.signal!.reason), { once: true }));
        yield { choices: [] }; // never reached: the wait above only ends by rejecting
      })
      .mockImplementationOnce(async function* () {
        yield { choices: [{ delta: { content: 'backup answer' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      });
    try {
      const { raw } = await post(app, turn, key);
      expect(raw).toContain('backup answer');
      expect(await pairWhenComplete()).toMatchObject({ h_outcome: 'text', h_raced: 1 });
      expect(shadowStats().hermes.ttfbRaced.n).toBe(1);
    } finally {
      delete process.env.HERMESFLLM_RACE_MIN_DELAY_MS;
      delete process.env.HERMESFLLM_RACE_DELAY_MS;
    }
  });

  it('decides each metric once the sample is big enough', () => {
    const insert = getDb().prepare(`INSERT INTO hermes_shadow_pairs (request_id, h_outcome, h_status, h_ttfb_ms, h_latency_ms, f_outcome, f_status, f_ttfb_ms, f_latency_ms)
                                    VALUES (?, ?, 200, ?, 1000, ?, 200, ?, 1000)`);
    for (let i = 0; i < MIN_PAIRS; i++) {
      // HermesFLLM: always a valid call, 1s to first token. FreeLLMAPI: every third turn broken, 0.5s.
      insert.run(`p${i}`, 'tool_ok', 1000, i % 3 === 0 ? 'error' : 'tool_ok', 500);
    }
    const stats = shadowStats();
    expect(stats.pairs).toBe(MIN_PAIRS);
    expect(stats.freellmapi.noAnswerRate).toBeCloseTo(10 / 30);
    expect(stats.winners).toEqual({ validToolCall: 'hermes', ttfbP50: 'freellmapi', ttfbP90: 'freellmapi', noAnswer: 'hermes' });
  });

  it('an error on the FreeLLMAPI side counts against it', async () => {
    freeAnswer = { status: 502, body: JSON.stringify({ error: { message: 'All models failed' } }) };
    await post(app, turn, key);
    expect(await pairWhenComplete()).toMatchObject({ h_outcome: 'tool_ok', f_outcome: 'error', f_status: 502, f_error: 'All models failed' });
  });

  it('FreeLLMAPI not running is kept out of the comparison', async () => {
    const closed = http.createServer();
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', () => resolve()));
    const port = (closed.address() as any).port;
    await new Promise(resolve => closed.close(resolve));
    process.env.HERMESFLLM_SHADOW_URL = `http://127.0.0.1:${port}`;
    await post(app, turn, key);
    expect(await pairWhenComplete()).toMatchObject({ h_outcome: 'tool_ok', f_outcome: 'unreachable' });
    expect(shadowStats()).toMatchObject({ pairs: 0, unreachable: 1 });
  });

  it('leaves turns without tools, already-mirrored turns, and unsampled turns alone', async () => {
    streamChatCompletion.mockImplementation(async function* () {
      yield { choices: [{ delta: { content: 'hi' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    });
    await post(app, { ...turn, tools: undefined }, key);
    process.env.HERMESFLLM_SHADOW_RATE = '0';
    await post(app, turn, key);
    await new Promise(r => setTimeout(r, 100));
    expect(freeSeen).toHaveLength(0);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM hermes_shadow_pairs').get()).toEqual({ n: 0 });
  });

  it('stays off by default', async () => {
    delete process.env.HERMESFLLM_SHADOW;
    await post(app, turn, key);
    await new Promise(r => setTimeout(r, 100));
    expect(freeSeen).toHaveLength(0);
    expect(shadowStats()).toMatchObject({ enabled: false, pairs: 0 });
  });
});
