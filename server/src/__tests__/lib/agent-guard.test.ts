// HermesFLLM Agent Guard: which tool calls an agent cannot use, and the failover error.

import { describe, it, expect, afterEach } from 'vitest';
import { agentGuardReasons, agentGuardError, isAgentGuardEnabled } from '../../lib/tool-validate.js';
import { isRetryableError } from '../../lib/error-classify.js';

const tools = [
  { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_dir' } },
];
const call = (name: string, args: string) => ({ function: { name, arguments: args } });

describe('agentGuardReasons', () => {
  it('passes a well-formed call', () => {
    expect(agentGuardReasons([call('read_file', '{"path":"/tmp/a"}')], tools)).toEqual([]);
  });

  it('accepts empty arguments for a tool without parameters', () => {
    expect(agentGuardReasons([call('list_dir', '')], tools)).toEqual([]);
  });

  it('rejects arguments that are not JSON (streaming used to drop these silently)', () => {
    expect(agentGuardReasons([call('read_file', '{"path": "/tmp')], tools)).toEqual(['read_file: arguments are not valid JSON']);
  });

  it('rejects JSON that is not an object', () => {
    expect(agentGuardReasons([call('read_file', '["/tmp/a"]')], tools)).toEqual(['read_file: arguments are not a JSON object']);
  });

  it('rejects a tool the agent never declared', () => {
    expect(agentGuardReasons([call('rm_rf', '{}')], tools)).toEqual(['rm_rf: not a declared tool']);
  });

  it('rejects a call without a name', () => {
    expect(agentGuardReasons([call('', '{}')], tools)).toEqual(['tool call without a name']);
  });

  it('rejects arguments that break the declared schema', () => {
    const [reason] = agentGuardReasons([call('read_file', '{"file":"x"}')], tools);
    expect(reason).toMatch(/^read_file: .*path/);
  });

  it('does not judge names when no tools were declared', () => {
    expect(agentGuardReasons([call('anything', '{}')], [])).toEqual([]);
  });
});

describe('agentGuardError', () => {
  it('fails over and rules the model out, but is penalised (no skipBench)', () => {
    const err = agentGuardError('groq/x', ['rm_rf: not a declared tool']) as any;
    expect(isRetryableError(err)).toBe(true);
    expect(err.skipModelForRequest).toBe(true);
    expect(err.skipBench).toBeUndefined();
  });
});

describe('isAgentGuardEnabled', () => {
  const saved = process.env.AGENT_GUARD;
  afterEach(() => { if (saved === undefined) delete process.env.AGENT_GUARD; else process.env.AGENT_GUARD = saved; });

  it('is on by default', () => {
    delete process.env.AGENT_GUARD;
    expect(isAgentGuardEnabled()).toBe(true);
  });

  it('can be switched off', () => {
    process.env.AGENT_GUARD = '0';
    expect(isAgentGuardEnabled()).toBe(false);
  });
});
