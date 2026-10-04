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

const [major] = process.versions.node.split('.').map(Number);
major >= 22 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node} (need >= 22)`, 'install Node 22 LTS (nvm use)');

existsSync(path.join(root, 'node_modules')) ? ok('dependencies installed') : bad('node_modules missing', 'npm install');

const docker = run('docker', ['info', '--format', '{{.ServerVersion}}']);
docker.ok ? ok(`docker ${docker.stdout}`) : bad('docker is not running', 'start Docker Desktop');

const kubectl = run('kubectl', ['version', '--client', '-o', 'json']);
if (!kubectl.ok) bad('kubectl not found', 'Docker Desktop ships kubectl; make sure it is on PATH');
else {
  ok('kubectl installed');
  const contexts = run('kubectl', ['config', 'get-contexts', '-o', 'name']).stdout.split('\n');
  if (!contexts.includes(stack.kubeContext)) {
    bad(`kube context "${stack.kubeContext}" not found`, 'Docker Desktop → Settings → Kubernetes → Enable Kubernetes (kubeadm)');
  } else {
    const nodes = run('kubectl', ['--context', stack.kubeContext, 'get', 'nodes', '-o', 'name']);
    nodes.ok ? ok(`cluster "${stack.kubeContext}" reachable`) : bad(`cluster "${stack.kubeContext}" unreachable`, 'wait for Kubernetes to start in Docker Desktop');
    if (nodes.ok) {
      const gc = run('kubectl', ['--context', stack.kubeContext, 'get', 'gatewayclass', stack.gateway.className]);
      gc.ok ? ok(`GatewayClass "${stack.gateway.className}" installed`) : bad('Envoy Gateway not installed', 'npm run cluster:setup');
    }
  }
}

const tilt = run('tilt', ['version']);
tilt.ok
  ? ok(`tilt ${tilt.stdout.split(',')[0]}`)
  : bad('tilt not found', 'macOS/Linux: curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash   Windows: iex ((new-object net.webclient).DownloadString("https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.ps1"))');

for (const host of Object.values(stack.services).map((s) => s.public).filter(Boolean)) {
  try {
    const { address } = await lookup(host);
    address === '127.0.0.1' || address === '::1' ? ok(`${host} → ${address}`) : warn(`${host} resolves to ${address}`);
  } catch {
    warn(
      `${host} does not resolve for CLI tools (browsers handle *.localhost themselves)`,
      `add "127.0.0.1 ${host}" to /etc/hosts (Windows: C:\\Windows\\System32\\drivers\\etc\\hosts) for curl/scripts`,
    );
  }
}

console.log(failures ? `\n${failures} problem(s) found.` : '\nAll good. Run: npm run dev');
process.exit(failures ? 1 : 0);
