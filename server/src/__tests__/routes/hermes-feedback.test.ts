// HermesFLLM agent feedback: the Hermes plugin reports tool and turn outcomes per model; the router
// stores only names, outcomes and error types, and turns them into per-model task quality.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { createApp } from '../../app.js';
import { qualityByModel, sanitizeFeedback } from '../../lib/hermes-feedback.js';
import { mintDashboardToken } from '../helpers/auth.js';

let app: Express;
let dashToken: string;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
});

beforeEach(() => {
  getDb().prepare('DELETE FROM hermes_feedback').run();
});

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: json };
}

const tool = (modelId: string, outcome: string, extra: Record<string, unknown> = {}) => ({ kind: 'tool', modelId, outcome, toolName: 'read_file', ...extra });
const turn = (modelId: string, outcome: string) => ({ kind: 'turn', modelId, outcome, sessionId: 's1', turnId: 't1' });

describe('POST /v1/hermesfllm/feedback', () => {
  it('stores the plugin events with the unified key', async () => {
    const res = await call('POST', '/v1/hermesfllm/feedback', getUnifiedApiKey(), {
      events: [tool('m1', 'ok'), tool('m1', 'error', { errorType: 'FileNotFoundError' }), turn('m1', 'completed')],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stored: 3, dropped: 0 });
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM hermes_feedback').get() as { n: number }).n).toBe(3);
  });

  it('rejects a caller without a valid inference key, and does not take a dashboard session for one', async () => {
    expect((await call('POST', '/v1/hermesfllm/feedback', null, { events: [tool('m1', 'ok')] })).status).toBe(401);
    expect((await call('POST', '/v1/hermesfllm/feedback', 'wrong', { events: [tool('m1', 'ok')] })).status).toBe(401);
    expect((await call('POST', '/v1/hermesfllm/feedback', dashToken, { events: [tool('m1', 'ok')] })).status).toBe(401);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM hermes_feedback').get() as { n: number }).n).toBe(0);
  });

  it('never stores arguments, results or messages, and drops malformed events', async () => {
    const res = await call('POST', '/v1/hermesfllm/feedback', getUnifiedApiKey(), {
      events: [
        { ...tool('m1', 'error', { errorType: 'ValueError' }), args: { path: '/etc/passwd' }, result: 'SECRET', errorMessage: 'token=abc' },
        { kind: 'tool', modelId: 'm1', outcome: 'exploded' },
        { kind: 'other', modelId: 'm1', outcome: 'ok' },
        { kind: 'turn', outcome: 'completed' },
        'not an object',
      ],
    });
    expect(res.body).toEqual({ stored: 1, dropped: 4 });
    const row = getDb().prepare('SELECT * FROM hermes_feedback').get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toMatch(/passwd|SECRET|token=abc/);
    expect(row).toMatchObject({ kind: 'tool', model_id: 'm1', outcome: 'error', tool_name: 'read_file', error_type: 'ValueError' });
  });
});

describe('qualityByModel', () => {
  it('rates each model by the tool calls that ran and the turns that finished, worst first', () => {
    const events = [
      ...Array.from({ length: 8 }, () => tool('good', 'ok')),
      tool('good', 'error', { errorType: 'TimeoutError' }),
      tool('good', 'blocked'), // the user's or the agent's choice, not the model's
      ...Array.from({ length: 5 }, () => turn('good', 'completed')),
      ...Array.from({ length: 3 }, () => tool('weak', 'ok')),
      ...Array.from({ length: 3 }, () => tool('weak', 'error', { errorType: 'FileNotFoundError' })),
      tool('weak', 'error', { errorType: 'ValueError' }),
      ...Array.from({ length: 3 }, () => turn('weak', 'failed')),
      ...Array.from({ length: 2 }, () => turn('weak', 'completed')),
      tool('rare', 'error'), // too few samples to judge
    ];
    getDb().transaction(() => {
      for (const e of sanitizeFeedback(events)) {
        getDb().prepare('INSERT INTO hermes_feedback (kind, model_id, outcome, tool_name, error_type) VALUES (?, ?, ?, ?, ?)')
          .run(e.kind, e.modelId, e.outcome, e.toolName ?? null, e.errorType ?? null);
      }
    })();

    const q = qualityByModel(7);
    expect(q.models.map(m => m.modelId)).toEqual(['weak', 'good']);
    expect(q.models[0]).toMatchObject({ toolCalls: 7, toolErrors: 4, turns: 5, turnsCompleted: 2, turnsFailed: 3, topErrorType: 'FileNotFoundError' });
    expect(q.models[0].toolSuccessRate).toBeCloseTo(3 / 7);
    expect(q.models[0].turnCompletionRate).toBeCloseTo(0.4);
    expect(q.models[1]).toMatchObject({ toolCalls: 9, toolErrors: 1, turnsCompleted: 5 });
    expect(q.models[1].toolSuccessRate).toBeCloseTo(8 / 9);
    expect(q.events).toBe(events.length);
  });

  it('is served to the dashboard at /api/curation/quality', async () => {
    const res = await call('GET', '/api/curation/quality', dashToken);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ models: [], events: 0 });
  });
});
