// HermesFLLM sealed turns, end to end through /v1/chat/completions: a model that talks before it
// acts can still fail over invisibly, a broken or inline tool call never reaches Hermes as a final
// answer, long answers still stream, and failures after a release are booked so Hermes' retry goes
// to another model. HERMESFLLM_SEAL=0 and non-Hermes clients keep the upstream behaviour.

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
const { setRoutingStrategy, clearAllPenalties } = await import('../../services/router.js');
const { resetModelFailureWindows } = await import('../../lib/fallback-loop.js');
const { resetRaceState } = await import('../../lib/hermes-race.js');
const { clearAllCooldowns } = await import('../../services/ratelimit.js');
const { resetSealState, sealStats } = await import('../../lib/hermes-seal.js');
const { buildSealBoard } = await import('../../routes/curation.js');
const { resetCurationState } = await import('../../services/curation.js');

const BASH_TOOL = {
  type: 'function',
  function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
};

async function post(app: Express, body: any, key: string, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  return { status: res.status, raw, seal: res.headers.get('x-hermesfllm-seal') };
}

function read(raw: string) {
  let content = '';
  const toolCalls: any[] = [];
  let streamError = false;
  let finish: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    let chunk: any;
    try { chunk = JSON.parse(line.slice(6)); } catch { continue; }
    if (chunk.error) streamError = true;
    const choice = chunk.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (choice?.delta?.tool_calls) toolCalls.push(...choice.delta.tool_calls);
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  return { content, toolCalls, streamError, finish };
}

function waitAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });
}

const prose = (content: string) => ({ choices: [{ delta: { content } }] });
const call = (name: string, args: string, id = 'c1') => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] });
const finish = (reason: string) => ({ choices: [{ delta: {}, finish_reason: reason }] });
const LONG = 'The answer, in detail. '.repeat(45); // ~1,000 characters

/** A turn scripted as a list of frames; 'freeze' waits until the attempt is cancelled. */
function script(...frames: Array<object | 'freeze'>) {
  return async function* (_k: string, _m: unknown, _id: string, opts: { signal?: AbortSignal }) {
    for (const f of frames) {
      if (f === 'freeze') { await waitAbort(opts.signal); continue; }
      yield f;
    }
  };
}

/** Records the model each streamed call went to, in order. */
const calledModels = () => streamChatCompletion.mock.calls.map(c => c[2] as string);

describe('sealed turns', () => {
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
    const db = getDb();
    for (const t of ['rate_limit_cooldowns', 'rate_limit_usage', 'request_attempts', 'requests', 'model_probe_status']) db.prepare(`DELETE FROM ${t}`).run();
    resetModelFailureWindows();
    clearAllPenalties();
    clearAllCooldowns();
    resetRaceState();
    resetSealState();
    resetCurationState();
    process.env.HERMESFLLM_RACE = '0';
    // The two regimes are told apart by time: 150ms before anything reached the agent, 5s after.
    process.env.HERMESFLLM_STALL_MS = '150';
    process.env.HERMESFLLM_COMMITTED_STALL_MS = '5000';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ['HERMESFLLM_RACE', 'HERMESFLLM_STALL_MS', 'HERMESFLLM_COMMITTED_STALL_MS', 'HERMESFLLM_SEAL', 'FALLBACK_TIME_BUDGET_MS']) delete process.env[k];
  });

  const turn = (model = 'autoTOP-hermes') => ({ model, stream: true, tools: [BASH_TOOL], messages: [{ role: 'user', content: 'list the files' }] });
  const sealedErrors = () => getDb().prepare(`SELECT error FROM requests WHERE status = 'error' AND error LIKE '%[sealed]'`).all() as Array<{ error: string }>;

  it('prose and then a call to an undeclared tool: the next model answers, the broken half-turn never reaches Hermes', async () => {
    streamChatCompletion
      .mockImplementationOnce(script(prose('I will list the files now.'), call('read_terminal', '{}'), finish('tool_calls')))
      .mockImplementation(script(call('Bash', '{"command":"ls"}'), finish('tool_calls')));
    const { status, raw, seal } = await post(app, turn(), key);
    const out = read(raw);
    expect(status).toBe(200);
    expect(out.content).toBe(''); // the first model's prose was never sent
    expect(out.toolCalls.map(c => c.function.name)).toEqual(['Bash']);
    expect(out.finish).toBe('tool_calls');
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(seal).toBe('sealed; 1 rescued');
    expect(sealedErrors()).toHaveLength(1);
    expect(sealedErrors()[0].error).toMatch(/agent guard: .*\[sealed\]$/);
    expect(buildSealBoard()).toMatchObject({ rescued24h: 1, byKind24h: { guard: 1 }, visibleFailures24h: 0 });
    expect(sealStats().rescued.guard).toBe(1);
  });

  it('prose and then a freeze: fails over within the pre-commit stall rule, with no stream_error', async () => {
    streamChatCompletion
      .mockImplementationOnce(script(prose('Let me check the directory first.'), 'freeze'))
      .mockImplementation(script(call('Bash', '{"command":"ls"}'), finish('tool_calls')));
    const started = Date.now();
    const { raw, seal } = await post(app, turn(), key);
    const out = read(raw);
    expect(Date.now() - started).toBeLessThan(2_500); // the committed regime would take 5s
    expect(out.streamError).toBe(false);
    expect(out.content).toBe('');
    expect(out.toolCalls).toHaveLength(1);
    expect(seal).toBe('sealed; 1 rescued');
    expect(sealedErrors()[0].error).toMatch(/stopped making progress.*\[sealed\]$/);
    expect(buildSealBoard().byKind24h.stall).toBe(1);
  });

  it('an inline <tool_call> written after prose is rescued into a structured call instead of leaking as text', async () => {
    streamChatCompletion.mockImplementation(script(
      prose('Let me look. '),
      prose('<tool_call>{"name": "Bash", "arguments": {"command": "ls -la"}}</tool_call>'),
      finish('stop'),
    ));
    const { raw } = await post(app, turn(), key);
    const out = read(raw);
    expect(out.content).not.toContain('<tool_call>');
    expect(out.toolCalls.map(c => JSON.parse(c.function.arguments))).toEqual([{ command: 'ls -la' }]);
    expect(out.finish).toBe('tool_calls');
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('a broken call with no prose fails over exactly as before and is not counted as a seal rescue', async () => {
    streamChatCompletion
      .mockImplementationOnce(script(call('read_terminal', '{}'), finish('tool_calls')))
      .mockImplementation(script(call('Bash', '{"command":"ls"}'), finish('tool_calls')));
    const { raw, seal } = await post(app, turn(), key);
    expect(read(raw).toolCalls).toHaveLength(1);
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(seal).toBe('sealed');
    expect(sealedErrors()).toHaveLength(0);
  });

  it('a short answer arrives whole; a long one is released and streams, unchanged', async () => {
    streamChatCompletion.mockImplementationOnce(script(prose('All done.'), finish('stop')));
    const short = await post(app, turn(), key);
    expect(short.seal).toBe('sealed');
    expect(read(short.raw)).toMatchObject({ content: 'All done.', finish: 'stop' });

    const pieces = LONG.match(/.{1,100}/gs)!;
    streamChatCompletion.mockImplementationOnce(script(...pieces.map(prose), finish('stop')));
    const long = await post(app, turn(), key);
    expect(long.seal).toBe('released (answer)');
    expect(read(long.raw)).toMatchObject({ content: LONG, finish: 'stop' });
    expect(sealStats()).toMatchObject({ turns: 2, whole: 1, held: 1, released: { answer: 1, valve: 0 } });
  });

  it('after a release, a broken call ends with a retryable error instead of a silent stop, and the next request avoids that model', async () => {
    streamChatCompletion.mockImplementationOnce(script(prose(LONG), call('read_terminal', '{}'), finish('tool_calls')));
    const first = await post(app, turn(), key);
    const out = read(first.raw);
    expect(first.seal).toBe('released (answer)');
    expect(out.streamError).toBe(true);
    expect(out.finish).toBeNull(); // never a final 'stop' Hermes would read as the answer
    const failed = calledModels()[0];
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns WHERE model_id = ?').get(failed) as { n: number }).n).toBe(1);
    expect(buildSealBoard().visibleFailures24h).toBe(1);

    streamChatCompletion.mockImplementation(script(call('Bash', '{"command":"ls"}'), finish('tool_calls')));
    const retry = await post(app, turn(), key);
    expect(read(retry.raw).toolCalls).toHaveLength(1);
    expect(calledModels()[1]).not.toBe(failed);
  });

  it('after a release, a freeze is booked too, so Hermes\' retry goes to another model', async () => {
    process.env.HERMESFLLM_COMMITTED_STALL_MS = '300';
    streamChatCompletion.mockImplementationOnce(script(prose(LONG), 'freeze'));
    const first = await post(app, turn(), key);
    expect(read(first.raw).streamError).toBe(true);
    const failed = calledModels()[0];

    streamChatCompletion.mockImplementation(script(call('Bash', '{"command":"ls"}'), finish('tool_calls')));
    await post(app, turn(), key);
    expect(calledModels()[1]).not.toBe(failed);
  });

  it('Hermes\' long reasoning stays held, so a model that freezes after 16s of thinking still fails over invisibly', async () => {
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    streamChatCompletion
      .mockImplementationOnce(async function* (_k: string, _m: unknown, _id: string, opts: { signal?: AbortSignal }) {
        yield { choices: [{ delta: { reasoning_content: 'thinking about it ' } }] };
        skew += 16_000; // past the 15s reasoning commit of the old rule
        yield { choices: [{ delta: { reasoning_content: 'still thinking' } }] };
        await waitAbort(opts.signal);
      })
      .mockImplementation(script(call('Bash', '{"command":"ls"}'), finish('tool_calls')));
    const { raw, seal } = await post(app, turn(), key);
    const out = read(raw);
    expect(out.streamError).toBe(false);
    expect(out.toolCalls).toHaveLength(1);
    expect(seal).toBe('sealed; 1 rescued');
  });

  it('the valve releases a turn still producing after a minute, so the uncommitted ceiling never cuts it', async () => {
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    streamChatCompletion.mockImplementation(async function* () {
      yield prose('Let me write the whole module. ');
      skew += 61_000;
      yield call('Bash', '{"command":"ls"}');
      yield finish('tool_calls');
    });
    const { raw, seal } = await post(app, turn(), key);
    const out = read(raw);
    expect(seal).toBe('released (valve)');
    expect(out.content).toBe('Let me write the whole module. ');
    expect(out.toolCalls).toHaveLength(1);
    expect(sealStats().released.valve).toBe(1);
  });

  it('a sealed attempt that keeps producing is not cancelled by the retry-time budget', async () => {
    process.env.FALLBACK_TIME_BUDGET_MS = '300';
    streamChatCompletion
      .mockImplementationOnce(script(call('read_terminal', '{}'), finish('tool_calls')))
      .mockImplementationOnce(script(call('read_terminal', '{}'), finish('tool_calls')))
      .mockImplementationOnce(async function* (_k: string, _m: unknown, _id: string, opts: { signal?: AbortSignal }) {
        for (let i = 0; i < 12; i++) {
          if (opts.signal?.aborted) throw opts.signal.reason; // as a real provider's fetch would
          yield prose(`step ${i} of a careful plan. `);
          await new Promise(r => setTimeout(r, 60));
        }
        yield call('Bash', '{"command":"ls"}');
        yield finish('tool_calls');
      })
      .mockImplementation(script(prose('a fourth model'), finish('stop')));
    const { raw } = await post(app, turn(), key);
    const out = read(raw);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.content).toContain('step 11 of a careful plan.');
    expect(streamChatCompletion).toHaveBeenCalledTimes(3);
  });

  it('HERMESFLLM_SEAL=0 restores the upstream behaviour exactly', async () => {
    process.env.HERMESFLLM_SEAL = '0';
    process.env.HERMESFLLM_COMMITTED_STALL_MS = '300';
    streamChatCompletion.mockImplementationOnce(script(prose('I will list the files now.'), call('read_terminal', '{}'), finish('tool_calls')));
    const spliced = await post(app, turn(), key);
    expect(spliced.seal).toBeNull();
    expect(read(spliced.raw)).toMatchObject({ content: 'I will list the files now.', finish: 'stop', toolCalls: [] });

    streamChatCompletion.mockImplementationOnce(script(prose('Let me check.'), 'freeze'));
    const frozen = await post(app, turn(), key);
    expect(read(frozen.raw)).toMatchObject({ content: 'Let me check.', streamError: true });
    expect(sealedErrors()).toHaveLength(0);
  });

  it('other clients keep the upstream behaviour: an `auto` request from a generic SDK is not sealed', async () => {
    streamChatCompletion.mockImplementationOnce(script(prose('I will list the files now.'), call('read_terminal', '{}'), finish('tool_calls')));
    const { raw, seal } = await post(app, turn('auto'), key, { 'User-Agent': 'OpenAI/JS 4.0.0' });
    expect(seal).toBeNull();
    expect(read(raw)).toMatchObject({ content: 'I will list the files now.', finish: 'stop' });
  });

  it('a hermes-agent client on plain `auto` is sealed too', async () => {
    streamChatCompletion
      .mockImplementationOnce(script(prose('I will list the files now.'), call('read_terminal', '{}'), finish('tool_calls')))
      .mockImplementation(script(call('Bash', '{"command":"ls"}'), finish('tool_calls')));
    const { raw, seal } = await post(app, turn('auto'), key, { 'User-Agent': 'hermes-agent' });
    expect(seal).toBe('sealed; 1 rescued');
    expect(read(raw).content).toBe('');
  });

  it('requests without tools are never sealed', async () => {
    streamChatCompletion.mockImplementationOnce(script(prose('Hello there.'), finish('stop')));
    const { seal } = await post(app, { ...turn(), tools: undefined }, key);
    expect(seal).toBeNull();
  });
});
