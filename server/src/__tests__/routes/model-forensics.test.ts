// HermesFLLM model forensics: time lost per model on failed attempts, by cause, and the dashboard
// demotion that acts on it without editing .env or restarting.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { buildForensics } from '../../routes/curation.js';
import { resetDemotionCache, demotionFactor } from '../../lib/hermes-demotions.js';
import { mintDashboardToken } from '../helpers/auth.js';

let app: Express;
let token: string;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  token = mintDashboardToken();
});

beforeEach(() => {
  getDb().prepare('DELETE FROM requests').run();
  getDb().prepare("DELETE FROM settings WHERE key = 'hermesfllm_model_demotions'").run();
  resetDemotionCache();
});

function request(platform: string, modelId: string, status: 'success' | 'error' | 'canceled', latency: number, error: string | null = null) {
  getDb().prepare(`INSERT INTO requests (platform, model_id, status, latency_ms, ttfb_ms, error) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(platform, modelId, status, latency, status === 'success' ? Math.round(latency / 2) : null, error);
}

async function call(method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: json };
}

describe('buildForensics', () => {
  it('ranks models by time the agent lost on their failed attempts, split by cause', () => {
    // The production pattern: a model that answers often but stalls mid-turn now and then.
    for (let i = 0; i < 5; i++) request('nvidia', 'laguna', 'success', 4_000);
    for (let i = 0; i < 3; i++) request('nvidia', 'laguna', 'error', 31_000, 'agent governor: Laguna stopped making progress — under 32 new characters in 30s (timeout), failing over');
    request('nvidia', 'laguna', 'error', 5_000, 'invalid tool arguments from Laguna (agent guard: read_file: not a declared tool)');
    // Fast quota failures cost little time.
    for (let i = 0; i < 10; i++) request('groq', 'llama', 'success', 1_000);
    request('groq', 'llama', 'error', 800, 'Groq API error 429: rate limit reached');
    request('groq', 'llama', 'error', 2_000, 'fetch failed: ECONNRESET');
    // Clean models and canceled requests stay out.
    for (let i = 0; i < 4; i++) request('google', 'gemini', 'success', 2_000);
    request('google', 'gemini', 'canceled', 60_000, 'client disconnected');

    const f = buildForensics();

    expect(f.models.map(m => m.modelId)).toEqual(['laguna', 'llama']);
    expect(f.models[0]).toMatchObject({
      platform: 'nvidia', requests: 9, successes: 5, failed: 4, wastedMs: 98_000, avgFirstMs: 2_000,
      causes: { stall: 3, runaway: 0, guard: 1, deadline: 0, rateLimit: 0, other: 0 },
      demotion: null,
    });
    expect(f.models[1]).toMatchObject({ wastedMs: 2_800, causes: { rateLimit: 1, other: 1 } });
    expect(f.totalWastedMs).toBe(100_800);
    expect(f.totalFailed).toBe(6);
  });

  it('is empty when nothing failed', () => {
    request('google', 'gemini', 'success', 2_000);
    expect(buildForensics()).toEqual({ totalWastedMs: 0, totalFailed: 0, models: [] });
  });
});

describe('dashboard demotions', () => {
  it('demotes a model from the board, shows it in the forensics, and restores it', async () => {
    request('nvidia', 'laguna', 'error', 31_000, 'agent governor: Laguna stopped making progress — under 32 new characters in 30s (timeout), failing over');

    const put = await call('PUT', '/api/curation/demotions', { modelId: 'laguna', demote: true });
    expect(put.status).toBe(200);
    expect(put.body.demotions).toEqual({ laguna: 0.4 });
    expect(demotionFactor('laguna')).toBe(0.4);

    const get = await call('GET', '/api/curation/forensics');
    expect(get.status).toBe(200);
    expect(get.body.models[0]).toMatchObject({ modelId: 'laguna', demotion: 0.4 });

    // Survives a restart: it is read back from settings, not memory.
    resetDemotionCache();
    expect(demotionFactor('laguna')).toBe(0.4);

    const restore = await call('PUT', '/api/curation/demotions', { modelId: 'laguna', demote: false });
    expect(restore.body.demotions).toEqual({});
    expect(demotionFactor('laguna')).toBe(1);
  });

  it('rejects a malformed request', async () => {
    expect((await call('PUT', '/api/curation/demotions', { modelId: 'x' })).status).toBe(400);
    expect((await call('PUT', '/api/curation/demotions', { modelId: '', demote: true })).status).toBe(400);
  });

  it('requires a dashboard session', async () => {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/curation/demotions`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: 'laguna', demote: true }),
    });
    server.close();
    expect(res.status).toBe(401);
    expect(demotionFactor('laguna')).toBe(1);
  });
});
