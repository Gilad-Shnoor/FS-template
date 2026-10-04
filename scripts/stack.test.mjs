// node --test scripts/   (npm run test:scripts)
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { newService, preprocess, setGrant, setLink, setUses } from './lib/generate.mjs';
import { provisionSql, renderAll, writeRendered } from './lib/render.mjs';
import { StackError, loadStack, normalizeStack } from './lib/stack.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fixed web + api topology, so the tests don't depend on what the working tree's stack.json
// currently contains (e.g. services you're experimenting with).
const FIXTURE_STACK = {
  project: 'fs-template',
  addons: { redis: { enabled: false }, rabbitmq: { enabled: false } },
  services: {
    web: { template: 'web', public: 'app.localhost', routes: { '/api': 'api' } },
    api: { template: 'http', db: 'own', uses: [], calls: [], replicas: 1, env: {} },
  },
};

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'stack-'));
  for (const p of ['templates', 'apps/api/src', 'infra/k8s', 'packages/contracts/src']) {
    cpSync(path.join(repo, p), path.join(dir, p), { recursive: true });
  }
  writeFileSync(path.join(dir, 'stack.json'), JSON.stringify(FIXTURE_STACK, null, 2));
  render(dir); // generated files (e.g. apps/api/src/stack.gen.ts) now match the fixture
  return dir;
}

function render(dir) {
  return writeRendered(dir, renderAll(loadStack(dir), dir));
}
const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');

test('the committed stack is valid and its generated files are up to date', () => {
  const stack = loadStack(repo);
  assert.deepEqual(writeRendered(repo, renderAll(stack, repo), { check: true }), []);
});

test('package-lock.json lists exactly the workspaces that exist', () => {
  // npm keeps lock entries for deleted workspace folders (e.g. after removing a generated
  // service), which pins their stale dependency ranges and skews hoisting.
  const lock = JSON.parse(readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
  const locked = Object.keys(lock.packages).filter((k) => /^(apps|packages)\/[^/]+$/.test(k)).sort();
  const actual = ['apps', 'packages']
    .flatMap((dir) => readdirSync(path.join(repo, dir)).map((name) => `${dir}/${name}`))
    .filter((ws) => existsSync(path.join(repo, ws, 'package.json')))
    .sort();
  assert.deepEqual(locked, actual, 'lockfile out of sync: run npm install (after deleting a workspace: rm package-lock.json && npm install)');
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
  assert.doesNotMatch(index, /@if/);
  assert.ok(index.includes('await connectStack(config, logger)'));
});

test('stack.gen.ts connects exactly what stack.json declares', () => {
  const dir = sandbox();
  newService(dir, 'billing', { db: 'own', uses: 'redis,rabbitmq' });
  newService(dir, 'notes', { db: 'none' });
  render(dir);

  const billing = read(dir, 'apps/billing/src/stack.gen.ts');
  for (const s of ['createDb(', 'createRedis(', 'createBroker(', 'db: Knex;', 'redis: Redis;', 'broker: Broker;', 'readiness.rabbitmq = ']) {
    assert.ok(billing.includes(s), `billing stack.gen.ts lacks ${s}`);
  }

  const notes = read(dir, 'apps/notes/src/stack.gen.ts');
  for (const mod of ['db', 'redis', 'rabbitmq']) assert.ok(!notes.includes(`@app/server-kit/${mod}`), mod);
  assert.ok(notes.includes('return { db: undefined, redis: undefined, broker: undefined, readiness, cleanup };'));
});

test('using an add-on wires it into an existing service', () => {
  const dir = sandbox();
  assert.ok(read(dir, 'apps/api/src/stack.gen.ts').includes('redis: undefined;'));
  setUses(dir, 'api', 'redis', true);
  render(dir);
  const api = read(dir, 'apps/api/src/stack.gen.ts');
  for (const s of ['...redisEnvSchema.shape', 'redis: Redis;', 'readiness.redis = () => redis.ping();', 'cleanup.push(() => redis.quit());']) {
    assert.ok(api.includes(s), `api stack.gen.ts lacks ${s}`);
  }
});

test('a worker must use rabbitmq', () => {
  const dir = sandbox();
  newService(dir, 'emails', { template: 'worker' });
  assert.throws(() => setUses(dir, 'emails', 'rabbitmq', false), /must use "rabbitmq"/);
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
