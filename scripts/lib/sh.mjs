import { spawnSync } from 'node:child_process';

/**
 * Run a command, capture output. Never throws; check `.ok`.
 * No shell: callers run real executables (docker, kubectl, tilt), which Windows finds without one,
 * and a shell would re-parse the args (Node 24 warns about it: DEP0190).
 */
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    ok: res.status === 0 && !res.error,
    status: res.status,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim() || res.error?.message || '',
  };
}

export const has = (cmd) => run(cmd, ['--version']).ok || run(cmd, ['version', '--client']).ok;

export const c = {
  ok: (s) => `\x1b[32m✔\x1b[0m ${s}`,
  bad: (s) => `\x1b[31m✖\x1b[0m ${s}`,
  warn: (s) => `\x1b[33m!\x1b[0m ${s}`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
