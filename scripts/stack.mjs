#!/usr/bin/env node
// Stack CLI. Every command edits stack.json (the source of truth) and re-renders generated files.
// Zero npm dependencies on purpose: it works before `npm install`.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { newService, removeService, setAddon, setGrant, setLink, setUses } from './lib/generate.mjs';
import { renderAll, writeRendered } from './lib/render.mjs';
import { ADDONS, GRANT_LEVELS, StackError, loadStack } from './lib/stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `
Usage: npm run stack -- <command> [args]        (or the npm shortcuts in parentheses)

  render [--check]                  Regenerate k8s manifests + apps/*/src/stack.gen.ts   (stack:render)
  list                              Show services, add-ons and how they connect           (stack:list)

  new-service <name> [options]      Scaffold apps/<name> + its contract, add to stack.json (new:service)
      --template http|worker        default http (worker = queue consumer, enables rabbitmq)
      --db own|shared|none          default own for http, none for worker
      --public <host>               expose via the gateway, e.g. billing.localhost
      --consumers a,b               services that will call this one (adds to their "calls")
      --uses redis,rabbitmq         add-ons this service uses (enabled automatically)
  remove-service <name>             Remove from stack.json (files are left for you to delete)

  addon <redis|rabbitmq> [--disable]          Enable/disable a namespace-wide add-on    (addon)
  use <service> <addon> [--remove]            Let a service use an add-on (injects its env)
  link <from> <to> [--remove]                 <from> calls <to> over HTTP (typed client) (link)
  grant <owner> <grantee> <read|readwrite|none>  DB access to <owner>'s schema          (db:grant)

  migrate [service]   Run pending migrations in the running pod(s)                      (db:migrate)
  seed [service]      Run seeds in the running pod(s)                                   (db:seed)
  db-shell            psql into the cluster database as superuser                       (db:shell)
`;

function render({ check = false } = {}) {
  const stack = loadStack(root);
  const changed = writeRendered(root, renderAll(stack, root), { check });
  if (check) {
    if (changed.length) {
      console.error(`Generated files are out of date. Run \`npm run stack:render\`.\n  ${changed.join('\n  ')}`);
      process.exit(1);
    }
    console.log('Generated files are up to date.');
  } else {
    console.log(changed.length ? `Rendered:\n  ${changed.join('\n  ')}` : 'Nothing changed.');
  }
  return stack;
}

function kubectl(stack, args, opts = {}) {
  const res = spawnSync('kubectl', ['--context', stack.kubeContext, '-n', stack.namespace, ...args], {
    stdio: 'inherit',
    ...opts,
  });
  if (res.error) throw new StackError(`kubectl failed: ${res.error.message}. Is kubectl installed?`);
  return res.status ?? 1;
}

function dbServices(stack, only) {
  const list = Object.values(stack.services).filter((s) => s.db.mode !== 'none');
  if (!only) return list;
  const svc = list.find((s) => s.name === only);
  if (!svc) throw new StackError(`"${only}" is not a service with a database`);
  return [svc];
}

function list() {
  const stack = loadStack(root);
  console.log(`project: ${stack.project}   namespace: ${stack.namespace}   context: ${stack.kubeContext}\n`);
  console.log('add-ons:', Object.entries(stack.addons).map(([n, a]) => `${n}${a.enabled ? '' : ' (off)'}`).join(', '));
  console.log('');
  for (const s of Object.values(stack.services)) {
    const parts = [
      s.template,
      s.public ? `http://${s.public}` : 'internal',
      `db:${s.db.mode}`,
      s.uses.length && `uses:${s.uses.join(',')}`,
      s.calls.length && `calls:${s.calls.join(',')}`,
      Object.keys(s.db.grants).length && `grants:${Object.entries(s.db.grants).map(([g, l]) => `${g}=${l}`).join(',')}`,
      Object.keys(s.routes).length && `routes:${Object.entries(s.routes).map(([p, t]) => `${p}→${t}`).join(',')}`,
      s.replicas !== 1 && `replicas:${s.replicas}`,
      s.debugPort && `debug:localhost:${s.debugPort}`,
    ].filter(Boolean);
    console.log(`  ${s.name.padEnd(14)} ${parts.join('  ')}`);
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      check: { type: 'boolean' },
      disable: { type: 'boolean' },
      remove: { type: 'boolean' },
      template: { type: 'string' },
      db: { type: 'string' },
      public: { type: 'string' },
      consumers: { type: 'string' },
      uses: { type: 'string' },
      replicas: { type: 'string' },
    },
  });

  switch (command) {
    case 'render':
      render({ check: values.check });
      return;
    case 'list':
      list();
      return;
    case 'new-service': {
      const [name] = positionals;
      if (!name) throw new StackError('Usage: new-service <name> [--template http|worker] [--db own|shared|none] ...');
      const result = newService(root, name, values);
      render();
      console.log(`\nCreated service "${name}":\n  ${result.written.join('\n  ')}`);
      console.log(`
Next steps:
  1. npm install                       # links the new workspace package
  2. Tilt picks it up automatically (it watches stack.json). If Tilt isn't running: npm run dev
  3. Define its API in packages/contracts/src/${name}/index.ts, implement it in apps/${name}/src/routes.ts${
    result.consumers.length
      ? `\n  4. Call it from ${result.consumers.join(', ')}: import { serviceClients } from './stack.gen'; await serviceClients().${name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())}.ping()`
      : ''
  }`);
      return;
    }
    case 'remove-service': {
      const [name] = positionals;
      const hadDb = loadStack(root).services[name]?.db.mode !== 'none';
      removeService(root, name);
      render();
      console.log(`Removed "${name}" from stack.json; Tilt removes its workloads.`);
      console.log(`Next: delete apps/${name} and packages/contracts/src/${name}, then npm install.`);
      if (hadDb) {
        const role = name.replace(/-/g, '_');
        console.log(
          `Its database role and data are kept (provisioning never drops anything). To delete them:\n` +
            `  npm run db:shell   then   DROP OWNED BY ${role} CASCADE; DROP ROLE ${role};`,
        );
      }
      return;
    }
    case 'addon': {
      const [addon] = positionals;
      if (!ADDONS[addon]) throw new StackError(`Usage: addon <${Object.keys(ADDONS).join('|')}> [--disable]`);
      setAddon(root, addon, !values.disable);
      render();
      if (!values.disable) console.log(`\n${addon} enabled. Let a service use it with: npm run stack -- use <service> ${addon}`);
      return;
    }
    case 'use': {
      const [service, addon] = positionals;
      if (!service || !ADDONS[addon]) throw new StackError(`Usage: use <service> <${Object.keys(ADDONS).join('|')}> [--remove]`);
      setUses(root, service, addon, !values.remove);
      render();
      if (!values.remove) console.log(`\n${service} now gets ${Object.keys(ADDONS[addon].env).join(', ')} (see apps/${service}/src/stack.gen.ts). Helper: @app/server-kit/${addon}`);
      return;
    }
    case 'link': {
      const [from, to] = positionals;
      if (!from || !to) throw new StackError('Usage: link <from> <to> [--remove]');
      setLink(root, from, to, !values.remove);
      render();
      return;
    }
    case 'grant': {
      const [owner, grantee, level] = positionals;
      if (!owner || !grantee || ![...GRANT_LEVELS, 'none'].includes(level)) {
        throw new StackError('Usage: grant <owner> <grantee> <read|readwrite|none>');
      }
      setGrant(root, owner, grantee, level);
      render();
      const schema = `"${owner.replace(/-/g, '_')}"`;
      console.log(
        `\nTilt re-runs db-provision automatically. ` +
          (level === 'none' ? `${grantee} can no longer query ${schema}.` : `${grantee} can now ${level === 'read' ? 'read' : 'read and write'} ${schema}.<table>.`),
      );
      return;
    }
    case 'migrate':
    case 'seed': {
      const stack = loadStack(root);
      let failed = 0;
      for (const svc of dbServices(stack, positionals[0])) {
        console.log(`→ ${svc.name}: db:${command === 'migrate' ? 'migrate' : 'seed'}`);
        failed |= kubectl(stack, ['exec', `deploy/${svc.name}`, '-c', svc.name, '--', 'npm', 'run', `db:${command}`, '-w', `apps/${svc.name}`]);
      }
      process.exit(failed ? 1 : 0);
      return;
    }
    case 'db-shell': {
      const stack = loadStack(root);
      process.exit(kubectl(stack, ['exec', '-it', 'statefulset/postgres', '-c', 'postgres', '--', 'psql', '-U', 'postgres', stack.postgres.database]));
      return;
    }
    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      return;
    default:
      throw new StackError(`Unknown command "${command}".\n${HELP}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof StackError || err?.code?.startsWith?.('ERR_PARSE_ARGS')) {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  }
  throw err;
}
