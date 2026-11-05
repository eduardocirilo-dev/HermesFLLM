// Migration: HermesFLLM agent feedback (what happened AFTER the router answered)
// Created: 2026-11-05
//
// DOWN: reversible (DROP TABLE)
//
// The router only sees whether a model answered. The Hermes plugin sees what the agent did with
// the answer: whether each tool call the model made ran or failed, and how each turn ended. One
// row per event, attributed to the model that served the API call. Names, statuses and error
// types only: never tool arguments, results or messages.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hermes_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- 'tool' (one tool call the model asked for) or 'turn' (one agent turn ended)
      kind TEXT NOT NULL,
      model_id TEXT NOT NULL,
      -- tool: ok | error | blocked | cancelled; turn: completed | failed | interrupted
      outcome TEXT NOT NULL,
      tool_name TEXT,
      error_type TEXT,
      session_id TEXT,
      turn_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hermes_feedback_created ON hermes_feedback(created_at);
    CREATE INDEX IF NOT EXISTS idx_hermes_feedback_model ON hermes_feedback(model_id, kind);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS hermes_feedback');
}
