// HermesFLLM continuous curation: priority order, daily cap, rounds and live-failure probes.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  CURATION_DAILY_CAP_PER_PLATFORM,
  curationStatus,
  isCuratedOut,
  markCurationRunningForTest,
  noteLiveFailure,
  resetCurationState,
  runCurationRound,
  selectCurationCandidates,
} from '../../services/curation.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  resetCurationState();
  const db = getDb();
  for (const t of ['model_probe_status', 'requests', 'fallback_config', 'profile_models', 'api_keys', 'models']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare(`INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
              VALUES (1, 'p', '', '', '', '', 'healthy', 1)`).run();
  for (let id = 1; id <= 8; id++) {
    db.prepare(`INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, endpoint_scope, enabled)
                VALUES (?, 'p', ?, ?, 0, 0, '', 1)`).run(id, `m${id}`, `m${id}`);
  }
});

afterEach(() => markCurationRunningForTest(false));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function probe(modelId: string, status: string, at: string) {
  getDb().prepare(`INSERT INTO model_probe_status (platform, model_id, endpoint_scope, key_id, status, last_probed_at)
                   VALUES ('p', ?, '', 1, ?, ?)`).run(modelId, status, at);
}

function traffic(modelDbId: number, ok: number, fail: number) {
  const ins = getDb().prepare(`INSERT INTO requests (platform, model_id, model_db_id, status) VALUES ('p', ?, ?, ?)`);
  for (let i = 0; i < ok; i++) ins.run(`m${modelDbId}`, modelDbId, 'success');
  for (let i = 0; i < fail; i++) ins.run(`m${modelDbId}`, modelDbId, 'error');
}

describe('selectCurationCandidates', () => {
  it('orders live failures, then excluded models, then the reserve, then stale ones', () => {
    markCurationRunningForTest(true);
    noteLiveFailure(5);
    probe('m3', 'unavailable', minutesAgo(15)); // excluded, eligible again after 10 min
    traffic(7, 10, 0); // best live success: the warm reserve
    const picked = selectCurationCandidates(4);
    expect(picked.slice(0, 3).map(c => [c.modelId, c.reason])).toEqual([
      ['m5', 'live-failure'],
      ['m3', 'excluded'],
      ['m7', 'reserve'],
    ]);
    expect(picked[3].reason).toBe('stale');
    expect(new Set(picked.map(c => c.modelId)).size).toBe(4);
  });

  it('does not re-probe a model too soon', () => {
    probe('m3', 'unavailable', minutesAgo(3)); // excluded but probed 3 min ago (< 10)
    traffic(7, 10, 0);
    probe('m7', 'working', minutesAgo(5)); // reserve probed 5 min ago (< 20)
    const reasons = selectCurationCandidates(8).map(c => `${c.modelId}:${c.reason}`);
    expect(reasons).not.toContain('m3:excluded');
    expect(reasons).not.toContain('m7:reserve');
  });
});

describe('runCurationRound', () => {
  it('probes, records verdicts and excludes a model that fails', async () => {
    const round = await runCurationRound({ chat: async c => { if (c.modelId === 'm1') throw new Error('HTTP 403 quota drained'); } });
    expect(round?.results.length).toBe(4);
    expect(round?.results.find(r => r.modelId === 'm1')?.status).toBe('unavailable');
    expect(isCuratedOut({ platform: 'p', model_id: 'm1', endpoint_scope: '' })).toBe(true);
    expect(isCuratedOut({ platform: 'p', model_id: 'm2', endpoint_scope: '' })).toBe(false);
    expect(curationStatus().probesToday).toBe(4);
  });

  it('a recovered model comes back on its next probe', async () => {
    probe('m1', 'unavailable', minutesAgo(15));
    expect(isCuratedOut({ platform: 'p', model_id: 'm1', endpoint_scope: '' })).toBe(true);
    getDb().prepare('DELETE FROM model_probe_status').run();
    await runCurationRound({ chat: async () => {} });
    expect(isCuratedOut({ platform: 'p', model_id: 'm1', endpoint_scope: '' })).toBe(false);
  });

  it('respects the daily cap per platform', async () => {
    let calls = 0;
    for (let i = 0; i < Math.ceil(CURATION_DAILY_CAP_PER_PLATFORM / 4) + 2; i++) {
      getDb().prepare('DELETE FROM model_probe_status').run();
      await runCurationRound({ chat: async () => { calls++; } });
    }
    expect(calls).toBe(CURATION_DAILY_CAP_PER_PLATFORM);
  });

  it('drops a model from the urgent queue once it has an answer', async () => {
    markCurationRunningForTest(true);
    noteLiveFailure(2);
    expect(curationStatus().urgentQueued).toBe(1);
    await runCurationRound({ chat: async () => {} });
    expect(curationStatus().urgentQueued).toBe(0);
  });

  it('ignores live failures while curation is not running', () => {
    noteLiveFailure(2);
    expect(curationStatus().urgentQueued).toBe(0);
  });
});
