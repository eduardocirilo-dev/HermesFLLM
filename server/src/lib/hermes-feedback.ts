// HermesFLLM agent feedback: closing the quality loop with Hermes.
//
// The router sees whether a model answered, how fast, and whether its tool call was well formed.
// It does not see what happened next: did the tool the model chose actually run, did the agent's
// turn finish or fail? The Hermes plugin sees exactly that (post_tool_call, on_session_end) and
// reports it here, attributed to the model that served the API call. This is the first signal
// about task quality rather than delivery.
//
// Privacy by construction: only model ids, tool names, outcome words and error types are accepted
// and stored. Arguments, results and messages are never sent by the plugin and are dropped here if
// they were.
import { getDb } from '../db/index.js';

export type FeedbackKind = 'tool' | 'turn';
const TOOL_OUTCOMES = new Set(['ok', 'error', 'blocked', 'cancelled']);
const TURN_OUTCOMES = new Set(['completed', 'failed', 'interrupted']);
export const MAX_EVENTS_PER_BATCH = 200;
const RETENTION_DAYS = 30;

export interface FeedbackEvent {
  kind: FeedbackKind;
  modelId: string;
  outcome: string;
  toolName?: string | null;
  errorType?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
}

const short = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;

/** Keep only well-formed events, trimmed to the allowed fields. */
export function sanitizeFeedback(raw: unknown): FeedbackEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedbackEvent[] = [];
  for (const e of raw.slice(0, MAX_EVENTS_PER_BATCH)) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const kind = r.kind === 'tool' || r.kind === 'turn' ? r.kind : null;
    const modelId = short(r.modelId, 300);
    const outcome = short(r.outcome, 20)?.toLowerCase() ?? null;
    if (!kind || !modelId || !outcome) continue;
    if (kind === 'tool' && !TOOL_OUTCOMES.has(outcome)) continue;
    if (kind === 'turn' && !TURN_OUTCOMES.has(outcome)) continue;
    out.push({
      kind, modelId, outcome,
      toolName: kind === 'tool' ? short(r.toolName, 120) : null,
      errorType: short(r.errorType, 80),
      sessionId: short(r.sessionId, 120),
      turnId: short(r.turnId, 120),
    });
  }
  return out;
}

let insertsSincePrune = 0;

export function recordFeedback(events: FeedbackEvent[]): number {
  if (events.length === 0) return 0;
  const db = getDb();
  const ins = db.prepare(`INSERT INTO hermes_feedback (kind, model_id, outcome, tool_name, error_type, session_id, turn_id)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.transaction((rows: FeedbackEvent[]) => {
    for (const e of rows) ins.run(e.kind, e.modelId, e.outcome, e.toolName ?? null, e.errorType ?? null, e.sessionId ?? null, e.turnId ?? null);
  })(events);
  insertsSincePrune += events.length;
  if (insertsSincePrune >= 1000) {
    insertsSincePrune = 0;
    db.prepare(`DELETE FROM hermes_feedback WHERE created_at < datetime('now', ?)`).run(`-${RETENTION_DAYS} days`);
  }
  return events.length;
}

export interface ModelQuality {
  modelId: string;
  toolCalls: number;
  toolErrors: number;
  /** ok / (ok + error); blocked and cancelled are the user's or the agent's choice, not the model's. */
  toolSuccessRate: number | null;
  turns: number;
  turnsCompleted: number;
  turnsFailed: number;
  turnCompletionRate: number | null;
  /** Most frequent error type among this model's failed tool calls. */
  topErrorType: string | null;
}

/** Models need this many judged tool calls or turns before their rates are shown. */
export const MIN_QUALITY_SAMPLES = 5;

export function qualityByModel(days = 7): { models: ModelQuality[]; events: number; since: string } {
  const db = getDb();
  const window = `-${days} days`;
  const rows = db.prepare(`
    SELECT model_id,
           SUM(kind = 'tool' AND outcome IN ('ok', 'error')) AS tool_calls,
           SUM(kind = 'tool' AND outcome = 'error') AS tool_errors,
           SUM(kind = 'turn') AS turns,
           SUM(kind = 'turn' AND outcome = 'completed') AS turns_completed,
           SUM(kind = 'turn' AND outcome = 'failed') AS turns_failed
      FROM hermes_feedback
     WHERE created_at >= datetime('now', ?)
     GROUP BY model_id
  `).all(window) as Array<{ model_id: string; tool_calls: number; tool_errors: number; turns: number; turns_completed: number; turns_failed: number }>;
  const topErrors = new Map<string, string>();
  for (const r of db.prepare(`
    SELECT model_id, error_type, COUNT(*) AS n FROM hermes_feedback
     WHERE kind = 'tool' AND outcome = 'error' AND error_type IS NOT NULL AND created_at >= datetime('now', ?)
     GROUP BY model_id, error_type ORDER BY n DESC
  `).all(window) as Array<{ model_id: string; error_type: string }>) {
    if (!topErrors.has(r.model_id)) topErrors.set(r.model_id, r.error_type);
  }
  const models = rows
    .filter(r => r.tool_calls >= MIN_QUALITY_SAMPLES || r.turns >= MIN_QUALITY_SAMPLES)
    .map((r): ModelQuality => ({
      modelId: r.model_id,
      toolCalls: r.tool_calls,
      toolErrors: r.tool_errors,
      toolSuccessRate: r.tool_calls >= MIN_QUALITY_SAMPLES ? (r.tool_calls - r.tool_errors) / r.tool_calls : null,
      turns: r.turns,
      turnsCompleted: r.turns_completed,
      turnsFailed: r.turns_failed,
      turnCompletionRate: r.turns >= MIN_QUALITY_SAMPLES ? r.turns_completed / r.turns : null,
      topErrorType: topErrors.get(r.model_id) ?? null,
    }))
    // Worst first: that is where attention pays.
    .sort((a, b) => (a.toolSuccessRate ?? 1) - (b.toolSuccessRate ?? 1) || b.toolCalls - a.toolCalls);
  const events = (db.prepare(`SELECT COUNT(*) AS n FROM hermes_feedback WHERE created_at >= datetime('now', ?)`).get(window) as { n: number }).n;
  return { models, events, since: window };
}
