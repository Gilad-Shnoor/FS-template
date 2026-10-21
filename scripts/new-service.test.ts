// Proves `new-service` output works, not just that it exists: generate an http service (db + redis
// + rabbitmq) and a worker in a sandbox, typecheck them, and run their own tests against this run's
// containers. The sandbox lives in the repo's gitignored .tmp/ so Node finds the repo's node_modules
// by walking up (no links, so it behaves the same on Windows, macOS and Linux).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerUrls } from '@app/server-kit/testing-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newService } from './lib/generate.mjs';
import { renderAll, writeRendered } from './lib/render.mjs';
import { loadStack } from './lib/stack.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = path.join(repo, '.tmp', `sandbox-${randomUUID()}`);
const services = ['billing', 'jobs'];
const posix = (p: string) => p.replaceAll('\\', '/');

/** Run a Node CLI from the repo's node_modules; never throws. */
function exec(bin: string, args: string[], env = process.env) {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile(process.execPath, [path.join(repo, 'node_modules', bin), ...args], { cwd: sandbox, env }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: `${stdout}\n${stderr}` }),
    );
  });
}

beforeAll(() => {
  mkdirSync(sandbox, { recursive: true });
  for (const p of ['templates', 'scripts/lib', 'packages/contracts/src', 'packages/contracts/package.json', 'vitest.global-setup.ts']) {
    cpSync(path.join(repo, p), path.join(sandbox, p), { recursive: true });
  }
  writeFileSync(path.join(sandbox, 'stack.json'), JSON.stringify({ project: 'fs-template', services: { api: { template: 'http', db: 'own' } } }));
  newService(sandbox, 'billing', { db: 'own', uses: 'redis,rabbitmq' });
  newService(sandbox, 'jobs', { template: 'worker' });
  writeRendered(sandbox, renderAll(loadStack(sandbox), sandbox));

  // @app/contracts must resolve to the sandbox's copy, which has the new services' contracts
  // (the repo's node_modules link points at the repo's).
  const contracts = posix(path.join(sandbox, 'packages/contracts/src'));
  const base = JSON.parse(readFileSync(path.join(repo, 'tsconfig.base.json'), 'utf8'));
  base.compilerOptions.paths = { '@app/contracts': [`${contracts}/index.ts`], '@app/contracts/*': [`${contracts}/*/index.ts`] };
  writeFileSync(path.join(sandbox, 'tsconfig.base.json'), JSON.stringify(base, null, 2));
  writeFileSync(
    path.join(sandbox, 'vitest.config.ts'),
    [
      `const contracts = ${JSON.stringify(contracts)};`,
      'const alias = [',
      '  { find: /^@app\\/contracts$/, replacement: `${contracts}/index.ts` },',
      '  { find: /^@app\\/contracts\\/(.*)$/, replacement: `${contracts}/$1/index.ts` },',
      '];',
      'export default {',
      '  test: {',
      "    globalSetup: ['./vitest.global-setup.ts'],",
      `    projects: ${JSON.stringify(services)}.map((name) => ({ resolve: { alias }, test: { name, root: \`apps/\${name}\` } })),`,
      '  },',
      '};',
      '',
    ].join('\n'),
  );
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe('generated services', () => {
  it.each(services)('%s typechecks', async (name) => {
    const { ok, output } = await exec('typescript/bin/tsc', ['--noEmit', '-p', path.join('apps', name, 'tsconfig.json')]);
    expect(ok, output).toBe(true);
  });

  it("pass their own tests against this run's containers", async () => {
    // The outer run's VITEST_* vars would confuse the nested run, and forced colours (CI sets
    // FORCE_COLOR) would put escape codes in the summary this test reads.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'FORCE_COLOR'));
    env.NO_COLOR = '1';
    env.TEST_SHARED_CONTAINERS = JSON.stringify(containerUrls());
    const { ok, output } = await exec('vitest/vitest.mjs', ['run'], env);
    expect(ok, output).toBe(true);
    expect(output).toMatch(/Test Files\s+2 passed \(2\)/);
  });
}, 180_000);
