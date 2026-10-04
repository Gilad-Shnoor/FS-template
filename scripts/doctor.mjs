#!/usr/bin/env node
// Checks every prerequisite and prints the exact fix for anything missing.
// Agents: run this first when something about the environment looks wrong.
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, run } from './lib/sh.mjs';
import { StackError, loadStack } from './lib/stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (m) => console.log(c.ok(m));
const bad = (m, fix) => {
  failures++;
  console.log(c.bad(m) + (fix ? `\n    fix: ${fix}` : ''));
};
const warn = (m, fix) => console.log(c.warn(m) + (fix ? `\n    tip: ${fix}` : ''));

let stack;
try {
  stack = loadStack(root);
  ok(`stack.json valid (${Object.keys(stack.services).length} services)`);
} catch (err) {
  bad(err instanceof StackError ? err.message : String(err));
  process.exit(1);
}

const check = (cond, okMsg, badMsg, fix) => (cond ? ok(okMsg) : bad(badMsg, fix));

const [major] = process.versions.node.split('.').map(Number);
check(major >= 22, `node ${process.versions.node}`, `node ${process.versions.node} (need >= 22)`, 'install Node 22 LTS (nvm use)');

check(existsSync(path.join(root, 'node_modules')), 'dependencies installed', 'node_modules missing', 'npm install');

const docker = run('docker', ['info', '--format', '{{.ServerVersion}}']);
check(docker.ok, `docker ${docker.stdout}`, 'docker is not running', 'start Docker Desktop');

const kubectl = run('kubectl', ['version', '--client', '-o', 'json']);
if (!kubectl.ok) bad('kubectl not found', 'Docker Desktop ships kubectl; make sure it is on PATH');
else {
  ok('kubectl installed');
  const contexts = run('kubectl', ['config', 'get-contexts', '-o', 'name']).stdout.split(/\r?\n/);
  if (!contexts.includes(stack.kubeContext)) {
    bad(`kube context "${stack.kubeContext}" not found`, 'Docker Desktop → Settings → Kubernetes → Enable Kubernetes (kubeadm)');
  } else {
    const nodes = run('kubectl', ['--context', stack.kubeContext, 'get', 'nodes', '-o', 'name']);
    check(nodes.ok, `cluster "${stack.kubeContext}" reachable`, `cluster "${stack.kubeContext}" unreachable`, 'wait for Kubernetes to start in Docker Desktop');
    if (nodes.ok) {
      const gc = run('kubectl', ['--context', stack.kubeContext, 'get', 'gatewayclass', stack.gateway.className]);
      check(gc.ok, `GatewayClass "${stack.gateway.className}" installed`, 'Envoy Gateway not installed', 'npm run cluster:setup');
    }
  }
}

const tilt = run('tilt', ['version']);
check(
  tilt.ok,
  `tilt ${tilt.stdout.split(',')[0]}`,
  'tilt not found',
  'macOS/Linux: curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash   Windows: iex ((new-object net.webclient).DownloadString("https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.ps1")), then add %USERPROFILE%\\bin to PATH',
);

for (const host of Object.values(stack.services).map((s) => s.public).filter(Boolean)) {
  try {
    const { address } = await lookup(host);
    if (address === '127.0.0.1' || address === '::1') ok(`${host} → ${address}`);
    else warn(`${host} resolves to ${address}`);
  } catch {
    warn(
      `${host} does not resolve for CLI tools (browsers handle *.localhost themselves)`,
      `add "127.0.0.1 ${host}" to /etc/hosts (Windows: C:\\Windows\\System32\\drivers\\etc\\hosts) for curl/scripts`,
    );
  }
}

console.log(failures ? `\n${failures} problem(s) found.` : '\nAll good. Run: npm run dev');
process.exit(failures ? 1 : 0);
