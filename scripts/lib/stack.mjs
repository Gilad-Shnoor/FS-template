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
/** Cross-schema grant levels, in their canonical order: SELECT, INSERT, UPDATE, DELETE (see render). */
export const GRANT_LEVELS = ['read', 'write', 'modify', 'delete'];

/** Problems with one grant's level list (empty = valid). */
function grantErrors(levels) {
  if (!Array.isArray(levels)) return [`must be an array of ${GRANT_LEVELS.join(' | ')}`];
  if (!levels.length) return [`must list at least one level (${GRANT_LEVELS.join(' | ')})`];
  const errors = [];
  for (const [i, level] of levels.entries()) {
    if (!GRANT_LEVELS.includes(level)) errors.push(`unknown level "${level}" (known: ${GRANT_LEVELS.join(' | ')})`);
    else if (levels.indexOf(level) !== i) errors.push(`duplicate level "${level}"`);
  }
  if (!levels.includes('read') && levels.some((l) => l === 'modify' || l === 'delete')) {
    errors.push('modify/delete require read (Postgres needs SELECT for WHERE and RETURNING)');
  }
  return errors;
}

/** Levels in canonical order, so stack.json and the rendered SQL don't depend on how they were listed. */
export const sortGrantLevels = (levels) =>
  [...levels].sort((a, b) => GRANT_LEVELS.indexOf(a) - GRANT_LEVELS.indexOf(b));

/** CLI form: "read,modify" → ['read', 'modify'], or 'none' (remove the grant). */
export function parseGrantLevels(arg) {
  if (arg?.trim() === 'none') return 'none';
  const levels = String(arg ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const errors = grantErrors(levels);
  if (errors.length) throw new StackError(`grant levels "${arg}": ${errors.join('; ')}`);
  return sortGrantLevels(levels);
}

const NAME_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const NAME_RULE = 'lowercase kebab-case, 2-32 chars, starting with a letter (e.g. billing, user-profile)';

/** Why `name` can't be a service (or project) name, or null if it can. */
export const nameError = (name) => (NAME_RE.test(name) ? null : `"${name}" must be ${NAME_RULE}`);

/** "(services: web, api)" for "unknown service" messages. */
export const knownList = (label, names) => `(${label}: ${names.length ? names.join(', ') : 'none'})`;

export const toConst = (name) => name.replace(/-/g, '_').toUpperCase();
export const toCamel = (name) => name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
export const toPascal = (name) => toCamel(name).replace(/^./, (c) => c.toUpperCase());
/** Postgres role and schema name for a service. */
export const toPgName = (name) => name.replace(/-/g, '_');

export class StackError extends Error {
  /** @param {string} message @param {string[]} [problems] individual validation problems, if any */
  constructor(message, problems) {
    super(message);
    this.problems = problems;
  }
}

export function stackPath(root) {
  return path.join(root, 'stack.json');
}

export function loadRawStack(root) {
  try {
    return JSON.parse(readFileSync(stackPath(root), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new StackError(`stack.json not found at ${stackPath(root)}`);
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
  if (nameError(project)) errors.push(`project: ${nameError(project)}`);

  const addons = {};
  for (const name of Object.keys(ADDONS)) addons[name] = { enabled: Boolean(raw.addons?.[name]?.enabled) };
  for (const name of Object.keys(raw.addons ?? {})) {
    if (!ADDONS[name]) errors.push(`unknown add-on "${name}" (known: ${Object.keys(ADDONS).join(', ')})`);
  }

  const services = {};
  let debugPort = 9229;
  for (const [name, s] of Object.entries(raw.services ?? {})) {
    const where = `services.${name}`;
    if (nameError(name)) errors.push(`${where}: service name ${nameError(name)}`);
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`${where}: must be an object, e.g. { "template": "http", "db": "own" }`);
      continue;
    }
    const template = s.template ?? 'http';
    const tpl = TEMPLATES[template];
    if (!tpl) {
      errors.push(`${where}.template: "${template}" is not one of ${Object.keys(TEMPLATES).join(', ')}`);
      continue;
    }
    const dbRaw = s.db ?? 'none';
    const db = typeof dbRaw === 'string' ? { mode: dbRaw, grants: {} } : { mode: dbRaw.mode ?? 'own', grants: { ...dbRaw.grants } };
    if (!DB_MODES.includes(db.mode)) errors.push(`${where}.db: mode must be one of ${DB_MODES.join(', ')}`);
    if (template === 'web' && db.mode !== 'none') errors.push(`${where}.db: web services can't have a database`);
    const replicas = s.replicas ?? 1;
    if (!Number.isInteger(replicas) || replicas < 1) errors.push(`${where}.replicas: must be a positive integer, got ${JSON.stringify(replicas)}`);

    services[name] = {
      name,
      template,
      node: tpl.node,
      port: s.port ?? tpl.port,
      replicas,
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
  const knownServices = knownList('services', Object.keys(services));
  for (const s of Object.values(services)) {
    const where = `services.${s.name}`;
    if (s.template === 'worker' && !s.uses.includes('rabbitmq')) {
      errors.push(`${where}.uses: worker services consume events, so they must use "rabbitmq"`);
    }
    // The SPA is static files in the browser: env, add-ons and service clients never reach it.
    if (s.template === 'web' && s.uses.length) errors.push(`${where}.uses: web services can't use add-ons (the browser can't reach them); use them from an http service`);
    if (s.template === 'web' && s.calls.length) errors.push(`${where}.calls: web services can't call services directly; route a path to them instead (e.g. "routes": { "/api": "api" })`);
    for (const addon of s.uses) {
      if (!ADDONS[addon]) errors.push(`${where}.uses: unknown add-on "${addon}" ${knownList('known', Object.keys(ADDONS))}`);
      else if (!addons[addon].enabled) errors.push(`${where}.uses: add-on "${addon}" is disabled — run: npm run addon ${addon}`);
    }
    for (const target of s.calls) {
      const t = services[target];
      if (!t) errors.push(`${where}.calls: unknown service "${target}" ${knownServices}`);
      else if (t.template !== 'http') errors.push(`${where}.calls: "${target}" is a ${t.template} service; only http services can be called`);
      else if (target === s.name) errors.push(`${where}.calls: a service can't call itself`);
    }
    for (const [prefix, target] of Object.entries(s.routes)) {
      if (!prefix.startsWith('/')) errors.push(`${where}.routes: "${prefix}" must start with /`);
      if (!services[target]) errors.push(`${where}.routes: unknown service "${target}" ${knownServices}`);
    }
    if (Object.keys(s.routes).length && !s.public) errors.push(`${where}.routes: only public services can route paths`);
    if (s.public) {
      if (hosts.has(s.public)) errors.push(`${where}.public: host "${s.public}" already used by ${hosts.get(s.public)}`);
      hosts.set(s.public, s.name);
    }
    for (const [grantee, levels] of Object.entries(s.db.grants)) {
      if (s.db.mode !== 'own') {
        errors.push(`${where}.db.grants: grants only apply to db mode "own" (${s.name} has db "${s.db.mode}", so it owns no schema)`);
      }
      const levelErrors = grantErrors(levels);
      for (const e of levelErrors) errors.push(`${where}.db.grants.${grantee}: ${e}`);
      if (!levelErrors.length) s.db.grants[grantee] = sortGrantLevels(levels);
      const g = services[grantee];
      if (!g) errors.push(`${where}.db.grants: unknown service "${grantee}" ${knownServices}`);
      else if (grantee === s.name) errors.push(`${where}.db.grants: ${s.name} owns this schema, so it already has full access; grants are for other services`);
      else if (g.db.mode === 'none') errors.push(`${where}.db.grants: "${grantee}" has db "none", so it has no role to grant to`);
    }
  }

  if (errors.length) throw new StackError(`stack.json is invalid:\n  - ${errors.join('\n  - ')}`, errors);

  return {
    project,
    namespace: raw.namespace ?? project,
    kubeContext: raw.kubeContext ?? 'docker-desktop',
    gateway: { className: raw.gateway?.className ?? 'envoy-gateway' },
    postgres: {
      image: raw.postgres?.image ?? 'postgres:18-alpine',
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
