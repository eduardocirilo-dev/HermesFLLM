import { execSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// HermesFLLM build stamp for GET /api/hermesfllm/version: release version (hermesfllm.json),
// commit and build time of the running server, plus when this process started.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const startedAt = new Date().toISOString();

function read(): { name: string; version: string; commit: string | null; builtAt: string | null; startedAt: string } {
  let version = 'dev';
  try { version = JSON.parse(readFileSync(path.join(repoRoot, 'hermesfllm.json'), 'utf8')).version ?? 'dev'; } catch { /* dev */ }
  let commit: string | null = null;
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim() || null;
  } catch { /* not a git checkout */ }
  let builtAt: string | null = null;
  // This file's compiled form is written by `tsc`, so its mtime is the server build time.
  try { builtAt = statSync(fileURLToPath(import.meta.url)).mtime.toISOString(); } catch { /* unknown */ }
  return { name: 'HermesFLLM', version, commit, builtAt, startedAt };
}

// Computed once: the running code does not change until the process restarts.
export const HERMESFLLM_BUILD = read();
