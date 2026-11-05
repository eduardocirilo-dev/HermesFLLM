// HermesFLLM session anchor: an agent session keeps the strongest model that has served it, goes
// back to it after a failover to a weaker one, and fails over to its size tier or above first.

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
const { setRoutingStrategy, routeRequest, refreshStatsCache } = await import('../../services/router.js');
const { resetModelFailureWindows } = await import('../../lib/fallback-loop.js');
const { resetCurationState } = await import('../../services/curation.js');
const { clearCooldownsForKey } = await import('../../services/ratelimit.js');
const { noteSessionModel, sessionAnchor, sessionAnchorStats, resetSessionAnchors } = await import('../../lib/hermes-session.js');

type Model = { id: number; modelId: string };
let A: Model; // Frontier, best rank: the session's natural anchor
let B: Model; // Frontier, lower rank: a peer
let C: Model; // Small, but the fastest and most reliable on record

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
  return { status: res.status, body: raw ? JSON.parse(raw) : null, headers: res.headers };
}

/** Answers for every model except the ones in `failing`, which fail for this request only. */
function serveExcept(...failing: string[]) {
  return async (_k: string, _m: unknown, model: string) => {
    if (failing.includes(model)) throw Object.assign(new Error(`${model} unavailable`), { skipModelForRequest: true });
    return { id: 'x', object: 'chat.completion', created: 0, model, choices: [{ index: 0, message: { role: 'assistant', content: `answered by ${model}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
  };
}

const TOOLS = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

function enableOnly(...models: Model[]) {
  const db = getDb();
  db.prepare('UPDATE fallback_config SET enabled = 0').run();
  db.prepare('UPDATE profile_models SET enabled = 0').run();
  for (const m of models) {
    db.prepare('UPDATE fallback_config SET enabled = 1 WHERE model_db_id = ?').run(m.id);
    db.prepare('UPDATE profile_models SET enabled = 1 WHERE model_db_id = ?').run(m.id);
  }
}

describe('session anchor', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    setRoutingStrategy('balanced');
    const { encrypted, iv, authTag } = encrypt('test-key');
    const db = getDb();
    db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)`).run(encrypted, iv, authTag);
    const rows = db.prepare(`SELECT id, model_id FROM models WHERE platform = 'groq' AND enabled = 1 AND supports_tools = 1 ORDER BY id LIMIT 3`).all() as Array<{ id: number; model_id: string }>;
    expect(rows).toHaveLength(3);
    [A, B, C] = rows.map(r => ({ id: r.id, modelId: r.model_id }));
    db.prepare(`UPDATE models SET size_label = 'Frontier', intelligence_rank = 1 WHERE id = ?`).run(A.id);
    db.prepare(`UPDATE models SET size_label = 'Frontier', intelligence_rank = 40 WHERE id = ?`).run(B.id);
    db.prepare(`UPDATE models SET size_label = 'Small', intelligence_rank = 200 WHERE id = ?`).run(C.id);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    resetSessionAnchors();
    resetModelFailureWindows();
    resetCurationState();
    delete process.env.HERMESFLLM_SESSION_ANCHOR;
    const db = getDb();
    for (const t of ['rate_limit_cooldowns', 'rate_limit_usage', 'requests', 'model_probe_status']) db.prepare(`DELETE FROM ${t}`).run();
    for (const k of db.prepare('SELECT id FROM api_keys').all() as Array<{ id: number }>) clearCooldownsForKey(k.id);
    // On delivery alone, the small model is the most attractive: fast and never failing. B is slow
    // and sometimes fails.
    const req = db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms) VALUES ('groq', ?, NULL, ?, 100, 400, ?, ?)`);
    for (let i = 0; i < 300; i++) {
      req.run(A.modelId, 'success', 3000, 800);
      req.run(B.modelId, i % 3 === 0 ? 'error' : 'success', 20000, 9000);
      req.run(C.modelId, 'success', 600, 150);
    }
    refreshStatsCache(db, true);
    enableOnly(A, B, C);
  });

  afterEach(() => {
    delete process.env.HERMESFLLM_SESSION_ANCHOR;
  });

  it('keeps the strongest model as the anchor: escalates up, never down', () => {
    expect(noteSessionModel('s', B.id)).toBe('anchored');
    expect(noteSessionModel('s', B.id)).toBe('kept');
    expect(noteSessionModel('s', A.id)).toBe('escalated');
    expect(noteSessionModel('s', C.id)).toBe('displaced');
    expect(sessionAnchor('s')).toMatchObject({ modelDbId: A.id, displaced: true, tier: 4 });
    expect(noteSessionModel('s', A.id)).toBe('returned');
    expect(sessionAnchor('s')!.displaced).toBe(false);
    expect(sessionAnchorStats()).toMatchObject({ anchored: 1, escalated: 1, displaced: 1, returned: 1, activeSessions: 1 });
  });

  it('expires idle sessions and does nothing when disabled', () => {
    noteSessionModel('old', A.id, 0);
    expect(sessionAnchor('old', 2 * 60 * 60 * 1000)).toBeNull();
    process.env.HERMESFLLM_SESSION_ANCHOR = '0';
    expect(noteSessionModel('s', A.id)).toBeNull();
    expect(sessionAnchor('s')).toBeNull();
  });

  it('fails over to the anchor\'s tier first, even when a weaker model scores higher on delivery', () => {
    const pick = (minTier: number | null) => {
      const r = routeRequest(1000, undefined, undefined, false, true, new Set([A.id]), undefined, false, undefined, 0, undefined, undefined, null, minTier);
      r.release?.();
      return r.modelId;
    };
    const free = Array.from({ length: 20 }, () => pick(null));
    expect(free.filter(m => m === C.modelId).length).toBeGreaterThan(10); // delivery alone prefers C
    expect(Array.from({ length: 20 }, () => pick(4))).toEqual(Array(20).fill(B.modelId));
    // Nothing at the anchor's tier left: the weaker model still serves.
    const r = routeRequest(1000, undefined, undefined, false, true, new Set([A.id, B.id]), undefined, false, undefined, 0, undefined, undefined, null, 4);
    r.release?.();
    expect(r.modelId).toBe(C.modelId);
  });

  it('a session anchors, fails over to a peer rather than the small model, then goes back to its anchor', async () => {
    const turn1 = [{ role: 'user', content: 'anchor check: refactor the router' }];
    // Turn 1: only A is in the chain, so it serves and becomes the anchor.
    enableOnly(A);
    chatCompletion.mockImplementation(serveExcept());
    const r1 = await post(app, { model: 'autoTOP-hermes', tools: TOOLS, messages: turn1 }, key);
    expect(r1.status).toBe(200);
    expect(r1.body.model).toBe(A.modelId);
    enableOnly(A, B, C);

    // Turn 2: A is unavailable. The peer B answers, not the faster small model.
    const turn2 = [...turn1, { role: 'assistant', content: r1.body.choices[0].message.content }, { role: 'user', content: 'continue' }];
    chatCompletion.mockImplementation(serveExcept(A.modelId));
    const r2 = await post(app, { model: 'autoTOP-hermes', tools: TOOLS, messages: turn2 }, key);
    expect(r2.status).toBe(200);
    expect(r2.headers.get('x-hermesfllm-session-anchor')).toBe(A.modelId);
    expect(r2.body.model).toBe(B.modelId);

    // Turn 3: A is back. The session returns to it instead of staying on B.
    // A recovers: its failure window and cooldown clear, and the curation probe that A's failure
    // triggered (which also failed) is superseded by a working one.
    resetModelFailureWindows();
    for (const k of getDb().prepare('SELECT id FROM api_keys').all() as Array<{ id: number }>) clearCooldownsForKey(k.id);
    getDb().prepare('DELETE FROM model_probe_status').run();
    resetCurationState();
    const turn3 = [...turn2, { role: 'assistant', content: r2.body.choices[0].message.content }, { role: 'user', content: 'and finish' }];
    chatCompletion.mockImplementation(serveExcept());
    const r3 = await post(app, { model: 'autoTOP-hermes', tools: TOOLS, messages: turn3 }, key);
    expect(r3.status).toBe(200);
    expect(r3.headers.get('x-hermesfllm-session-anchor')).toBe(`${A.modelId}; returning`);
    expect(r3.body.model).toBe(A.modelId);
    expect(sessionAnchorStats()).toMatchObject({ anchored: 1, displaced: 1, returned: 1 });
  });
});
