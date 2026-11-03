// HermesFLLM Turn Governor, end to end through /v1/chat/completions: a turn that freezes or
// loops after its first token fails over invisibly (or, once the agent is receiving it, ends
// cleanly), and a late rescue still leaves the ladder models to try.

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

const BASH_TOOL = {
  type: 'function',
  function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
};

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

function read(raw: string): { content: string; toolCalls: any[]; streamError: boolean } {
  let content = '';
  const toolCalls: any[] = [];
  let streamError = false;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    let chunk: any;
    try { chunk = JSON.parse(line.slice(6)); } catch { continue; }
    if (chunk.error) streamError = true;
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === 'string') content += delta.content;
    if (delta?.tool_calls) toolCalls.push(...delta.tool_calls);
  }
  return { content, toolCalls, streamError };
}

function waitAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });
}

const toolStart = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"comm' } }] } }] };

/** Starts a tool call, then freezes until cancelled. */
function toolCallThenFreeze() {
  return async function* (_k: string, _m: unknown, _id: string, opts: { signal?: AbortSignal }) {
    yield toolStart;
    await waitAbort(opts.signal);
  };
}

/** Starts a tool call, then repeats the same fragment forever (a degenerate loop). */
function toolCallLoop() {
  return async function* (_k: string, _m: unknown, _id: string, opts: { signal?: AbortSignal }) {
    yield toolStart;
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'echo retry; '.repeat(40) } }] } }] };
      await new Promise(r => setImmediate(r));
    }
  };
}

/** Streams a long, valid tool call steadily, with varied text, for `ms` (never stalls or loops). */
function slowSteadyToolCall(ms: number) {
  return async function* (_k: string, _m: unknown, _id: string, opts: { signal?: AbortSignal }) {
    yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command": "' } }] } }] };
    const until = Date.now() + ms;
    let i = 0;
    while (Date.now() < until) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `step ${i} ${(i * 104729).toString(36)} ` } }] } }] };
      i++;
      await new Promise(r => setTimeout(r, 40));
    }
    yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] };
    yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
  };
}

/** Sends prose (the agent starts receiving it), then freezes until cancelled. */
function proseThenFreeze() {
  return async function* (_k: string, _m: unknown, _id: string, opts: { signal?: AbortSignal }) {
    yield { choices: [{ delta: { content: 'Here is the plan: first I will read the file.' } }] };
    await waitAbort(opts.signal);
  };
}

function answers(text: string) {
  return async function* () {
    yield { choices: [{ delta: { content: text } }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  };
}

describe('Turn Governor', () => {
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
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    getDb().prepare('DELETE FROM rate_limit_usage').run();
    getDb().prepare('DELETE FROM requests').run();
    resetModelFailureWindows();
    process.env.HERMESFLLM_RACE = '0'; // isolate from the first-token race
    process.env.HERMESFLLM_STALL_MS = '150';
    process.env.HERMESFLLM_COMMITTED_STALL_MS = '150';
  });

  afterEach(() => {
    for (const k of ['HERMESFLLM_RACE', 'HERMESFLLM_STALL_MS', 'HERMESFLLM_COMMITTED_STALL_MS', 'HERMESFLLM_TURN_CEILING_MS', 'HERMESFLLM_GOVERNOR', 'FALLBACK_TIME_BUDGET_MS']) {
      delete process.env[k];
    }
  });

  const turn = (model = 'autoTOP-hermes') => ({ model, stream: true, tools: [BASH_TOOL], messages: [{ role: 'user', content: 'list the files' }] });

  it('a tool call that freezes after its first token fails over invisibly', async () => {
    streamChatCompletion.mockImplementationOnce(toolCallThenFreeze()).mockImplementation(answers('ok from the second model'));
    const started = Date.now();
    const { status, raw } = await post(app, turn(), key);
    const out = read(raw);
    expect(status).toBe(200);
    expect(out.content).toBe('ok from the second model');
    expect(out.toolCalls).toEqual([]); // the frozen half-call never reached the agent
    expect(out.streamError).toBe(false);
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(6_000);
    const failed = getDb().prepare(`SELECT error FROM requests WHERE status = 'error' AND error LIKE '%agent governor%'`).get() as { error: string };
    expect(failed.error).toMatch(/agent governor: .* stopped making progress/);
  });

  it('a looping model is cut off and the turn fails over', async () => {
    streamChatCompletion.mockImplementationOnce(toolCallLoop()).mockImplementation(answers('clean answer'));
    const { status, raw } = await post(app, turn(), key);
    expect(status).toBe(200);
    expect(read(raw).content).toBe('clean answer');
    const failed = getDb().prepare(`SELECT error FROM requests WHERE status = 'error' AND error LIKE '%agent governor%'`).get() as { error: string };
    expect(failed.error).toMatch(/is looping/);
  });

  it('a long but steady tool call is never cut by the stall rule', { timeout: 15_000 }, async () => {
    streamChatCompletion.mockImplementation(slowSteadyToolCall(1_500));
    const { status, raw } = await post(app, turn(), key);
    expect(status).toBe(200);
    const out = read(raw);
    expect(out.toolCalls).toHaveLength(1);
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('the turn ceiling fails over a turn that sends nothing to the agent for too long', async () => {
    process.env.HERMESFLLM_TURN_CEILING_MS = '300';
    streamChatCompletion.mockImplementationOnce(slowSteadyToolCall(5_000)).mockImplementation(answers('within the ceiling'));
    const { status, raw } = await post(app, turn(), key);
    expect(status).toBe(200);
    expect(read(raw).content).toBe('within the ceiling');
    const failed = getDb().prepare(`SELECT error FROM requests WHERE status = 'error' AND error LIKE '%agent governor%'`).get() as { error: string };
    expect(failed.error).toMatch(/exceeded the turn ceiling/);
  });

  it('a stream the agent is already receiving ends cleanly instead of hanging', async () => {
    streamChatCompletion.mockImplementation(proseThenFreeze());
    const started = Date.now();
    const { status, raw } = await post(app, { ...turn(), tools: undefined }, key);
    const out = read(raw);
    expect(status).toBe(200);
    expect(out.content).toBe('Here is the plan: first I will read the file.');
    expect(out.streamError).toBe(true); // the agent sees an error and retries
    expect(raw.trim().endsWith('data: [DONE]')).toBe(true);
    expect(Date.now() - started).toBeLessThan(6_000);
    const failed = getDb().prepare(`SELECT error FROM requests WHERE status = 'error' AND error LIKE '%agent governor%'`).get() as { error: string };
    expect(failed.error).toMatch(/agent governor/);
  });

  it('a late rescue gets a fresh retry budget, so the ladder can still reach a working model', async () => {
    process.env.FALLBACK_TIME_BUDGET_MS = '200';
    streamChatCompletion
      .mockImplementationOnce(toolCallThenFreeze()) // rescued after ~1s, well past the 200ms budget
      // A fast, model-scoped failure (the Agent Guard rejects a call missing `command`).
      .mockImplementationOnce(async function* () {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: 'Bash', arguments: '{"nope": 1}' } }] } }] };
        yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
      })
      .mockImplementation(answers('third model answered'));
    const { status, raw } = await post(app, turn(), key);
    expect(status).toBe(200);
    expect(read(raw).content).toBe('third model answered');
    expect(streamChatCompletion).toHaveBeenCalledTimes(3);
  });

  it('can be switched off', async () => {
    process.env.HERMESFLLM_GOVERNOR = '0';
    let release!: () => void;
    streamChatCompletion.mockImplementation(async function* () {
      yield toolStart;
      await new Promise<void>(r => { release = r; setTimeout(r, 1_300); });
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and": "ls"}' } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
    });
    const { status, raw } = await post(app, turn(), key);
    void release;
    // toolStart + 'and": "ls"}' = {"command": "ls"} — a valid call, delivered after a 1.3s freeze.
    expect(status).toBe(200);
    expect(read(raw).toolCalls).toHaveLength(1);
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
  });
});
