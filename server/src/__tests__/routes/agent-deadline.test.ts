// HermesFLLM agent deadline: a streaming attempt that sends nothing in time is cancelled and
// the turn fails over to the next model, without the client seeing an error. Covers attempt 0,
// which the upstream time-budget hedge exempts on purpose.

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

/** A model that never sends anything, until its request is cancelled. */
function silentUntilAborted() {
  return async function* (_k: string, _m: unknown, _id: string, opts: { signal?: AbortSignal }) {
    await new Promise((_, reject) => {
      const s = opts.signal;
      if (s?.aborted) return reject(s.reason);
      s?.addEventListener('abort', () => reject(s.reason ?? new Error('aborted')), { once: true });
    });
    yield { choices: [{ delta: { content: 'never' } }] };
  };
}

function answers(text: string) {
  return async function* () {
    yield { choices: [{ delta: { content: text } }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  };
}

describe('agent deadline', () => {
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
    process.env.HERMESFLLM_ATTEMPT_DEADLINE_MS = '150';
  });

  afterEach(() => { delete process.env.HERMESFLLM_ATTEMPT_DEADLINE_MS; });

  it('fails a silent first attempt over to the next model, invisibly', async () => {
    streamChatCompletion
      .mockImplementationOnce(silentUntilAborted())
      .mockImplementation(answers('ok from the second model'));

    const started = Date.now();
    const { status, raw } = await post(app, { model: 'autoTOP-hermes', stream: true, messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(content(raw)).toBe('ok from the second model');
    expect(raw).not.toContain('agent deadline');
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not cut off a model that answers within the deadline', async () => {
    streamChatCompletion.mockImplementation(answers('fast answer'));
    const { status, raw } = await post(app, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }, key);
    expect(status).toBe(200);
    expect(content(raw)).toBe('fast answer');
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('can be disabled', async () => {
    process.env.HERMESFLLM_ATTEMPT_DEADLINE_MS = '0';
    let release: () => void = () => {};
    streamChatCompletion.mockImplementation(async function* () {
      await new Promise<void>(r => { release = r; setTimeout(r, 400); });
      yield { choices: [{ delta: { content: 'slow but kept' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    });
    const { raw } = await post(app, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }, key);
    void release;
    expect(content(raw)).toBe('slow but kept');
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
  });
});
