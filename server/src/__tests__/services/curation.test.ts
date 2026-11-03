// HermesFLLM curation: probe verdicts that exclude a model, and the one-time default policy.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb, getSetting, setSetting } from '../../db/index.js';
import {
  applyDefaultPolicy,
  curatedOutModels,
  isCuratedOut,
  resetCurationCache,
  CURATION_VERDICT_TTL_MS,
  DEFAULT_WEIGHTS,
} from '../../services/curation.js';
import { getCustomWeights, getMinReliabilityFloor, getRoutingStrategy } from '../../services/router.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  resetCurationCache();
  const db = getDb();
  db.prepare('DELETE FROM model_probe_status').run();
  for (const key of ['hermesfllm_policy_applied', 'routing_strategy', 'routing_custom_weights', 'routing_min_reliability_floor']) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
});

const NOW = Date.parse('2026-11-03T12:00:00Z');

function probe(modelId: string, keyId: number, status: 'working' | 'unavailable', agoMs = 60_000, platform = 'p'): void {
  getDb().prepare(`INSERT INTO model_probe_status (platform, model_id, endpoint_scope, key_id, status, last_probed_at)
                   VALUES (?, ?, '', ?, ?, ?)`).run(platform, modelId, keyId, status, new Date(NOW - agoMs).toISOString());
}

describe('curatedOutModels', () => {
  it('excludes a model whose fresh probes are all unavailable', () => {
    probe('dead', 1, 'unavailable');
    probe('dead', 2, 'unavailable');
    expect(isCuratedOut({ platform: 'p', model_id: 'dead', endpoint_scope: '' }, NOW)).toBe(true);
  });

  it('keeps a model when at least one key still works', () => {
    probe('mixed', 1, 'unavailable');
    probe('mixed', 2, 'working');
    expect(isCuratedOut({ platform: 'p', model_id: 'mixed', endpoint_scope: '' }, NOW)).toBe(false);
  });

  it('ignores verdicts older than the TTL, so a model gets another chance', () => {
    probe('stale', 1, 'unavailable', CURATION_VERDICT_TTL_MS + 60_000);
    expect(curatedOutModels(NOW).size).toBe(0);
  });

  it('keeps unprobed models (cold start is never excluded)', () => {
    expect(isCuratedOut({ platform: 'p', model_id: 'never-probed', endpoint_scope: '' }, NOW)).toBe(false);
  });

  it('scopes the verdict to the platform', () => {
    probe('same-id', 1, 'unavailable', 60_000, 'a');
    expect(isCuratedOut({ platform: 'b', model_id: 'same-id', endpoint_scope: '' }, NOW)).toBe(false);
  });
});

describe('applyDefaultPolicy', () => {
  it('sets reliability- and intelligence-weighted routing on a fresh install', () => {
    expect(applyDefaultPolicy()).toEqual({ applied: true });
    expect(getRoutingStrategy()).toBe('custom');
    const w = getCustomWeights();
    expect(w.reliability).toBeCloseTo(DEFAULT_WEIGHTS.reliability);
    expect(w.intelligence).toBeCloseTo(DEFAULT_WEIGHTS.intelligence);
    expect(getMinReliabilityFloor()).toBe(0.9);
  });

  it("never overrides the operator's own choices", () => {
    setSetting('routing_strategy', 'fastest');
    setSetting('routing_min_reliability_floor', '0.5');
    applyDefaultPolicy();
    expect(getRoutingStrategy()).toBe('fastest');
    expect(getMinReliabilityFloor()).toBe(0.5);
  });

  it('runs only once, so later dashboard changes stick across restarts', () => {
    applyDefaultPolicy();
    getDb().prepare('DELETE FROM settings WHERE key = ?').run('routing_min_reliability_floor');
    expect(applyDefaultPolicy()).toEqual({ applied: false });
    expect(getSetting('routing_min_reliability_floor')).toBeUndefined();
  });
});
