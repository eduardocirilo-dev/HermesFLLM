import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { getSetting } from '../db/index.js';

// A verdict on whether a tool call's arguments actually satisfy the schema the
// caller declared for that tool.
//
// lib/tool-args.ts repairs what it can prove is repairable, and deliberately
// invents nothing. What it cannot do is say "this is still wrong" — so a call
// that violates its schema flows on unchallenged, and the Anthropic surface
// turns it into `input: {}` (routes/anthropic.ts parseToolInput does
// `try { JSON.parse } catch { return {} }`). The client then gets a tool_use
// block with no arguments and no explanation, which reads to an agent as the
// model having chosen to call the tool with nothing.
//
// Free-tier models are exactly the population that emits malformed tool calls,
// and a different model usually gets it right, so the useful response is the
// one the loop already has for a dead turn: throw before anything is committed
// and let failover try the next candidate.
//
// OFF by default. A false positive here costs a failover hop, and schemas in
// the wild are strange enough that the honest default is to look before
// leaping — enable it, watch the trail, then decide.

/** 2020-12, because that is what zod-to-json-schema and Pydantic v2 emit; a
 *  draft-07-only Ajv throws on their `$schema`. `strict: false` keeps an
 *  unknown keyword from being fatal — plenty of real schemas carry vendor
 *  extensions, and rejecting the schema would fail calls that are fine. */
const ajv = new (Ajv2020 as unknown as typeof import('ajv').default)({
  strict: false,
  allErrors: true,
  validateFormats: false,
});

export const TOOL_ARGUMENT_VALIDATION_SETTING = 'validate_tool_arguments';

export function isToolArgumentValidationEnabled(): boolean {
  let stored: string | undefined;
  try {
    stored = getSetting(TOOL_ARGUMENT_VALIDATION_SETTING);
  } catch {
    stored = undefined; // DB not ready — never throw on the proxy hot path.
  }
  for (const raw of [stored, process.env.VALIDATE_TOOL_ARGUMENTS]) {
    if (raw === undefined || raw.trim() === '') continue;
    const value = raw.trim().toLowerCase();
    return value === '1' || value === 'true';
  }
  return false;
}

/**
 * Order-independent serialisation, so two schemas that differ only in key order
 * share one compiled validator.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** Compiled validators, keyed by the schema's stable form. `null` is cached
 *  too: a schema Ajv refuses to compile must not be recompiled per request. */
const compiled = new Map<string, ValidateFunction | null>();
/** The stable string is the expensive half, and tool schemas are the same
 *  object for every call in a request, so memoise per object identity. */
const stableKeys = new WeakMap<object, string>();

function keyFor(schema: object): string {
  const cached = stableKeys.get(schema);
  if (cached !== undefined) return cached;
  const key = stableStringify(schema);
  stableKeys.set(schema, key);
  return key;
}

function compiledFor(schema: object): ValidateFunction | null {
  const key = keyFor(schema);
  const hit = compiled.get(key);
  if (hit !== undefined) return hit;

  let fn: ValidateFunction | null = null;
  try {
    // Drop `$schema`: a declared dialect Ajv does not recognise is fatal at
    // compile time, and the dialect is not what we are checking.
    const { $schema, ...rest } = schema as Record<string, unknown>;
    void $schema;
    fn = ajv.compile(rest);
  } catch {
    fn = null; // Unusable schema — see validateToolArguments, which fails OPEN.
  }
  compiled.set(key, fn);
  return fn;
}

export type ToolArgumentVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Check `argsJson` against `schema`.
 *
 * Fails **open** in every case where we cannot form an opinion: no schema, a
 * schema Ajv will not compile, or arguments that are not JSON at all (the last
 * is someone else's error to report, and tool-args deliberately passes
 * unparseable arguments through untouched). Only a definite schema violation
 * returns a verdict, because the consequence of a verdict is a failover hop.
 */
export function validateToolArguments(
  toolName: string,
  argsJson: string,
  schema: unknown,
): ToolArgumentVerdict {
  if (!schema || typeof schema !== 'object') return { ok: true };

  const validate = compiledFor(schema as object);
  if (!validate) return { ok: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return { ok: true };
  }
  // A tool call's arguments are an object by definition; anything else is a
  // shape problem the schema will report on its own terms if it cares.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: true };

  if (validate(parsed)) return { ok: true };

  const detail = (validate.errors ?? [])
    .slice(0, 3)
    .map(e => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
    .join('; ');
  return { ok: false, reason: `${toolName}: ${detail || 'does not match its schema'}` };
}

/**
 * The error thrown when a tool call cannot be served. The message carries the
 * marker `invalid tool arguments`, which `isRetryableError` recognises, so the
 * loop fails over exactly as it does for a dead dialect turn.
 *
 * `skipBench` because the PROVIDER is healthy — the model misbehaved, so no
 * cooldown or score penalty. `skipModelForRequest` because a sibling key would
 * misbehave identically, so the whole model is ruled out for this request.
 */
export function invalidToolArgumentsError(displayName: string, reasons: string[]): Error {
  const detail = reasons.slice(0, 3).join('; ');
  return Object.assign(
    new Error(`invalid tool arguments from ${displayName} (${detail})`),
    { skipBench: true, skipModelForRequest: true },
  );
}

/**
 * Verdicts for a whole turn's tool calls. Returns the reasons for those that
 * violate their schema; an empty array means the turn is servable.
 */
export function invalidToolCallReasons(
  calls: Array<{ function?: { name?: string; arguments?: string } }> | undefined,
  schemas: Map<string, unknown>,
): string[] {
  if (!calls || calls.length === 0) return [];
  const reasons: string[] = [];
  for (const call of calls) {
    const name = call.function?.name;
    const args = call.function?.arguments;
    if (!name || typeof args !== 'string') continue;
    const schema = schemas.get(name);
    if (schema === undefined) continue; // Tool the caller never declared a schema for.
    const verdict = validateToolArguments(name, args, schema);
    if (!verdict.ok) reasons.push(verdict.reason);
  }
  return reasons;
}

// ── HermesFLLM Agent Guard ──────────────────────────────────────────────────
// An agent cannot use a tool call that names a tool it never declared, carries
// arguments that are not a JSON object, or breaks the declared schema: the turn
// is lost, or worse, the agent runs a tool with nothing. Free models produce all
// three. ON by default in HermesFLLM (`agent_guard` setting / AGENT_GUARD env,
// '0' or 'false' to disable): such a turn fails over to the next model before
// any byte reaches the client, and the model is penalised so the router learns
// to stop picking it for tool work.

export const AGENT_GUARD_SETTING = 'agent_guard';

export function isAgentGuardEnabled(): boolean {
  let stored: string | undefined;
  try {
    stored = getSetting(AGENT_GUARD_SETTING);
  } catch {
    stored = undefined; // DB not ready — never throw on the proxy hot path.
  }
  for (const raw of [stored, process.env.AGENT_GUARD]) {
    if (raw === undefined || raw.trim() === '') continue;
    const value = raw.trim().toLowerCase();
    return !(value === '0' || value === 'false' || value === 'off');
  }
  return true;
}

/** Reasons a turn's tool calls are unusable by the agent; empty means servable. */
export function agentGuardReasons(
  calls: Array<{ function?: { name?: string; arguments?: string } }> | undefined,
  tools: Array<{ type?: string; function?: { name?: string; parameters?: unknown } }> | undefined,
): string[] {
  if (!calls || calls.length === 0) return [];
  const declared = new Map<string, unknown>();
  for (const t of tools ?? []) {
    if (t?.function?.name) declared.set(t.function.name, t.function.parameters);
  }
  const reasons: string[] = [];
  for (const call of calls) {
    const name = call.function?.name ?? '';
    const args = call.function?.arguments ?? '';
    if (!name) { reasons.push('tool call without a name'); continue; }
    // No tools declared at all (e.g. replaying history) gives nothing to judge names against.
    if (declared.size > 0 && !declared.has(name)) { reasons.push(`${name}: not a declared tool`); continue; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.trim() === '' ? '{}' : args);
    } catch {
      reasons.push(`${name}: arguments are not valid JSON`);
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      reasons.push(`${name}: arguments are not a JSON object`);
      continue;
    }
    const verdict = validateToolArguments(name, JSON.stringify(parsed), declared.get(name));
    if (!verdict.ok) reasons.push(verdict.reason);
  }
  return reasons;
}

/**
 * Same `invalid tool arguments` marker, so the loop fails over, and the whole model
 * is ruled out for the request — but WITHOUT skipBench: the model is penalised, so
 * it sinks in routing for tool-bearing traffic instead of being re-picked.
 */
export function agentGuardError(displayName: string, reasons: string[]): Error {
  const detail = reasons.slice(0, 3).join('; ');
  return Object.assign(
    new Error(`invalid tool arguments from ${displayName} (agent guard: ${detail})`),
    { skipModelForRequest: true, agentGuard: true },
  );
}
