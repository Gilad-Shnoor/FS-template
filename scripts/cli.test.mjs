// node --test scripts/   (npm run test:scripts)
// Every CLI error is a one-line, actionable message (no stack traces), exits 1, and leaves
// stack.json untouched. Runs the real CLI against a sandbox copy of the repo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURE_STACK = {
  project: 'fs-template',
  addons: { redis: { enabled: false }, rabbitmq: { enabled: true } },
  services: {
    web: { template: 'web', public: 'app.localhost', routes: { '/api': 'api' } },
    api: { template: 'http', db: 'own', uses: [], calls: [], replicas: 1, env: {} },
    emails: { template: 'worker', db: 'none', uses: ['rabbitmq'] },
  },
};

function sandbox(stack = FIXTURE_STACK) {
  const dir = mkdtempSync(path.join(tmpdir(), 'stack-cli-'));
  for (const p of ['scripts', 'templates', 'infra/k8s', 'packages/contracts/src']) {
    cpSync(path.join(repo, p), path.join(dir, p), { recursive: true });
  }
  writeFileSync(path.join(dir, 'stack.json'), typeof stack === 'string' ? stack : JSON.stringify(stack, null, 2));
  return dir;
}

function cli(dir, ...args) {
  const res = spawnSync(process.execPath, [path.join(dir, 'scripts/stack.mjs'), ...args], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

/** [args, expected message]: each must fail cleanly without touching stack.json. */
const ERRORS = [
  [['bogus'], /✖ Unknown command "bogus"/],
  [['new-service'], /✖ Usage: new-service <name>/],
  [['new-service', 'Billing'], /✖ Service name "Billing" must be lowercase kebab-case, 2-32 chars, starting with a letter/],
  [['new-service', 'api'], /✖ Service "api" already exists in stack\.json/],
  [['new-service', 'billing', '--template', 'web'], /✖ --template must be http or worker, got "web"/],
  [['new-service', 'billing', '--db', 'foo'], /✖ --db must be one of own, shared, none, got "foo"/],
  [['new-service', 'billing', '--replicas', 'abc'], /✖ --replicas must be a positive integer, got "abc"/],
  [['new-service', 'billing', '--replicas', '0'], /✖ --replicas must be a positive integer, got "0"/],
  [['new-service', 'billing', '--uses', 'kafka'], /✖ --uses: unknown add-on "kafka" \(known: redis, rabbitmq\)/],
  [['new-service', 'billing', '--consumers', 'ghost'], /✖ --consumers: unknown service "ghost" \(services: web, api, emails\)/],
  [['new-service', 'billing', '--public', 'app.localhost'], /✖ Nothing changed: .*\n.*host "app\.localhost" already used by web/],
  [['new-service', 'billing', '--frobnicate'], /✖ Unknown option '--frobnicate'/],
  [['remove-service'], /✖ Usage: remove-service <name>/],
  [['remove-service', 'ghost'], /✖ Unknown service "ghost" \(services: web, api, emails\)/],
  [['addon'], /✖ Usage: addon <redis\|rabbitmq>/],
  [['addon', 'kafka'], /✖ Unknown add-on "kafka" \(known: redis, rabbitmq\)/],
  [['addon', 'rabbitmq', '--disable'], /✖ Can't disable "rabbitmq": used by emails\. First run: npm run stack -- use emails rabbitmq --remove/],
  [['use'], /✖ Usage: use <service>/],
  [['use', 'api'], /✖ Usage: use <service>/],
  [['use', 'api', 'kafka'], /✖ Unknown add-on "kafka" \(known: redis, rabbitmq\)/],
  [['use', 'ghost', 'redis'], /✖ Unknown service "ghost" \(services: web, api, emails\)/],
  [['use', 'web', 'redis'], /✖ Nothing changed: .*\n.*web services can't use add-ons/],
  [['use', 'emails', 'rabbitmq', '--remove'], /✖ Nothing changed: .*\n.*worker services consume events, so they must use "rabbitmq"/],
  [['link'], /✖ Usage: link <from> <to>/],
  [['link', 'ghost', 'api'], /✖ Unknown service "ghost" \(services: web, api, emails\)/],
  [['link', 'api', 'ghost'], /✖ Nothing changed: .*\n.*unknown service "ghost" \(services: web, api, emails\)/],
  [['link', 'api', 'api'], /✖ Nothing changed: .*\n.*a service can't call itself/],
  [['link', 'api', 'emails'], /✖ Nothing changed: .*\n.*"emails" is a worker service; only http services can be called/],
  [['link', 'web', 'api'], /✖ Nothing changed: .*\n.*web services can't call services directly; route a path to them instead/],
  [['grant'], /✖ Usage: grant <owner> <grantee> <levels\|none>/],
  [['grant', 'api', 'emails'], /✖ Usage: grant <owner> <grantee> <levels\|none>/],
  [['grant', 'ghost', 'api', 'read'], /✖ Unknown service "ghost" \(services: web, api, emails\)/],
  [['grant', 'api', 'ghost', 'read'], /✖ Nothing changed: .*\n.*unknown service "ghost" \(services: web, api, emails\)/],
  [['grant', 'api', 'api', 'read'], /✖ Nothing changed: .*\n.*api owns this schema, so it already has full access/],
  [['grant', 'api', 'emails', 'read'], /✖ Nothing changed: .*\n.*"emails" has db "none", so it has no role to grant to/],
  [['grant', 'web', 'api', 'read'], /✖ Nothing changed: .*\n.*grants only apply to db mode "own" \(web has db "none", so it owns no schema\)/],
  [['grant', 'api', 'web', 'readwrite'], /✖ grant levels "readwrite": unknown level "readwrite" \(known: read \| write \| modify \| delete\)/],
  [['grant', 'api', 'web', 'modify'], /✖ grant levels "modify": modify\/delete require read/],
  [['migrate', 'ghost'], /✖ Unknown service "ghost" \(services: web, api, emails\)/],
  [['migrate', 'web'], /✖ "web" has no database \(db: none\) \(services with one: api\)/],
];

test('CLI errors are specific, exit 1 and leave stack.json untouched', () => {
  const dir = sandbox();
  const before = readFileSync(path.join(dir, 'stack.json'), 'utf8');
  for (const [args, message] of ERRORS) {
    const { status, out } = cli(dir, ...args);
    const shown = `stack ${args.join(' ')}\n${out}`;
    assert.equal(status, 1, `should fail:\n${shown}`);
    assert.match(out, message, shown);
    assert.doesNotMatch(out, /^\s+at /m, `no stack trace:\n${shown}`);
    assert.equal(readFileSync(path.join(dir, 'stack.json'), 'utf8'), before, `stack.json changed:\n${shown}`);
  }
});

test('a broken or missing stack.json is reported as such, not as a crash', () => {
  const cases = [
    ['{ broken', /✖ Cannot read stack\.json: /],
    [JSON.stringify({ services: { api: null } }), /✖ stack\.json is invalid:\n\s+- services\.api: must be an object/],
    [JSON.stringify({ services: { api: { replicas: 'two' } } }), /services\.api\.replicas: must be a positive integer, got "two"/],
  ];
  for (const [content, message] of cases) {
    const { status, out } = cli(sandbox(content), 'list');
    assert.equal(status, 1, out);
    assert.match(out, message);
    assert.doesNotMatch(out, /^\s+at /m, out);
  }

  const dir = sandbox();
  rmSync(path.join(dir, 'stack.json'));
  const { status, out } = cli(dir, 'list');
  assert.equal(status, 1, out);
  assert.match(out, /✖ stack\.json not found at .*stack\.json/);
});

test('an edit is blamed on stack.json only when the file itself is invalid', () => {
  // The file is already broken (unknown route target), so a valid edit must report the file's problem.
  const broken = structuredClone(FIXTURE_STACK);
  broken.services.web.routes = { '/api': 'ghost' };
  const { status, out } = cli(sandbox(broken), 'link', 'api', 'api');
  assert.equal(status, 1, out);
  assert.match(out, /✖ stack\.json is invalid:\n.*services\.web\.routes: unknown service "ghost"/);
});
