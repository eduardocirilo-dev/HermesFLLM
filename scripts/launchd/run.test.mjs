// scripts/launchd/run.sh: picks a Node that can run the server, rotates the log by size, and fails
// with a readable message instead of a restart loop. Fake `node` executables stand in for real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.sh');

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hermes-run-'));
  mkdirSync(path.join(root, 'repo', 'server'), { recursive: true });
  mkdirSync(path.join(root, 'bin'));
  mkdirSync(path.join(root, 'home'));
  return root;
}

/** A fake node: `-e` (the better-sqlite3 check) exits with `loads`; otherwise prints `lines` lines. */
function fakeNode(root, name, { loads = true, lines = 3 } = {}) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'node');
  writeFileSync(file, `#!/bin/bash
if [ "$1" = "-e" ]; then exit ${loads ? 0 : 1}; fi
if [ "$1" = "-v" ]; then echo v0-fake; exit 0; fi
echo "started by ${name} in $(pwd)"
for ((i = 1; i <= ${lines}; i++)); do echo "line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done
`);
  chmodSync(file, 0o755);
  return file;
}

function run(root, env) {
  return new Promise(resolve => {
    execFile('/bin/bash', [RUN], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: path.join(root, 'home'),
        NVM_DIR: path.join(root, 'no-nvm'),
        HERMESFLLM_REPO: path.join(root, 'repo'),
        HERMESFLLM_LOG: path.join(root, 'logs', 'hermesfllm.log'),
        HERMESFLLM_EXTRA_PATH: '',
        HERMESFLLM_NO_NODE_WAIT_S: '0',
        ...env,
      },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

const log = root => readFileSync(path.join(root, 'logs', 'hermesfllm.log'), 'utf8');

test('runs the server with the install-time Node when it still works', async () => {
  const root = setup();
  const node = fakeNode(root, 'installed');
  const { code } = await run(root, { HERMESFLLM_NODE: node });
  assert.equal(code, 0);
  assert.match(log(root), /started by installed in .*\/repo\/server/);
  assert.doesNotMatch(log(root), /instead of the install-time Node/);
  rmSync(root, { recursive: true, force: true });
});

test('falls back to the Node on PATH when the install-time one is gone (nvm uninstall)', async () => {
  const root = setup();
  fakeNode(root, 'brew');
  const { code } = await run(root, { HERMESFLLM_NODE: path.join(root, 'deleted', 'node'), HERMESFLLM_EXTRA_PATH: path.join(root, 'brew') });
  assert.equal(code, 0);
  assert.match(log(root), /started by brew/);
  assert.match(log(root), /using .*brew\/node .* instead of the install-time Node/);
  rmSync(root, { recursive: true, force: true });
});

test('skips a Node that cannot load the native module (another ABI)', async () => {
  const root = setup();
  const wrongAbi = fakeNode(root, 'node24', { loads: false });
  fakeNode(root, 'node22');
  const { code } = await run(root, { HERMESFLLM_NODE: wrongAbi, HERMESFLLM_EXTRA_PATH: path.join(root, 'node22') });
  assert.equal(code, 0);
  assert.match(log(root), /skipping .*node24\/node: missing, or it cannot load better-sqlite3/);
  assert.match(log(root), /started by node22/);
  rmSync(root, { recursive: true, force: true });
});

test('with no usable Node, says how to fix it and exits instead of looping', async () => {
  const root = setup();
  const wrongAbi = fakeNode(root, 'node24', { loads: false });
  const { code } = await run(root, { HERMESFLLM_NODE: wrongAbi });
  assert.notEqual(code, 0);
  assert.match(log(root), /no Node can run the server\. Fix: .*npm rebuild better-sqlite3/);
  rmSync(root, { recursive: true, force: true });
});

test('rotates the log by size while the server runs, keeping a bounded number of files', async () => {
  const root = setup();
  const node = fakeNode(root, 'installed', { lines: 3000 });
  const { code } = await run(root, { HERMESFLLM_NODE: node, HERMESFLLM_LOG_MAX_BYTES: '20000', HERMESFLLM_LOG_KEEP: '2', HERMESFLLM_LOG_CHECK_EVERY: '50' });
  assert.equal(code, 0);
  const files = readdirSync(path.join(root, 'logs')).sort();
  assert.deepEqual(files, ['hermesfllm.log', 'hermesfllm.log.1', 'hermesfllm.log.2']);
  for (const f of files) assert.ok(statSync(path.join(root, 'logs', f)).size < 20000 + 50 * 80, `${f} stays near the cap`);
  assert.match(log(root), /line 3000 /); // nothing lost at the end
  assert.ok(!existsSync(path.join(root, 'logs', 'hermesfllm.log.3')));
  rmSync(root, { recursive: true, force: true });
});

test('passes the server exit code through, so launchd sees a crash', async () => {
  const root = setup();
  const dir = path.join(root, 'crashy');
  mkdirSync(dir);
  const file = path.join(dir, 'node');
  writeFileSync(file, '#!/bin/bash\nif [ "$1" = "-e" ]; then exit 0; fi\necho boom\nexit 7\n');
  chmodSync(file, 0o755);
  const { code } = await run(root, { HERMESFLLM_NODE: file });
  assert.equal(code, 7);
  assert.match(log(root), /boom/);
  rmSync(root, { recursive: true, force: true });
});
