// HermesFLLM phase routing: pick the model by what the agent is doing right now.
//
// The upstream task type is 'code' or 'chat', and every Hermes turn carries tools, so every turn is
// 'code': the router treats editing a file, running a shell command, reading the repository and
// browsing the web as the same job. They are not. A model that writes clean patches can still
// mangle shell commands, and the agent feedback (lib/hermes-feedback.ts) shows exactly that: for
// each model, which tool calls ran and which failed, by tool name.
//
// Phase routing closes that loop. Inside a turn, the agent's next call almost always continues what
// its last calls were doing (an edit streak, a browsing streak), so the phase of a request is the
// phase of the most recent tool calls in its transcript. Each model's tool success rate in that
// phase, from the feedback of the last 7 days, becomes a bounded multiplier on its routing score.
//
// Conservative by construction:
// - No phase on the first call of a turn (the last message is the user's): nothing to go on.
// - A model needs MIN_SAMPLES judged calls in a phase, and the phase MIN_PHASE_SAMPLES overall,
//   before its multiplier moves off 1. Rates are shrunk toward the phase average (PRIOR calls), so
//   a handful of failures cannot sink a model.
// - The multiplier stays in [FLOOR, CEIL]: it reorders close candidates, it does not override
//   reliability, cooldowns or capability gates. Manual priority chains ignore it, as they ignore
//   every score.
// - A session keeps its sticky model unless that model is markedly bad at the current phase
//   (multiplier <= STICKY_BREAK); only then does that one request route on merit.
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getDb } from '../db/index.js';

export const PHASES = ['edit', 'shell', 'explore', 'web'] as const;
export type AgentPhase = typeof PHASES[number];

export const MIN_SAMPLES = 5;
export const MIN_PHASE_SAMPLES = 20;
const PRIOR = 10;
export const FLOOR = 0.6;
export const CEIL = 1.15;
const WINDOW_DAYS = 7;
const CACHE_MS = 60_000;
/** How many of the latest phased tool calls decide the phase. */
const RECENT_CALLS = 4;

export function isPhaseRoutingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HERMESFLLM_PHASE_ROUTING?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

// Order matters: 'web_search' is web before it is a search, 'search_files' is exploring.
const PHASE_RULES: Array<[AgentPhase, RegExp]> = [
  ['web', /web|browser|browse|fetch|http|url|navigate|crawl|scrape/],
  ['edit', /write|patch|edit|replace|apply|insert|create_file|delete_file|move_file|rename|notebook/],
  ['shell', /terminal|shell|bash|exec|command|process|run_|^run$|kill|spawn/],
  ['explore', /read|search|grep|glob|list|find|view|open|^ls$|^cat$|tree|inspect/],
];

/** The phase a tool belongs to, or null for bookkeeping tools (todo, memory, clarify, ...). */
export function toolPhase(name: string | null | undefined): AgentPhase | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  for (const [phase, re] of PHASE_RULES) if (re.test(n)) return phase;
  return null;
}

/**
 * The phase of the request: the most common phase among the agent's latest tool calls in this turn
 * (ties go to the most recent). Null on a turn's first call or when no call has a phase.
 */
export function derivePhase(messages: ChatMessage[]): AgentPhase | null {
  const recent: AgentPhase[] = []; // most recent first
  for (let i = messages.length - 1; i >= 0 && recent.length < RECENT_CALLS; i--) {
    const m = messages[i];
    if (m.role === 'user') break; // a new instruction: what comes next is anyone's guess
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    for (let j = m.tool_calls.length - 1; j >= 0 && recent.length < RECENT_CALLS; j--) {
      const p = toolPhase(m.tool_calls[j].function?.name);
      if (p) recent.push(p);
    }
  }
  if (recent.length === 0) return null;
  const counts = new Map<AgentPhase, number>();
  for (const p of recent) counts.set(p, (counts.get(p) ?? 0) + 1);
  let best = recent[0];
  for (const p of recent) if ((counts.get(p) ?? 0) > (counts.get(best) ?? 0)) best = p;
  return best;
}

// ── Per-model, per-phase tool quality ─────────────────────────────────────────

export interface PhaseCounts { calls: number; errors: number }
export type PhaseTable = Map<string, Map<AgentPhase, PhaseCounts>>;

/** Judged tool calls (ok or error) by model and phase, over the last `days` days. */
export function phaseTable(days = WINDOW_DAYS): PhaseTable {
  const rows = getDb().prepare(`
    SELECT model_id, tool_name, COUNT(*) AS calls, SUM(outcome = 'error') AS errors
      FROM hermes_feedback
     WHERE kind = 'tool' AND outcome IN ('ok', 'error') AND created_at >= datetime('now', ?)
     GROUP BY model_id, tool_name
  `).all(`-${days} days`) as Array<{ model_id: string; tool_name: string | null; calls: number; errors: number }>;
  const table: PhaseTable = new Map();
  for (const r of rows) {
    const phase = toolPhase(r.tool_name);
    if (!phase) continue;
    let byPhase = table.get(r.model_id);
    if (!byPhase) table.set(r.model_id, byPhase = new Map());
    const c = byPhase.get(phase) ?? { calls: 0, errors: 0 };
    c.calls += r.calls;
    c.errors += r.errors;
    byPhase.set(phase, c);
  }
  return table;
}

/** Score multipliers per model for one phase. Pure: models missing from the map get 1. */
export function phaseFactors(table: PhaseTable, phase: AgentPhase): Map<string, number> {
  let calls = 0;
  let errors = 0;
  for (const byPhase of table.values()) {
    const c = byPhase.get(phase);
    if (c) { calls += c.calls; errors += c.errors; }
  }
  const out = new Map<string, number>();
  if (calls < MIN_PHASE_SAMPLES) return out;
  const avg = (calls - errors) / calls;
  if (avg <= 0) return out;
  for (const [modelId, byPhase] of table) {
    const c = byPhase.get(phase);
    if (!c || c.calls < MIN_SAMPLES) continue;
    const shrunk = (c.calls - c.errors + PRIOR * avg) / (c.calls + PRIOR);
    out.set(modelId, Math.min(CEIL, Math.max(FLOOR, shrunk / avg)));
  }
  return out;
}

let cache: { at: number; factors: Map<AgentPhase, Map<string, number>> } | null = null;

/** Routing score multiplier for `modelId` in `phase`; 1 without a phase, data or when disabled. */
export function phaseFactor(modelId: string, phase: AgentPhase | null | undefined, now = Date.now()): number {
  if (!phase || !isPhaseRoutingEnabled()) return 1;
  if (!cache || now - cache.at >= CACHE_MS) {
    const factors = new Map<AgentPhase, Map<string, number>>();
    try {
      const table = phaseTable();
      for (const p of PHASES) factors.set(p, phaseFactors(table, p));
    } catch {
      // never let analytics break routing
    }
    cache = { at: now, factors };
  }
  return cache.factors.get(phase)?.get(modelId) ?? 1;
}

/** A sticky model whose multiplier in the phase is at or below this is set aside for the request. */
export const STICKY_BREAK = 0.75;

/** True when the session's sticky model is markedly worse than average at `phase`. */
export function breaksStickiness(modelDbId: number, phase: AgentPhase): boolean {
  try {
    const row = getDb().prepare('SELECT model_id FROM models WHERE id = ?').get(modelDbId) as { model_id: string } | undefined;
    return !!row && phaseFactor(row.model_id, phase) <= STICKY_BREAK;
  } catch {
    return false;
  }
}

// ── Stats for the board ───────────────────────────────────────────────────────

let stats = freshStats();
function freshStats() {
  return { turns: { edit: 0, shell: 0, explore: 0, web: 0 } as Record<AgentPhase, number>, stickyBroken: 0, since: new Date().toISOString() };
}
export function notePhase(phase: AgentPhase, brokeSticky = false): void {
  stats.turns[phase]++;
  if (brokeSticky) stats.stickyBroken++;
}
export function phaseRoutingStats() {
  return { enabled: isPhaseRoutingEnabled(), turns: { ...stats.turns }, stickyBroken: stats.stickyBroken, since: stats.since };
}
export function resetPhaseState(): void {
  stats = freshStats();
  cache = null;
}
