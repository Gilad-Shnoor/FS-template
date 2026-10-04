// stack.json model: load, normalize, validate, save.
// stack.json is the single source of truth for services, add-ons and how they connect.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const TEMPLATES = {
  http: { port: 3000, node: true },
  worker: { port: 3000, node: true },
  web: { port: 5173, node: false },
};

export const ADDONS = {
  redis: { env: { REDIS_URL: 'redis://redis:6379' } },
  rabbitmq: { env: { RABBITMQ_URL: 'amqp://app:app-dev-password@rabbitmq:5672' } },
};

export const DB_MODES = ['own', 'shared', 'none'];
export const GRANT_LEVELS = ['read', 'readwrite'];

const NAME_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

export const toConst = (name) => name.replace(/-/g, '_').toUpperCase();
export const toCamel = (name) => name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
export const toPascal = (name) => toCamel(name).replace(/^./, (c) => c.toUpperCase());
/** Postgres role and schema name for a service. */
export const toPgName = (name) => name.replace(/-/g, '_');

export class StackError extends Error {}

export function stackPath(root) {
  return path.join(root, 'stack.json');
}

export function loadRawStack(root) {
  try {
    return JSON.parse(readFileSync(stackPath(root), 'utf8'));
  } catch (err) {
    throw new StackError(`Cannot read stack.json: ${err.message}`);
  }
}

export function saveRawStack(root, raw) {
  writeFileSync(stackPath(root), JSON.stringify(raw, null, 2) + '\n');
}

/** Expand shorthands and fill defaults. Returns a fully-specified stack; throws StackError on problems. */
export function normalizeStack(raw) {
  const errors = [];
  const project = raw.project ?? 'fs-template';
  if (!NAME_RE.test(project)) errors.push(`project "${project}" must be lowercase kebab-case`);

  const addons = {};
  for (const name of Object.keys(ADDONS)) addons[name] = { enabled: Boolean(raw.addons?.[name]?.enabled) };
  for (const name of Object.keys(raw.addons ?? {})) {
    if (!ADDONS[name]) errors.push(`unknown add-on "${name}" (known: ${Object.keys(ADDONS).join(', ')})`);
  }

  const services = {};
  let debugPort = 9229;
  for (const [name, s] of Object.entries(raw.services ?? {})) {
    const where = `services.${name}`;
    if (!NAME_RE.test(name)) errors.push(`${where}: name must be lowercase kebab-case (2-32 chars)`);
    const template = s.template ?? 'http';
    const tpl = TEMPLATES[template];
    if (!tpl) {
      errors.push(`${where}.template: "${template}" is not one of ${Object.keys(TEMPLATES).join(', ')}`);
      continue;
    }
    const dbRaw = s.db ?? 'none';
    const db = typeof dbRaw === 'string' ? { mode: dbRaw, grants: {} } : { mode: dbRaw.mode ?? 'own', grants: dbRaw.grants ?? {} };
    if (!DB_MODES.includes(db.mode)) errors.push(`${where}.db: mode must be one of ${DB_MODES.join(', ')}`);
    if (template === 'web' && db.mode !== 'none') errors.push(`${where}.db: web services can't have a database`);

    services[name] = {
      name,
      template,
      node: tpl.node,
      port: s.port ?? tpl.port,
      replicas: s.replicas ?? 1,
      public: s.public ?? null,
      routes: s.routes ?? {},
      db,
      uses: s.uses ?? [],
      calls: s.calls ?? [],
      env: s.env ?? {},
      debugPort: tpl.node ? debugPort++ : null,
      image: `${project}-${name}`,
    };
  }

  // Cross-references
  const hosts = new Map();
  for (const s of Object.values(services)) {
    const where = `services.${s.name}`;
    if (s.template === 'worker' && !s.uses.includes('rabbitmq')) {
      errors.push(`${where}.uses: worker services consume events, so they must use "rabbitmq"`);
    }
    for (const addon of s.uses) {
      if (!ADDONS[addon]) errors.push(`${where}.uses: unknown add-on "${addon}"`);
      else if (!addons[addon].enabled) errors.push(`${where}.uses: add-on "${addon}" is disabled — run: npm run addon ${addon}`);
    }
    for (const target of s.calls) {
      const t = services[target];
      if (!t) errors.push(`${where}.calls: unknown service "${target}"`);
      else if (t.template !== 'http') errors.push(`${where}.calls: "${target}" is a ${t.template} service; only http services can be called`);
      else if (target === s.name) errors.push(`${where}.calls: a service can't call itself`);
    }
    for (const [prefix, target] of Object.entries(s.routes)) {
      if (!prefix.startsWith('/')) errors.push(`${where}.routes: "${prefix}" must start with /`);
      if (!services[target]) errors.push(`${where}.routes: unknown service "${target}"`);
    }
    if (Object.keys(s.routes).length && !s.public) errors.push(`${where}.routes: only public services can route paths`);
    if (s.public) {
      if (hosts.has(s.public)) errors.push(`${where}.public: host "${s.public}" already used by ${hosts.get(s.public)}`);
      hosts.set(s.public, s.name);
    }
    for (const [grantee, level] of Object.entries(s.db.grants)) {
      if (s.db.mode !== 'own') errors.push(`${where}.db.grants: grants only apply to db mode "own"`);
      if (!GRANT_LEVELS.includes(level)) errors.push(`${where}.db.grants.${grantee}: must be ${GRANT_LEVELS.join(' | ')}`);
      const g = services[grantee];
      if (!g) errors.push(`${where}.db.grants: unknown service "${grantee}"`);
      else if (g.db.mode === 'none') errors.push(`${where}.db.grants: "${grantee}" has db "none", so it has no role to grant to`);
    }
  }

  if (errors.length) throw new StackError(`stack.json is invalid:\n  - ${errors.join('\n  - ')}`);

  return {
    project,
    namespace: raw.namespace ?? project,
    kubeContext: raw.kubeContext ?? 'docker-desktop',
    gateway: { className: raw.gateway?.className ?? 'envoy-gateway' },
    postgres: {
      image: raw.postgres?.image ?? 'postgres:17-alpine',
      database: raw.postgres?.database ?? 'app',
      localPort: raw.postgres?.localPort ?? 15432,
      storage: raw.postgres?.storage ?? '1Gi',
    },
    addons,
    services,
  };
}

export function loadStack(root) {
  return normalizeStack(loadRawStack(root));
}

/** Env vars a node service receives because of what stack.json says it uses/calls. */
export function wiredEnv(stack, svc) {
  const env = {};
  for (const addon of svc.uses) Object.assign(env, ADDONS[addon].env);
  for (const target of svc.calls) env[`${toConst(target)}_URL`] = `http://${target}:${stack.services[target].port}`;
  return env;
}
