// node --test scripts/   (npm run test:scripts)
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { newService, preprocess, setGrant, setLink } from './lib/generate.mjs';
import { provisionSql, renderAll, writeRendered } from './lib/render.mjs';
import { StackError, loadStack, normalizeStack } from './lib/stack.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'stack-'));
  for (const p of ['stack.json', 'templates', 'apps/api/src', 'infra/k8s', 'packages/contracts/src']) {
    cpSync(path.join(repo, p), path.join(dir, p), { recursive: true });
  }
  return dir;
}

test('the committed stack is valid and its generated files are up to date', () => {
  const stack = loadStack(repo);
  assert.deepEqual(writeRendered(repo, renderAll(stack, repo), { check: true }), []);
});

test('validation reports every problem at once', () => {
  assert.throws(
    () =>
      normalizeStack({
        project: 'p',
        services: {
          a: { template: 'http', calls: ['ghost'], uses: ['redis'] },
          b: { template: 'web', db: 'own' },
        },
      }),
    (err) => err instanceof StackError && /ghost/.test(err.message) && /redis/.test(err.message) && /web services/.test(err.message),
  );
});

test('preprocess keeps and drops conditional blocks', () => {
  const src = 'a\n// @if db\nb\n// @endif\n// @if !db\nc\n// @endif\nd';
  assert.equal(preprocess(src, { db: true }), 'a\nb\nd');
  assert.equal(preprocess(src, { db: false }), 'a\nc\nd');
});

test('new-service scaffolds files, wires consumers and renders', () => {
  const dir = sandbox();
  newService(dir, 'billing', { db: 'own', consumers: 'api', public: 'billing.localhost' });
  writeRendered(dir, renderAll(loadStack(dir), dir));

  for (const f of ['apps/billing/src/index.ts', 'apps/billing/src/db/cli.ts', 'apps/billing/migrations/20260101000000_init.ts', 'packages/contracts/src/billing/index.ts', 'apps/billing/src/stack.gen.ts']) {
    assert.ok(existsSync(path.join(dir, f)), f);
  }
  const apiGen = readFileSync(path.join(dir, 'apps/api/src/stack.gen.ts'), 'utf8');
  assert.match(apiGen, /BILLING_URL/);
  assert.match(apiGen, /billingRoutes/);
  const apiManifest = readFileSync(path.join(dir, 'infra/k8s/generated/50-service-api.yaml'), 'utf8');
  assert.match(apiManifest, /name: BILLING_URL\n\s+value: "?http:\/\/billing:3000/);
  const index = readFileSync(path.join(dir, 'apps/billing/src/index.ts'), 'utf8');
  assert.doesNotMatch(index, /@if|createRedis/);
  assert.match(index, /createDb/);
});

test('worker without db gets rabbitmq and no db files', () => {
  const dir = sandbox();
  newService(dir, 'emails', { template: 'worker' });
  const stack = loadStack(dir);
  assert.equal(stack.addons.rabbitmq.enabled, true);
  assert.deepEqual(stack.services.emails.uses, ['rabbitmq']);
  assert.ok(!existsSync(path.join(dir, 'apps/emails/src/db/cli.ts')));
  const pkg = JSON.parse(readFileSync(path.join(dir, 'apps/emails/package.json'), 'utf8'));
  assert.equal(pkg.scripts['db:migrate'], undefined);
});

test('grants are declarative: revoke all, then grant what stack.json says', () => {
  const dir = sandbox();
  newService(dir, 'reports', { db: 'own' });
  setGrant(dir, 'api', 'reports', 'read');
  const sql = provisionSql(loadStack(dir));
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA "api" FROM "reports"/);
  assert.match(sql, /GRANT SELECT ON ALL TABLES IN SCHEMA "api" TO "reports"/);
  setGrant(dir, 'api', 'reports', 'none');
  assert.doesNotMatch(provisionSql(loadStack(dir)), /GRANT SELECT ON ALL TABLES IN SCHEMA "api"/);
});

test('linking to a worker is rejected', () => {
  const dir = sandbox();
  newService(dir, 'emails', { template: 'worker' });
  assert.throws(() => setLink(dir, 'api', 'emails', true), /only http services can be called/);
});
