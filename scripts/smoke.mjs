#!/usr/bin/env node
// End-to-end smoke test against the running stack (after `npm run dev` or `tilt ci`).
// Zero dependencies: Node's fetch + kubectl. Exits non-zero if any check fails.
//
//   npm run smoke                       # against http://<web public host> from stack.json
//   SMOKE_BASE_URL=http://x npm run smoke
//
// Assumes the default api config (AUTH_ENABLED=true). Creates one throwaway user per run.
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, run } from './lib/sh.mjs';
import { loadStack } from './lib/stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stack = loadStack(root);
const web = Object.values(stack.services).find((s) => s.template === 'web' && s.public);
const BASE = process.env.SMOKE_BASE_URL ?? `http://${web?.public ?? 'app.localhost'}`;
const kubectl = (...args) => run('kubectl', ['--context', stack.kubeContext, '-n', stack.namespace, ...args]);

// Browsers resolve *.localhost to loopback themselves (RFC 6761); Node on some OSes (Windows)
// doesn't. Do the same here so the smoke test needs no hosts-file edits.
const systemLookup = dns.lookup;
dns.lookup = (host, opts, cb) => {
  if (typeof opts === 'function') [cb, opts] = [opts, {}];
  if (!/(^|\.)localhost$/i.test(host)) return systemLookup(host, opts, cb);
  return opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
};

// ------------------------------------------------------------------ tiny test harness

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(c.ok(name));
  } catch (err) {
    failed++;
    console.log(c.bad(name) + `\n    ${String(err?.message ?? err).replace(/\n/g, '\n    ')}`);
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}
const show = (v) => JSON.stringify(v)?.slice(0, 400);

let cookie = '';
/** fetch against BASE; returns { status, headers, body (parsed JSON when possible), text }. */
async function http(method, url, { body, headers = {}, auth = true, base = BASE } = {}) {
  const res = await fetch(base + url, {
    method,
    redirect: 'manual',
    headers: {
      accept: 'application/json',
      origin: base, // Better Auth rejects cookie-bearing POSTs without a trusted Origin
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(auth && cookie ? { cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, body: json, text, res };
}
function keepSessionCookie(res) {
  const session = res.headers.getSetCookie().find((h) => /session_token=/.test(h));
  expect(session, `no session cookie in Set-Cookie: ${show(res.headers.getSetCookie())}`);
  cookie = session.split(';')[0];
}
function expectError(r, status, code) {
  expect(r.status === status, `expected ${status}, got ${r.status}: ${r.text.slice(0, 300)}`);
  const e = r.body?.error;
  expect(e && e.code === code, `expected error.code ${code}, got ${show(r.body)}`);
  expect(typeof e.message === 'string' && e.message, `error.message missing: ${show(r.body)}`);
  expect(typeof e.requestId === 'string' && e.requestId, `error.requestId missing: ${show(r.body)}`);
  return e;
}

// ------------------------------------------------------------------ checks

console.log(c.dim(`Smoke testing ${BASE} (namespace ${stack.namespace})\n`));

await check('GET / serves the SPA', async () => {
  const r = await http('GET', '/', { headers: { accept: 'text/html' } });
  expect(r.status === 200, `status ${r.status}`);
  expect(/<div id="root">/.test(r.text), `not the SPA shell: ${r.text.slice(0, 200)}`);
});

await check('GET /api/readyz is 200 with checks.db.ok', async () => {
  const r = await http('GET', '/api/readyz');
  expect(r.status === 200, `status ${r.status}: ${r.text.slice(0, 300)}`);
  expect(r.body?.checks?.db?.ok === true, `checks: ${show(r.body?.checks)}`);
});

await check('api has no public host (no api.localhost route, requests don\'t reach it)', async () => {
  const routes = kubectl('get', 'httproute', '-o', 'json');
  expect(routes.ok, `kubectl get httproute failed: ${routes.stderr}`);
  const hosts = JSON.parse(routes.stdout).items.flatMap((i) => i.spec.hostnames ?? []);
  expect(!hosts.includes('api.localhost'), `an HTTPRoute serves api.localhost: ${show(hosts)}`);
  const r = await http('GET', '/api/readyz', { base: 'http://api.localhost', auth: false });
  expect(r.status === 404, `api.localhost answered ${r.status}`);
  expect(!r.headers.get('x-request-id') && r.body?.service !== 'api', 'response came from the api');
});

await check('GET /api/todos without a session is 401 UNAUTHORIZED', async () => {
  const r = await http('GET', '/api/todos', { auth: false });
  expectError(r, 401, 'UNAUTHORIZED');
});

const email = `smoke-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
const password = `pw-${randomUUID()}`;
await check('sign up, sign in again, /api/me returns the user', async () => {
  const up = await http('POST', '/api/auth/sign-up/email', { body: { email, password, name: 'Smoke Test' }, auth: false });
  expect(up.status === 200, `sign-up ${up.status}: ${up.text.slice(0, 300)}`);
  keepSessionCookie(up);
  const before = cookie;
  const signIn = await http('POST', '/api/auth/sign-in/email', { body: { email, password }, auth: false });
  expect(signIn.status === 200, `sign-in ${signIn.status}: ${signIn.text.slice(0, 300)}`);
  keepSessionCookie(signIn);
  expect(cookie !== before, 'sign-in did not issue a new session');
  const me = await http('GET', '/api/me');
  expect(me.status === 200, `me ${me.status}`);
  expect(me.body?.user?.email === email, `me.user: ${show(me.body)}`);
  expect(me.body?.authEnabled === true, `authEnabled: ${show(me.body)}`);
});

await check('todo CRUD', async () => {
  expect(cookie, 'no session (sign-up failed)');
  const created = await http('POST', '/api/todos', { body: { title: '  smoke todo  ' } });
  expect(created.status === 201, `create ${created.status}: ${created.text.slice(0, 300)}`);
  expect(created.body?.title === 'smoke todo', `title not trimmed: ${show(created.body)}`);
  const id = created.body.id;

  const list = await http('GET', '/api/todos');
  expect(list.status === 200 && list.body.items.some((t) => t.id === id), `list: ${show(list.body)}`);

  const open = await http('GET', '/api/todos?completed=true');
  expect(open.status === 200 && !open.body.items.some((t) => t.id === id), `?completed=true included an open todo`);

  const patched = await http('PATCH', `/api/todos/${id}`, { body: { completed: true } });
  expect(patched.status === 200 && patched.body?.completed === true, `patch ${patched.status}: ${show(patched.body)}`);

  const done = await http('GET', '/api/todos?completed=true');
  expect(done.status === 200 && done.body.items.some((t) => t.id === id), `?completed=true: ${show(done.body)}`);
  expect(done.body.items.every((t) => t.completed), `?completed=true returned open todos`);

  const del = await http('DELETE', `/api/todos/${id}`);
  expect(del.status === 204, `delete ${del.status}: ${del.text}`);
  expectError(await http('DELETE', `/api/todos/${id}`), 404, 'NOT_FOUND');
});

await check('validation errors are 400 VALIDATION_FAILED with details', async () => {
  const empty = expectError(await http('POST', '/api/todos', { body: { title: '' } }), 400, 'VALIDATION_FAILED');
  expect(Array.isArray(empty.details) && empty.details.length, `details: ${show(empty)}`);
  const badId = expectError(await http('PATCH', '/api/todos/not-a-uuid', { body: { completed: true } }), 400, 'VALIDATION_FAILED');
  expect(Array.isArray(badId.details) && badId.details.length, `details: ${show(badId)}`);
});

await check('x-request-id is echoed and appears in the api logs', async () => {
  const id = `smoke-${randomUUID()}`;
  const r = await http('GET', '/api/me', { headers: { 'x-request-id': id } });
  expect(r.headers.get('x-request-id') === id, `echoed ${r.headers.get('x-request-id')}`);
  for (let attempt = 0; ; attempt++) {
    const logs = kubectl('logs', '-l', 'app.kubernetes.io/name=api', '-c', 'api', '--since=5m', '--tail=-1');
    if (logs.stdout.includes(id)) return;
    if (attempt >= 10) throw new Error(`request id not found in api logs${logs.ok ? '' : `: ${logs.stderr}`}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});

await check('unknown /api route is 404 NOT_FOUND', async () => {
  expectError(await http('GET', '/api/nope'), 404, 'NOT_FOUND');
});

await check('rate limiting headers are present', async () => {
  const r = await http('GET', '/api/me');
  const policy = r.headers.get('ratelimit-policy');
  const state = r.headers.get('ratelimit') ?? r.headers.get('ratelimit-remaining');
  expect(policy && state, `RateLimit headers missing (policy=${policy}, ratelimit=${state})`);
});

console.log(failed ? `\n${c.bad(`${failed} check(s) failed`)}` : `\n${c.ok('All smoke checks passed.')}`);
process.exit(failed ? 1 : 0);
