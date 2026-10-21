#!/usr/bin/env node
// `npm run down` / `npm run reset`: tilt down (extra args are passed through, e.g.
// --delete-namespaces), then stop the Envoy Gateway controller if nothing else uses it.
//
// The controller is cluster-wide and shared by every project's namespace, so it's stopped only
// when no Gateway of its class is left in another namespace. The Tiltfile scales it back up on
// the next `npm run dev`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, run } from './lib/sh.mjs';
import { loadStack } from './lib/stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stack = loadStack(root);
const kubectl = (...args) => run('kubectl', ['--context', stack.kubeContext, ...args]);

const down = run('tilt', ['down', ...process.argv.slice(2)], { stdio: 'inherit' });
if (!down.ok) process.exit(down.status ?? 1);

const gateways = kubectl('get', 'gateways', '-A', '-o', 'json');
if (!gateways.ok) {
  // No Gateway API on this cluster (or it's unreachable): nothing to stop.
  console.log(c.dim(`Left the Envoy Gateway controller as is: ${gateways.stderr.split('\n')[0]}`));
  process.exit(0);
}
const others = JSON.parse(gateways.stdout)
  .items.filter((g) => g.spec.gatewayClassName === stack.gateway.className)
  .filter((g) => g.metadata.namespace !== stack.namespace)
  .map((g) => `${g.metadata.namespace}/${g.metadata.name}`);

if (others.length) {
  console.log(c.dim(`Envoy Gateway controller left running: still used by ${others.join(', ')}`));
  process.exit(0);
}

const scale = kubectl('-n', 'envoy-gateway-system', 'scale', 'deployment', 'envoy-gateway', '--replicas=0');
if (scale.ok) console.log(c.ok('Envoy Gateway controller stopped (no other project uses it; npm run dev restarts it)'));
else console.log(c.warn(`Could not stop the Envoy Gateway controller: ${scale.stderr.split('\n')[0]}`));
