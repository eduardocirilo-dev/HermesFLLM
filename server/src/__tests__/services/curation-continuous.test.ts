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
    db.prepare(`INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, endpoint_scope, enabled, supports_tools)
                VALUES (?, 'p', ?, ?, 0, 0, '', 1, 1)`).run(id, `m${id}`, `m${id}`);
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

  // Regression: the counter lived only in memory, so every launchd restart (crash or login) reset
  // it and a crash loop could probe far past the daily cap.
  it('keeps the daily cap across a restart', async () => {
    let calls = 0;
    for (let i = 0; i < Math.ceil(CURATION_DAILY_CAP_PER_PLATFORM / 4) + 2; i++) {
      getDb().prepare('DELETE FROM model_probe_status').run();
      await runCurationRound({ chat: async () => { calls++; } });
      resetCurationState({ restartOnly: true }); // a restart after every round
    }
    expect(calls).toBe(CURATION_DAILY_CAP_PER_PLATFORM);
    expect(curationStatus().probesToday).toBe(CURATION_DAILY_CAP_PER_PLATFORM);
  });

  it('starts a new day from zero', async () => {
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    await runCurationRound({ chat: async () => {} }, yesterday);
    resetCurationState({ restartOnly: true });
    expect(curationStatus(yesterday).probesToday).toBe(4);
    expect(curationStatus().probesToday).toBe(0);
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

import { isTooSlow, MAX_LATENCY_MS, resetCurationCache } from '../../services/curation.js';

describe('latency ceiling', () => {
  function answered(modelDbId: number, latencyMs: number, n: number, status = 'success') {
    const ins = getDb().prepare(`INSERT INTO requests (platform, model_id, model_db_id, status, latency_ms) VALUES ('p', ?, ?, ?, ?)`);
    for (let i = 0; i < n; i++) ins.run(`m${modelDbId}`, modelDbId, status, latencyMs);
  }

  it('flags a model whose recent successes average above the ceiling', () => {
    answered(1, MAX_LATENCY_MS + 50_000, 3); // the 110-180s case that timed Hermes out
    answered(2, 8_000, 3);
    resetCurationCache();
    expect(isTooSlow(1)).toBe(true);
    expect(isTooSlow(2)).toBe(false);
  });

  it('needs a few samples before judging, and ignores failures', () => {
    answered(3, MAX_LATENCY_MS * 3, 2);
    answered(4, MAX_LATENCY_MS * 3, 5, 'error');
    resetCurationCache();
    expect(isTooSlow(3)).toBe(false);
    expect(isTooSlow(4)).toBe(false);
  });
});

import { assertAgentProbeReply } from '../../services/curation.js';

describe('agent probe', () => {
  const reply = (message: any) => ({ choices: [{ message }] });
  const call = (name: string, args: string) => ({ id: 'c1', type: 'function', function: { name, arguments: args } });

  it('accepts one valid call to the probe tool', () => {
    expect(() => assertAgentProbeReply(reply({ tool_calls: [call('get_weather', '{"city":"Lisbon"}')] }))).not.toThrow();
  });

  it('rejects a prose answer, an invented tool and broken arguments', () => {
    expect(() => assertAgentProbeReply(reply({ content: 'It is sunny in Lisbon.' }))).toThrow(/no valid tool call: answered without calling a tool/);
    expect(() => assertAgentProbeReply(reply({ tool_calls: [call('search_web', '{}')] }))).toThrow(/not a declared tool/);
    expect(() => assertAgentProbeReply(reply({ tool_calls: [call('get_weather', '{"city": ')] }))).toThrow(/not valid JSON/);
    expect(() => assertAgentProbeReply(reply({ tool_calls: [call('get_weather', '{"town":"Lisbon"}')] }))).toThrow(/no valid tool call/);
  });

  it('only probes models that declare tool support', () => {
    getDb().prepare('UPDATE models SET supports_tools = 0 WHERE id = 1').run();
    const picked = selectCurationCandidates(8).map(c => c.modelId);
    expect(picked).not.toContain('m1');
  });

  it('a round records a prose-only model as unavailable with the reason', async () => {
    const round = await runCurationRound({
      chat: async c => { if (c.modelId === 'm2') throw new Error('no valid tool call: answered without calling a tool'); },
    });
    expect(round?.results.find(r => r.modelId === 'm2')?.status).toBe('unavailable');
    const row = getDb().prepare(`SELECT last_error FROM model_probe_status WHERE model_id = 'm2'`).get() as { last_error: string };
    expect(row.last_error).toMatch(/no valid tool call/);
  });
});

import { runAgentProbe, answerUsesProbeResults } from '../../services/curation.js';

describe('agent probe task (two tools, answer from the results)', () => {
  const call = (id: string, name: string) => ({ id, type: 'function', function: { name, arguments: '{"city":"Lisbon"}' } });
  const tools = (...calls: any[]) => ({ choices: [{ message: { content: null, tool_calls: calls } }] });
  const text = (content: string) => ({ choices: [{ message: { content } }] });
  /** A fake model that plays back `replies` and records every conversation it was sent. */
  function model(...replies: any[]) {
    const sent: any[][] = [];
    return { sent, send: async (messages: any[]) => { sent.push(structuredClone(messages)); return replies[sent.length - 1]; } };
  }
  const GOOD = 'In Lisbon it is 17.3°C with light rain, and the local time is 14:52.';

  it('passes a model that calls both tools at once and answers from their results', async () => {
    const m = model(tools(call('a', 'get_weather'), call('b', 'get_time')), text(GOOD));
    await expect(runAgentProbe(m.send)).resolves.toBeUndefined();
    // The second request carries both results, paired to their calls.
    const tail = m.sent[1].slice(-2);
    expect(tail.map((t: any) => t.tool_call_id)).toEqual(['a', 'b']);
    expect(tail[0].content).toContain('17.3');
    expect(tail[1].content).toContain('14:52');
  });

  it('passes a model that calls the tools one after the other', async () => {
    const m = model(tools(call('a', 'get_weather')), tools(call('b', 'get_time')), text(GOOD));
    await expect(runAgentProbe(m.send)).resolves.toBeUndefined();
    expect(m.sent).toHaveLength(3);
  });

  it('fails a model that stops after one tool', async () => {
    const m = model(tools(call('a', 'get_weather')), text('It is 17.3°C and rainy in Lisbon.'));
    await expect(runAgentProbe(m.send)).rejects.toThrow(/agent probe failed: answered after calling only get_weather/);
  });

  it('fails a model that calls both tools but answers from imagination', async () => {
    const m = model(tools(call('a', 'get_weather'), call('b', 'get_time')), text('It is sunny and about 22 degrees, mid-afternoon.'));
    await expect(runAgentProbe(m.send)).rejects.toThrow(/agent probe failed: the answer ignores the tool results/);
  });

  it('fails a prose answer, a broken call and an endless tool loop', async () => {
    await expect(runAgentProbe(model(text('Lisbon is sunny.')).send)).rejects.toThrow(/no valid tool call: answered without calling a tool/);
    const broken = { id: 'x', type: 'function', function: { name: 'get_time', arguments: '{"town":"Lisbon"}' } };
    await expect(runAgentProbe(model(tools(call('a', 'get_weather')), tools(broken)).send)).rejects.toThrow(/no valid tool call/);
    const loop = model(tools(call('a', 'get_weather')), tools(call('b', 'get_weather')), tools(call('c', 'get_weather')));
    await expect(runAgentProbe(loop.send)).rejects.toThrow(/kept calling tools after 3 requests/);
  });

  it('reads the results however the answer phrases them', () => {
    expect(answerUsesProbeResults(GOOD)).toBe(true);
    expect(answerUsesProbeResults('Em Lisboa estão 17,3 °C com chuva fraca e são 14h52.')).toBe(true);
    expect(answerUsesProbeResults('17 degrees, light rain, 2:52 PM local time')).toBe(true);
    expect(answerUsesProbeResults('About 18 degrees at 3 pm.')).toBe(false);
    expect(answerUsesProbeResults('It is 17.3°C.')).toBe(false); // the time is missing
  });

  it('a model failure is never mistaken for a busy provider', () => {
    expect(isBusyProbeError('agent probe failed: the answer ignores the tool results ("rate limit 429")')).toBe(false);
  });
});

import { isBusyProbeError } from '../../services/curation.js';
import { buildHealthBoard } from '../../routes/curation.js';

describe('busy providers are inconclusive', () => {
  it('recognises overload answers but not real tool failures', () => {
    expect(isBusyProbeError('xKiro API error 503: The model is temporarily unavailable due to high demand')).toBe(true);
    expect(isBusyProbeError('UnoRouter API error 503: All providers for model are busy right now')).toBe(true);
    expect(isBusyProbeError('Groq API error 429: rate limit reached')).toBe(true);
    expect(isBusyProbeError('NaraRouter API error 400: The model rejected this request')).toBe(false);
    expect(isBusyProbeError('no valid tool call: answered without calling a tool')).toBe(false);
  });

  // Regression: the inconclusive path stamps last_probed_at with SQLite datetime('now'), the
  // verdict path with ISO. Compared as text the fresh SQLite stamp read as stale, so a busy
  // probe lifted the exclusion and the model vanished from the health board.
  it('a busy probe keeps an excluded model excluded, in routing and on the health board', async () => {
    probe('m1', 'unavailable', minutesAgo(15));
    expect(isCuratedOut({ platform: 'p', model_id: 'm1', endpoint_scope: '' })).toBe(true);

    const round = await runCurationRound({ chat: async c => { if (c.modelId === 'm1') throw new Error('API error 503: high demand'); } });
    expect(round?.results.find(r => r.modelId === 'm1')).toMatchObject({ reason: 'excluded', status: 'error' });
    const stamp = (getDb().prepare(`SELECT last_probed_at FROM model_probe_status WHERE model_id = 'm1'`).get() as { last_probed_at: string }).last_probed_at;
    expect(stamp).not.toContain('T'); // the inconclusive path's SQLite format: the case under test

    expect(isCuratedOut({ platform: 'p', model_id: 'm1', endpoint_scope: '' })).toBe(true);
    expect(buildHealthBoard().curation.excluded.map(m => m.modelId)).toEqual(['m1']);
    // Just probed: not picked again in the next round.
    expect(selectCurationCandidates().map(c => c.modelId)).not.toContain('m1');
  });

  it('a busy probe does not exclude the model', async () => {
    await runCurationRound({ chat: async c => { if (c.modelId === 'm1') throw new Error('API error 503: high demand'); } });
    expect(isCuratedOut({ platform: 'p', model_id: 'm1', endpoint_scope: '' })).toBe(false);
  });
});
