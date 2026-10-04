#!/usr/bin/env node
// One-time cluster setup: installs Envoy Gateway (Gateway API implementation) into the local
// cluster and registers the GatewayClass that stack.json's Gateway uses. Safe to re-run.
//
// Why Envoy Gateway: ingress-nginx was retired by Kubernetes in March 2026; the Gateway API is
// the successor to Ingress. On Docker Desktop, its LoadBalancer Service is exposed on localhost:80.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, run } from './lib/sh.mjs';
import { loadStack } from './lib/stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stack = loadStack(root);
const ctx = stack.kubeContext;
const VERSION = process.env.ENVOY_GATEWAY_VERSION ?? 'v1.5.0'; // bump as needed: github.com/envoyproxy/gateway/releases
const kubectl = (...args) => run('kubectl', ['--context', ctx, ...args], { stdio: ['pipe', 'inherit', 'inherit'] });

function step(title, fn) {
  console.log(`\n→ ${title}`);
  if (!fn()) {
    console.error(c.bad(`${title} failed`));
    process.exit(1);
  }
}

step(`Check kube context "${ctx}"`, () => {
  const res = run('kubectl', ['--context', ctx, 'get', 'nodes']);
  if (!res.ok) console.error(`Cannot reach "${ctx}". Enable Kubernetes in Docker Desktop (Settings → Kubernetes).\n${res.stderr}`);
  return res.ok;
});

step(`Install Envoy Gateway ${VERSION} (Gateway API CRDs + controller)`, () =>
  kubectl(
    'apply',
    '--server-side',
    '--force-conflicts',
    '-f',
    `https://github.com/envoyproxy/gateway/releases/download/${VERSION}/install.yaml`,
  ).ok,
);

step('Wait for the Envoy Gateway controller', () =>
  kubectl('-n', 'envoy-gateway-system', 'wait', '--for=condition=Available', '--timeout=180s', 'deployment/envoy-gateway').ok,
);

step(`Register GatewayClass "${stack.gateway.className}"`, () => {
  const manifest = JSON.stringify({
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'GatewayClass',
    metadata: { name: stack.gateway.className },
    spec: { controllerName: 'gateway.envoyproxy.io/gatewayclass-controller' },
  });
  return run('kubectl', ['--context', ctx, 'apply', '-f', '-'], { input: manifest, stdio: ['pipe', 'inherit', 'inherit'] }).ok;
});

console.log(`\n${c.ok('Cluster ready.')} Next: npm run dev   (then open http://app.localhost)`);
console.log(c.dim('Port 80 must be free on this machine: the gateway listens on localhost:80.'));
