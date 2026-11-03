// HermesFLLM curation fails open: models whose recent probes all failed go to the back of the chain
// instead of being dropped, so a turn is never refused while untried models remain.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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
const { resetCurationCache, isCuratedOut } = await import('../../services/curation.js');

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

function answer(_k: string, _m: unknown, model: string) {
  return Promise.resolve({ id: 'x', object: 'chat.completion', created: 0, model, choices: [{ index: 0, message: { role: 'assistant', content: `from ${model}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
}

/** Records a fresh failed curation probe for each model, so curation excludes them. */
function exclude(modelIds: string[]) {
  const ins = getDb().prepare(`INSERT OR REPLACE INTO model_probe_status (platform, model_id, endpoint_scope, key_id, status, last_probed_at, last_error)
                               VALUES ('groq', ?, '', 1, 'unavailable', ?, 'no valid tool call')`);
  for (const id of modelIds) ins.run(id, new Date().toISOString());
  resetCurationCache();
}

const groqModels = () => (getDb().prepare(`SELECT model_id FROM models WHERE platform = 'groq' AND enabled = 1 AND endpoint_scope = ''`).all() as Array<{ model_id: string }>).map(r => r.model_id);

describe('curation fails open', () => {
  let app: Express;
  let key: string;
  const warn = vi.spyOn(console, 'warn');

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.HERMESFLLM_RACE = '0';
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    getDb().prepare(`INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
                     VALUES (1, 'groq', 'test', ?, ?, ?, 'healthy', 1)`).run(encrypted, iv, authTag);
  });

  afterAll(() => { delete process.env.HERMESFLLM_RACE; });

  beforeEach(() => {
    chatCompletion.mockReset().mockImplementation(answer);
    warn.mockClear();
    resetModelFailureWindows();
    for (const t of ['rate_limit_cooldowns', 'rate_limit_usage', 'requests', 'model_probe_status']) getDb().prepare(`DELETE FROM ${t}`).run();
    resetCurationCache();
  });

  it('serves the turn when curation has excluded every model, instead of a 502', async () => {
    const all = groqModels();
    expect(all.length).toBeGreaterThan(1);
    exclude(all);
    expect(all.every(id => isCuratedOut({ platform: 'groq', model_id: id, endpoint_scope: '' }))).toBe(true);

    const { status, raw } = await post(app, { model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(JSON.parse(raw).choices[0].message.content).toMatch(/^from /);
    expect(warn.mock.calls.some(c => String(c[0]).includes('[Curation] fail-open'))).toBe(true);
  });

  it('still prefers a model curation has not excluded', async () => {
    const all = groqModels();
    const healthy = all[all.length - 1]; // last in priority order, so only exclusion can move it first
    exclude(all.filter(id => id !== healthy));

    const { status, raw } = await post(app, { model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(JSON.parse(raw).choices[0].message.content).toBe(`from ${healthy}`);
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some(c => String(c[0]).includes('[Curation] fail-open'))).toBe(false);
  });
});
