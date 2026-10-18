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
import * as stackLib from './lib/stack.mjs';

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
  // Unused args would fail `npm run lint` in any repo with such a service.
  assert.ok(notes.includes('connectStack(_config: '), 'unused connectStack args must be _-prefixed');
  assert.ok(billing.includes('connectStack(config: '));
});

test('new services come with tests that the root vitest run picks up', () => {
  const dir = sandbox();
  newService(dir, 'billing', { db: 'own', uses: 'redis,rabbitmq' });
  newService(dir, 'jobs', { template: 'worker' });

  for (const [name, file] of [['billing', 'src/app.test.ts'], ['jobs', 'src/handlers.test.ts']]) {
    const src = read(dir, `apps/${name}/${file}`);
    assert.doesNotMatch(src, /__\w+__|@if|@endif/, `${name}: unresolved template markers`);
    assert.ok(src.includes(`serviceEnv('${name}')`), `${name}: test should use its own service env`);
    // No per-service test script: one root `vitest run` covers every workspace.
    assert.equal(JSON.parse(read(dir, `apps/${name}/package.json`)).scripts.test, undefined);
  }
  assert.match(read(repo, 'vitest.config.ts'), /'apps\/\*'/, 'root vitest.config.ts must include apps/* as projects');
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
  setGrant(dir, 'api', 'reports', ['read']);
  const sql = provisionSql(loadStack(dir));
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA "api" FROM "reports"/);
  assert.match(sql, /GRANT SELECT ON ALL TABLES IN SCHEMA "api" TO "reports"/);
  setGrant(dir, 'api', 'reports', 'none');
  assert.doesNotMatch(provisionSql(loadStack(dir)), /GRANT SELECT ON ALL TABLES IN SCHEMA "api"/);
});

// ---------------------------------------------------------------- granular grants

/** api owns a schema; reports gets `grant` on it. */
const grantStack = (grant) => ({
  project: 'grants-test',
  services: {
    api: { template: 'http', db: { mode: 'own', grants: { reports: grant } } },
    reports: { template: 'http', db: 'own' },
  },
});
const grantSql = (grant) => provisionSql(normalizeStack(grantStack(grant)));
const rejects = (grant, message) =>
  assert.throws(() => normalizeStack(grantStack(grant)), (err) => err instanceof StackError && message.test(err.message));

test('each grant level maps to its table privilege, in a fixed order', () => {
  const cases = [
    [['read'], 'SELECT'],
    [['write'], 'INSERT'],
    [['read', 'write'], 'SELECT, INSERT'],
    [['read', 'modify'], 'SELECT, UPDATE'],
    [['read', 'delete'], 'SELECT, DELETE'],
    [['delete', 'modify', 'write', 'read'], 'SELECT, INSERT, UPDATE, DELETE'],
  ];
  for (const [grant, privs] of cases) {
    const sql = grantSql(grant);
    assert.ok(sql.includes(`GRANT USAGE ON SCHEMA "api" TO "reports";`), `${grant}: schema usage`);
    assert.ok(sql.includes(`GRANT ${privs} ON ALL TABLES IN SCHEMA "api" TO "reports";`), `${grant}: existing tables get ${privs}`);
    assert.ok(
      sql.includes(`ALTER DEFAULT PRIVILEGES FOR ROLE "api" IN SCHEMA "api" GRANT ${privs} ON TABLES TO "reports";`),
      `${grant}: future tables get ${privs}`,
    );
  }
});

test('only write grants sequence usage (so inserts can use serial/identity defaults)', () => {
  const sequenceGrants = /GRANT USAGE, SELECT ON (ALL SEQUENCES IN SCHEMA "api"|SEQUENCES) TO "reports"/g;
  for (const grant of [['write'], ['read', 'write'], ['read', 'write', 'modify', 'delete']]) {
    assert.equal(grantSql(grant).match(sequenceGrants)?.length, 2, `${grant}: existing + future sequences`);
  }
  for (const grant of [['read'], ['read', 'modify'], ['read', 'delete'], ['read', 'modify', 'delete']]) {
    assert.doesNotMatch(grantSql(grant), sequenceGrants, `${grant}: no sequence grants`);
  }
});

test('grant levels are stored in a fixed order, whatever order stack.json lists them in', () => {
  assert.deepEqual(normalizeStack(grantStack(['delete', 'read'])).services.api.db.grants.reports, ['read', 'delete']);
  assert.equal(grantSql(['modify', 'write', 'read']), grantSql(['read', 'write', 'modify']));
});

test('a grant must be a non-empty array of known levels', () => {
  rejects('read', /db\.grants\.reports: must be an array of read \| write \| modify \| delete/);
  rejects('readwrite', /db\.grants\.reports: must be an array of read \| write \| modify \| delete/);
  rejects([], /db\.grants\.reports: .*at least one level/);
  rejects(['readwrite'], /db\.grants\.reports: .*unknown level "readwrite"/);
  rejects(['read', 'execute'], /db\.grants\.reports: .*unknown level "execute"/);
  rejects(['read', 'read'], /db\.grants\.reports: .*duplicate level "read"/);
});

test('modify and delete require read (Postgres needs SELECT for WHERE and RETURNING)', () => {
  for (const grant of [['modify'], ['delete'], ['write', 'modify'], ['modify', 'delete']]) {
    rejects(grant, /db\.grants\.reports: modify\/delete require read/);
  }
  for (const grant of [['write'], ['read', 'modify'], ['read', 'delete']]) {
    assert.doesNotThrow(() => normalizeStack(grantStack(grant)), `${grant} is valid`);
  }
});

test('the grant CLI parses a comma-separated level list or none', () => {
  const { parseGrantLevels } = stackLib;
  assert.deepEqual(parseGrantLevels('read'), ['read']);
  assert.deepEqual(parseGrantLevels('modify,read'), ['read', 'modify']);
  assert.deepEqual(parseGrantLevels(' read , write '), ['read', 'write']);
  assert.equal(parseGrantLevels('none'), 'none');
  for (const bad of ['', 'readwrite', 'read,read', 'read,none', 'modify']) {
    assert.throws(() => parseGrantLevels(bad), StackError, `"${bad}" should be rejected`);
  }
});

test('setGrant stores the array, removes with none, and refuses invalid grants without writing', () => {
  const dir = sandbox();
  newService(dir, 'reports', { db: 'own' });
  const rawApi = () => JSON.parse(read(dir, 'stack.json')).services.api;

  setGrant(dir, 'api', 'reports', ['modify', 'read']);
  assert.deepEqual(rawApi().db, { mode: 'own', grants: { reports: ['read', 'modify'] } });

  assert.throws(() => setGrant(dir, 'api', 'reports', ['delete']), /modify\/delete require read/);
  assert.deepEqual(rawApi().db.grants.reports, ['read', 'modify'], 'stack.json unchanged after a rejected grant');

  setGrant(dir, 'api', 'reports', 'none');
  assert.equal(rawApi().db, 'own');
});

test('linking to a worker is rejected', () => {
  const dir = sandbox();
  newService(dir, 'emails', { template: 'worker' });
  assert.throws(() => setLink(dir, 'api', 'emails', true), /only http services can be called/);
});
