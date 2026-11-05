// HermesFLLM phase routing: the agent's current phase (edit, shell, explore, web) comes from its
// latest tool calls, and each model's tool success in that phase moves its routing score, within
// bounds, once there is enough feedback to judge.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { refreshStatsCache, routeRequest } from '../../services/router.js';
import {
  CEIL, FLOOR, breaksStickiness, derivePhase, phaseFactor, phaseFactors, phaseRoutingStats, phaseTable, resetPhaseState, toolPhase,
  type PhaseTable,
} from '../../lib/hermes-phase.js';

const call = (name: string, id = name) => ({ id, type: 'function' as const, function: { name, arguments: '{}' } });
const asst = (...names: string[]): ChatMessage => ({ role: 'assistant', content: '', tool_calls: names.map((n, i) => call(n, `${n}${i}`)) } as ChatMessage);
const tool = (id: string): ChatMessage => ({ role: 'tool', tool_call_id: id, content: 'ok' } as ChatMessage);
const user = (text: string): ChatMessage => ({ role: 'user', content: text });

describe('toolPhase', () => {
  it('maps Hermes and common agent tools to a phase, and bookkeeping tools to none', () => {
    expect(['write_file', 'patch', 'str_replace_editor', 'apply_patch'].map(toolPhase)).toEqual(['edit', 'edit', 'edit', 'edit']);
    expect(['terminal', 'process', 'execute_code', 'bash'].map(toolPhase)).toEqual(['shell', 'shell', 'shell', 'shell']);
    expect(['read_file', 'search_files', 'grep', 'list_directory'].map(toolPhase)).toEqual(['explore', 'explore', 'explore', 'explore']);
    expect(['web_search', 'web_extract', 'browser_navigate', 'fetch_url'].map(toolPhase)).toEqual(['web', 'web', 'web', 'web']);
    expect(['todo', 'memory', 'clarify', null, ''].map(toolPhase)).toEqual([null, null, null, null, null]);
  });
});

describe('derivePhase', () => {
  it('has nothing to go on at the start of a turn', () => {
    expect(derivePhase([user('fix the bug')])).toBeNull();
    expect(derivePhase([user('a'), asst('terminal'), tool('terminal0'), user('now something else')])).toBeNull();
  });

  it('follows the latest tool calls of the turn, majority first, ties to the most recent', () => {
    expect(derivePhase([user('go'), asst('read_file'), tool('x'), asst('patch'), tool('y'), asst('patch'), tool('z')])).toBe('edit');
    expect(derivePhase([user('go'), asst('terminal'), tool('x'), asst('read_file'), tool('y')])).toBe('explore');
    expect(derivePhase([user('go'), asst('todo'), tool('x')])).toBeNull();
    // Only the last four phased calls count: an old browsing streak does not outvote recent shell work.
    expect(derivePhase([user('go'), asst('web_search', 'web_search', 'web_search'), asst('terminal', 'terminal'), asst('read_file', 'terminal')])).toBe('shell');
  });
});

describe('phaseFactors', () => {
  const table = (rows: Array<[string, 'edit' | 'shell', number, number]>): PhaseTable => {
    const t: PhaseTable = new Map();
    for (const [m, p, calls, errors] of rows) {
      if (!t.has(m)) t.set(m, new Map());
      t.get(m)!.set(p, { calls, errors });
    }
    return t;
  };

  it('stays neutral until the phase and the model have enough judged calls', () => {
    expect(phaseFactors(table([['a', 'shell', 10, 5], ['b', 'shell', 5, 0]]), 'shell').size).toBe(0);
    const f = phaseFactors(table([['a', 'shell', 30, 15], ['b', 'shell', 30, 0], ['c', 'shell', 4, 4]]), 'shell');
    expect(f.has('c')).toBe(false);
    expect(f.get('a')!).toBeLessThan(1);
    expect(f.get('b')!).toBeGreaterThan(1);
  });

  it('shrinks toward the phase average and stays within bounds', () => {
    const f = phaseFactors(table([['bad', 'shell', 40, 40], ['good', 'shell', 400, 0], ['ok', 'shell', 6, 1]]), 'shell');
    expect(f.get('bad')).toBe(FLOOR);
    expect(f.get('good')).toBeLessThanOrEqual(CEIL);
    expect(Math.abs(f.get('ok')! - 1)).toBeLessThan(0.1); // six calls barely move it
  });
});

describe('phase routing against the database', () => {
  let app: Express;
  let dashToken = '';
  let a = { id: 0, modelId: '' };
  let b = { id: 0, modelId: '' };

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    dashToken = mintDashboardToken();
    app = createApp();
  });

  async function request(method: string, path: string, body: unknown, headers: Record<string, string>) {
    const server = await new Promise<ReturnType<Express['listen']>>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    server.close();
    return { status: res.status, body: raw ? JSON.parse(raw) : null, headers: res.headers };
  }

  function feedback(modelId: string, toolName: string, ok: number, errors: number) {
    const ins = getDb().prepare(`INSERT INTO hermes_feedback (kind, model_id, outcome, tool_name) VALUES ('tool', ?, ?, ?)`);
    for (let i = 0; i < ok; i++) ins.run(modelId, 'ok', toolName);
    for (let i = 0; i < errors; i++) ins.run(modelId, 'error', toolName);
  }

  beforeEach(async () => {
    resetPhaseState();
    delete process.env.HERMESFLLM_PHASE_ROUTING;
    const db = getDb();
    db.prepare('DELETE FROM hermes_feedback').run();
    db.prepare('DELETE FROM api_keys').run();
    const added = await request('POST', '/api/keys', { platform: 'groq', key: 'gsk_phase', label: 'phase' }, { Authorization: `Bearer ${dashToken}` });
    expect(added.status).toBe(201);
    const rows = db.prepare(`SELECT id, model_id FROM models WHERE platform = 'groq' AND enabled = 1 AND supports_tools = 1 ORDER BY id LIMIT 2`).all() as Array<{ id: number; model_id: string }>;
    expect(rows).toHaveLength(2);
    [a, b] = rows.map(r => ({ id: r.id, modelId: r.model_id }));
    db.prepare('UPDATE fallback_config SET enabled = 0').run();
    db.prepare('UPDATE profile_models SET enabled = 0').run();
    for (const m of [a, b]) {
      db.prepare('UPDATE fallback_config SET enabled = 1 WHERE model_db_id = ?').run(m.id);
      db.prepare('UPDATE profile_models SET enabled = 1 WHERE model_db_id = ?').run(m.id);
    }
    // Peers on paper (same size and rank): the multiplier reorders close candidates, by design it
    // does not overturn a large intelligence gap.
    for (const m of [a, b]) db.prepare(`UPDATE models SET intelligence_rank = 10, size_label = 'large' WHERE id = ?`).run(m.id);
    // Identical, well-observed delivery records, so the bandit's sampling noise is small and the
    // phase multiplier is what tells the two apart.
    db.prepare('DELETE FROM requests').run();
    const req = db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms) VALUES ('groq', ?, NULL, 'success', 100, 100, 2000, 500)`);
    for (const m of [a, b]) for (let i = 0; i < 300; i++) req.run(m.modelId);
    refreshStatsCache(db, true);
    // a: a careful editor that fumbles the shell; b: the opposite.
    feedback(a.modelId, 'patch', 40, 0);
    feedback(a.modelId, 'terminal', 5, 35);
    feedback(b.modelId, 'patch', 5, 35);
    feedback(b.modelId, 'terminal', 40, 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.HERMESFLLM_PHASE_ROUTING;
  });

  it('reads per-model, per-phase counts from the feedback', () => {
    const t = phaseTable();
    expect(t.get(a.modelId)!.get('edit')).toEqual({ calls: 40, errors: 0 });
    expect(t.get(b.modelId)!.get('shell')).toEqual({ calls: 40, errors: 0 });
    expect(phaseFactor(a.modelId, 'shell')).toBe(FLOOR);
    expect(phaseFactor(a.modelId, null)).toBe(1);
  });

  it('routes each phase to the model that does it well', () => {
    const pick = (phase: 'edit' | 'shell') => {
      const counts = new Map<string, number>();
      for (let i = 0; i < 20; i++) {
        const r = routeRequest(1000, undefined, undefined, false, true, undefined, undefined, false, undefined, 0, undefined, undefined, phase);
        counts.set(r.modelId, (counts.get(r.modelId) ?? 0) + 1);
        r.release?.(); // each pick is a separate request, not 20 in flight at once
      }
      return counts;
    };
    expect(pick('shell').get(b.modelId) ?? 0).toBeGreaterThanOrEqual(18);
    expect(pick('edit').get(a.modelId) ?? 0).toBeGreaterThanOrEqual(18);
  });

  it('is a no-op when switched off', () => {
    process.env.HERMESFLLM_PHASE_ROUTING = 'off';
    expect(phaseFactor(a.modelId, 'shell')).toBe(1);
  });

  it('sets a sticky model aside only when it is markedly bad at the phase', () => {
    expect(breaksStickiness(a.id, 'shell')).toBe(true);
    expect(breaksStickiness(a.id, 'edit')).toBe(false);
    expect(breaksStickiness(b.id, 'explore')).toBe(false); // no data: never
  });

  it('tags a mid-turn agent request with its phase and counts it; the first call of a turn has none', async () => {
    const originalFetch = global.fetch;
    const forwardedModels: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        forwardedModels.push(JSON.parse(String((init as RequestInit).body)).model);
        return {
          ok: true,
          json: async () => ({
            id: 'p', object: 'chat.completion', created: 1, model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
        } as Response;
      }
      return originalFetch(url, init);
    });
    const auth = { Authorization: `Bearer ${getUnifiedApiKey()}` };
    const tools = [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object', properties: {} } } }];

    const first = await request('POST', '/v1/chat/completions', { model: 'auto', tools, messages: [user('run the tests')] }, auth);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-hermesfllm-phase')).toBeNull();

    const messages = [user('run the tests'), asst('terminal'), tool('terminal0')];
    const mid = await request('POST', '/v1/chat/completions', { model: 'auto', tools, messages }, auth);
    expect(mid.status).toBe(200);
    expect(mid.headers.get('x-hermesfllm-phase')).toMatch(/^shell/);
    expect(forwardedModels.at(-1)).toBe(b.modelId);
    expect(phaseRoutingStats().turns.shell).toBe(1);

    const quality = await request('GET', '/api/curation/quality', undefined, { Authorization: `Bearer ${dashToken}` });
    const qa = quality.body.models.find((m: { modelId: string }) => m.modelId === a.modelId);
    expect(qa.phases.map((p: { phase: string }) => p.phase)).toEqual(['edit', 'shell']);
    expect(qa.phases[1]).toMatchObject({ calls: 40, errors: 35, factor: FLOOR });
    expect(quality.body.phaseRouting.turns.shell).toBe(1);
  });
});
