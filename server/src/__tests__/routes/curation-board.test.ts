// HermesFLLM health board: exclusions, Agent Guard saves and the reliability ranking.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { buildHealthBoard } from '../../routes/curation.js';
import { resetCurationCache } from '../../services/curation.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  resetCurationCache();
  const db = getDb();
  db.prepare('DELETE FROM model_probe_status').run();
  db.prepare('DELETE FROM requests').run();
});

function probe(modelId: string, keyId: number, status: string, error: string | null = null) {
  getDb().prepare(`INSERT INTO model_probe_status (platform, model_id, endpoint_scope, key_id, status, last_probed_at, last_error)
                   VALUES ('p', ?, '', ?, ?, ?, ?)`).run(modelId, keyId, status, new Date().toISOString(), error);
}

function request(modelId: string, status: 'success' | 'error', error: string | null = null, latency = 1000) {
  getDb().prepare(`INSERT INTO requests (platform, model_id, status, latency_ms, error) VALUES ('p', ?, ?, ?, ?)`)
    .run(modelId, status, latency, error);
}

describe('buildHealthBoard', () => {
  it('lists a model as excluded only when every fresh probe failed', () => {
    probe('dead', 1, 'unavailable', 'HTTP 403 quota drained');
    probe('mixed', 1, 'unavailable');
    probe('mixed', 2, 'working');
    const board = buildHealthBoard();
    expect(board.curation.probedModels).toBe(2);
    expect(board.curation.working).toBe(1);
    expect(board.curation.excluded).toEqual([
      expect.objectContaining({ modelId: 'dead', reason: 'HTTP 403 quota drained' }),
    ]);
  });

  it('counts the turns the Agent Guard failed over', () => {
    request('m', 'error', 'invalid tool arguments from X (agent guard: rm: not a declared tool)');
    request('m', 'error', 'invalid tool arguments from X (agent guard: read: arguments are not valid JSON)');
    request('m', 'error', 'Groq API error 413');
    const board = buildHealthBoard();
    expect(board.agentGuard).toMatchObject({ enabled: true, savedLast24h: 2, savedLast7d: 2 });
  });

  it('counts every turn a HermesFLLM protection rescued, by kind', () => {
    request('a', 'error', 'invalid tool arguments from X (agent guard: rm: not a declared tool)');
    request('a', 'error', 'agent deadline: X sent no output within 30.0s (timeout), failing over');
    request('a', 'error', 'agent governor: X stopped making progress — under 32 new characters in 30s (timeout), failing over');
    request('a', 'error', 'agent governor: X stopped making progress — under 32 new characters in 31s (timeout), failing over');
    request('a', 'error', 'agent governor: X is looping (repeating output) — last 8KB compress 94x (timeout), failing over');
    request('a', 'error', 'agent governor: X exceeded the turn ceiling — 300s with nothing sent to the agent (timeout), failing over');
    request('a', 'error', 'Groq API error 413');
    const { rescues } = buildHealthBoard();
    expect(rescues.last24h).toEqual({ guard: 1, deadline: 1, stall: 2, runaway: 1, ceiling: 1 });
    expect(rescues.total24h).toBe(6);
    expect(rescues.total7d).toBe(6);
    expect(rescues.governorEnabled).toBe(true);
  });

  it('ranks models by success rate and ignores ones with too little traffic', () => {
    for (let i = 0; i < 6; i++) request('solid', 'success');
    for (let i = 0; i < 6; i++) request('flaky', i < 3 ? 'success' : 'error');
    for (let i = 0; i < 2; i++) request('new', 'success');
    const board = buildHealthBoard();
    expect(board.topModels.map(m => m.modelId)).toEqual(['solid', 'flaky']);
    expect(board.topModels[1].successRate).toBe(0.5);
    expect(board.traffic.requests24h).toBe(14);
  });

  it('reports the first-token race, on by default', () => {
    const board = buildHealthBoard();
    expect(board.race).toMatchObject({ enabled: true, races: expect.any(Number), backupWins: expect.any(Number), minDelayMs: 3000, maxDelayMs: 15000 });
  });
});
