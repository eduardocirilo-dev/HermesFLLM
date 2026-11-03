// Migration: HermesFLLM shadow comparison pairs (HermesFLLM vs the original FreeLLMAPI)
// Created: 2026-11-03
//
// DOWN: reversible (DROP TABLE)
//
// One row per sampled agent turn: the outcome the agent got from HermesFLLM (h_*) and the
// outcome the same request got from FreeLLMAPI, sent as an invisible copy (f_*). Both are
// judged by the same rules (lib/hermes-shadow.ts).

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hermes_shadow_pairs (
      request_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      h_outcome TEXT, h_status INTEGER, h_ttfb_ms INTEGER, h_latency_ms INTEGER, h_error TEXT,
      -- 1 when the first-token race launched a backup model during this HermesFLLM turn
      h_raced INTEGER NOT NULL DEFAULT 0,
      f_outcome TEXT, f_status INTEGER, f_ttfb_ms INTEGER, f_latency_ms INTEGER, f_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hermes_shadow_pairs_created ON hermes_shadow_pairs(created_at);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS hermes_shadow_pairs');
}
