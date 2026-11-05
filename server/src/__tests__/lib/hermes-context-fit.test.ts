// HermesFLLM context fit: compact a long agent session only when its size keeps a top-ranked model
// out, aim at exactly what that model accepts, and never touch prompts that already fit.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb, setSetting } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { fitsContextWindow, routingReserveTokens } from '../../services/router.js';
import { estimateInputTokens } from '../../lib/content.js';
import {
  contextFitStats, fitContext, isContextFitEnabled, planContextFit, promptCapacity, rankedCandidates, resetContextFitStats,
} from '../../lib/hermes-context-fit.js';

const RESERVE = routingReserveTokens(undefined);

const cand = (modelId: string, contextWindow: number | null, tpmLimit: number | null = null) =>
  ({ modelDbId: modelId.length, platform: 'groq', modelId, contextWindow, tpmLimit, supportsTools: true });

/** A long agent session: the same file read again and again, as agents do while they edit it. */
function longSession(reads = 6, fileChars = 8_000): ChatMessage[] {
  const file = Array.from({ length: Math.ceil(fileChars / 40) }, (_, i) => `export const value${i} = compute(${i}); // line\n`).join('').slice(0, fileChars);
  const out: ChatMessage[] = [{ role: 'user', content: 'Refactor src/config.ts so the defaults live in one place.' }];
  for (let i = 0; i < reads; i++) {
    out.push({ role: 'assistant', content: '', tool_calls: [{ id: `r${i}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"/repo/src/config.ts"}' } }] } as ChatMessage);
    out.push({ role: 'tool', tool_call_id: `r${i}`, content: `${file}\n// revision ${i}` } as ChatMessage);
  }
  return out;
}

describe('promptCapacity', () => {
  it('is the largest input the router still lets through', () => {
    for (const cw of [8_192, 32_768, 131_072]) {
      const cap = promptCapacity({ contextWindow: cw, tpmLimit: null }, RESERVE)!;
      expect(fitsContextWindow('groq', cw, cap + RESERVE, RESERVE)).toBe(true);
      expect(fitsContextWindow('groq', cw, cap + 2 + RESERVE, RESERVE)).toBe(false);
    }
  });

  it('takes the tighter of the window and the per-minute token cap, and null when neither is known', () => {
    expect(promptCapacity({ contextWindow: 131_072, tpmLimit: 8_000 }, 1_000)).toBe(7_000);
    expect(promptCapacity({ contextWindow: null, tpmLimit: null }, 1_000)).toBeNull();
  });
});

describe('planContextFit', () => {
  it('leaves short prompts and prompts every top model accepts alone', () => {
    expect(planContextFit([cand('small', 8_192)], 5_000, RESERVE).targetTokens).toBeNull();
    expect(planContextFit([cand('a', 131_072), cand('b', 200_000)], 20_000, RESERVE).targetTokens).toBeNull();
  });

  it('sizes the target for the best-ranked top model the prompt is too big for', () => {
    const plan = planContextFit([cand('big', 131_072), cand('mid', 32_768), cand('small', 16_384)], 30_000, RESERVE);
    expect(plan.forModel).toBe('groq/mid');
    expect(plan.targetTokens).toBe(Math.floor(promptCapacity({ contextWindow: 32_768, tpmLimit: null }, RESERVE)! * 0.9));
    expect(plan.eligibleBefore).toBe(1);
  });

  it('only looks at the top five, and skips a model no prompt could reach', () => {
    const top = [cand('a', null), cand('b', null), cand('c', null), cand('d', null), cand('e', null)];
    expect(planContextFit([...top, cand('sixth', 16_384)], 30_000, RESERVE).targetTokens).toBeNull();
    // Its output reserve alone overflows the window: compacting cannot help.
    expect(planContextFit([cand('tiny', 900), cand('mid', 32_768)], 30_000, RESERVE).forModel).toBe('groq/mid');
  });
});

describe('fitContext', () => {
  let app: Express;
  let dashToken = '';

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
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const raw = await res.text();
    server.close();
    return { status: res.status, body: raw ? JSON.parse(raw) : null, headers: res.headers };
  }

  /** Keep two groq models in the chain: the first with a small window, the second with a big one. */
  let smallId = 0;
  let bigId = 0;
  beforeEach(async () => {
    resetContextFitStats();
    delete process.env.HERMESFLLM_CONTEXT_FIT;
    setSetting('compression', JSON.stringify({ mode: 'off', engines: {}, trustProjectFilters: false, prefixFreeze: false }));
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    const added = await request('POST', '/api/keys', { platform: 'groq', key: 'gsk_context_fit', label: 'fit' }, { Authorization: `Bearer ${dashToken}` });
    expect(added.status).toBe(201);
    const groq = db.prepare(`SELECT id FROM models WHERE platform = 'groq' AND enabled = 1 ORDER BY id LIMIT 2`).all() as Array<{ id: number }>;
    expect(groq).toHaveLength(2);
    [smallId, bigId] = groq.map(r => r.id);
    db.prepare('UPDATE fallback_config SET enabled = 0').run();
    db.prepare('UPDATE profile_models SET enabled = 0').run();
    for (const id of [smallId, bigId]) {
      db.prepare('UPDATE fallback_config SET enabled = 1 WHERE model_db_id = ?').run(id);
      db.prepare('UPDATE profile_models SET enabled = 1 WHERE model_db_id = ?').run(id);
    }
    db.prepare('UPDATE models SET context_window = 12000, tpm_limit = NULL WHERE id = ?').run(smallId);
    db.prepare('UPDATE models SET context_window = 200000, tpm_limit = NULL WHERE id = ?').run(bigId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.HERMESFLLM_CONTEXT_FIT;
  });

  it('ranks only models that could serve now', () => {
    const ids = rankedCandidates(false).map(c => c.modelDbId).sort();
    expect(ids).toEqual([smallId, bigId].sort());
    getDb().prepare('DELETE FROM api_keys').run();
    expect(rankedCandidates(false)).toEqual([]);
  });

  it('compacts superseded reads until the small model fits, and keeps the request and the latest read', () => {
    const messages = longSession();
    const before = estimateInputTokens(messages);
    const fit = fitContext(messages, { outputReserve: RESERVE });
    expect(fit.applied).toBe(true);
    expect(fit.forModel).toMatch(/^groq\//);
    expect(fit.tokensBefore).toBe(before);
    expect(fit.tokensAfter).toBeLessThanOrEqual(promptCapacity({ contextWindow: 12_000, tpmLimit: null }, RESERVE)!);
    expect(fit.eligibleBefore).toBe(1);
    expect(fit.eligibleAfter).toBe(2);
    expect(fit.messages[0].content).toBe(messages[0].content);
    expect(fit.messages.at(-1)!.content).toBe(messages.at(-1)!.content);
    expect(contextFitStats()).toMatchObject({ enabled: true, turns: 1, compacted: 1, modelsRegained: 1 });
    expect(contextFitStats().tokensSaved).toBe(before - fit.tokensAfter);
  });

  it('does nothing when the prompt already fits, when it is switched off, or when nothing can be removed', () => {
    getDb().prepare('UPDATE models SET context_window = 200000 WHERE id = ?').run(smallId);
    const messages = longSession();
    expect(fitContext(messages, { outputReserve: RESERVE })).toMatchObject({ applied: false, messages, eligibleBefore: 2 });

    getDb().prepare('UPDATE models SET context_window = 12000 WHERE id = ?').run(smallId);
    process.env.HERMESFLLM_CONTEXT_FIT = 'off';
    expect(isContextFitEnabled()).toBe(false);
    expect(fitContext(messages, { outputReserve: RESERVE }).applied).toBe(false);
    delete process.env.HERMESFLLM_CONTEXT_FIT;

    // One huge user message: no duplicate, no superseded read, no tool output to trim.
    const prose = Array.from({ length: 3_000 }, (_, i) => `Sentence ${i} about requirement ${i * 7}.`).join(' ');
    const single: ChatMessage[] = [{ role: 'user', content: prose }];
    const fit = fitContext(single, { outputReserve: RESERVE });
    expect(fit.applied).toBe(false);
    expect(fit.messages).toBe(single);
    expect(contextFitStats().compacted).toBe(0);
  });

  it('compacts an auto chat request before routing and says so in a header, but never a pinned or opted-out one', async () => {
    const originalFetch = global.fetch;
    const forwarded: any[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        forwarded.push(JSON.parse(String((init as RequestInit).body)));
        return {
          ok: true,
          json: async () => ({
            id: 'fit', object: 'chat.completion', created: 1, model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
        } as Response;
      }
      return originalFetch(url, init);
    });
    const auth = { Authorization: `Bearer ${getUnifiedApiKey()}` };
    const messages = longSession();

    const auto = await request('POST', '/v1/chat/completions', { model: 'auto', messages }, auth);
    expect(auto.status).toBe(200);
    expect(auto.headers.get('x-hermesfllm-context-fit')).toMatch(/^\d+->\d+ tokens; eligible 1->2; for groq\//);
    expect(JSON.stringify(forwarded.at(-1).messages).length).toBeLessThan(JSON.stringify(messages).length / 2);

    const optedOut = await request('POST', '/v1/chat/completions', { model: 'auto', messages }, { ...auth, 'x-freellm-compress': 'off' });
    expect(optedOut.status).toBe(200);
    expect(optedOut.headers.get('x-hermesfllm-context-fit')).toBeNull();

    const bigModel = (getDb().prepare('SELECT model_id FROM models WHERE id = ?').get(bigId) as { model_id: string }).model_id;
    const pinned = await request('POST', '/v1/chat/completions', { model: bigModel, messages }, auth);
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get('x-hermesfllm-context-fit')).toBeNull();
  });
});
