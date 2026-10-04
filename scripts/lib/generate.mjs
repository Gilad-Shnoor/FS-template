// `new-service` generator: copies a template into apps/<name>, writes its contract, updates stack.json.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DB_MODES, StackError, TEMPLATES, loadRawStack, normalizeStack, saveRawStack, toCamel, toConst, toPascal, toPgName } from './stack.mjs';

/** Keep or drop `// @if flag` … `// @endif` blocks. Supports `!flag`. Not nestable (keep templates simple). */
export function preprocess(source, flags) {
  const out = [];
  let keep = true;
  let inBlock = false;
  for (const line of source.split('\n')) {
    const open = line.match(/^\s*\/\/ @if (!?)(\w+)\s*$/);
    if (open) {
      if (inBlock) throw new Error('Nested @if blocks are not supported');
      inBlock = true;
      keep = open[1] === '!' ? !flags[open[2]] : Boolean(flags[open[2]]);
      continue;
    }
    if (/^\s*\/\/ @endif\s*$/.test(line)) {
      inBlock = false;
      keep = true;
      continue;
    }
    if (keep) out.push(line);
  }
  return out.join('\n');
}

export function substitute(source, name) {
  return source
    .replaceAll('__name__', name)
    .replaceAll('__camel__', toCamel(name))
    .replaceAll('__Pascal__', toPascal(name))
    .replaceAll('__CONST__', toConst(name))
    .replaceAll('__snake__', toPgName(name));
}

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((entry) => {
    const abs = path.join(dir, entry);
    return statSync(abs).isDirectory() ? walk(abs, base) : [path.relative(base, abs)];
  });
}

const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

/**
 * Create a new service. Returns a summary of what changed.
 * opts: { template, db, public, consumers, uses, replicas }
 */
export function newService(root, name, opts = {}) {
  const template = opts.template ?? 'http';
  if (!TEMPLATES[template] || template === 'web') throw new StackError(`--template must be http or worker`);
  const db = opts.db ?? (template === 'worker' ? 'none' : 'own');
  if (!DB_MODES.includes(db)) throw new StackError(`--db must be one of ${DB_MODES.join(', ')}`);

  const raw = loadRawStack(root);
  raw.services ??= {};
  if (raw.services[name]) throw new StackError(`Service "${name}" already exists in stack.json`);
  const appDir = path.join(root, 'apps', name);
  if (existsSync(appDir)) throw new StackError(`apps/${name} already exists`);

  const uses = csv(opts.uses);
  if (template === 'worker' && !uses.includes('rabbitmq')) uses.push('rabbitmq');
  const consumers = csv(opts.consumers);

  // 1. stack.json (validate the result before touching the filesystem)
  raw.addons ??= {};
  for (const addon of uses) raw.addons[addon] = { ...raw.addons[addon], enabled: true };
  raw.services[name] = {
    template,
    ...(opts.public ? { public: opts.public } : {}),
    db,
    uses,
    calls: [],
    replicas: Number(opts.replicas ?? 1),
  };
  for (const consumer of consumers) {
    const c = raw.services[consumer];
    if (!c) throw new StackError(`--consumers: unknown service "${consumer}"`);
    c.calls = [...new Set([...(c.calls ?? []), name])];
  }
  normalizeStack(raw); // throws with a readable list if anything is off

  // 2. apps/<name> from the template
  const flags = { db: db !== 'none', redis: uses.includes('redis'), rabbitmq: uses.includes('rabbitmq') };
  const tplDir = path.join(root, 'templates', template);
  const sources = walk(tplDir).map((rel) => [rel, path.join(tplDir, rel)]);
  if (template === 'worker') {
    // Workers reuse the http template's build config and DB CLI.
    for (const rel of ['tsup.config.ts', 'src/db/cli.ts']) sources.push([rel, path.join(root, 'templates/http', rel)]);
  }
  const written = [];
  if (flags.db && template === 'worker') {
    mkdirSync(path.join(appDir, 'migrations'), { recursive: true });
    writeFileSync(path.join(appDir, 'migrations/.gitkeep'), '');
  }
  for (const [rel, src] of sources) {
    let content = substitute(preprocess(readFileSync(src, 'utf8'), flags), name);
    if (!content.trim()) continue; // whole-file conditional (e.g. db/cli.ts without a db)
    if (rel === 'package.json') content = adjustPackageJson(content, flags);
    const dest = path.join(appDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content.replace(/\n{3,}/g, '\n\n'));
    written.push(path.join('apps', name, rel));
  }

  // 3. contract
  const contractDest = path.join(root, 'packages/contracts/src', name, 'index.ts');
  mkdirSync(path.dirname(contractDest), { recursive: true });
  writeFileSync(contractDest, substitute(readFileSync(path.join(root, 'templates/contract', `${template}.ts`), 'utf8'), name));
  written.push(path.relative(root, contractDest));

  saveRawStack(root, raw);
  return { written, consumers, uses, db };
}

function adjustPackageJson(content, flags) {
  const pkg = JSON.parse(content);
  if (!flags.db) {
    for (const k of Object.keys(pkg.scripts)) if (k.startsWith('db:')) delete pkg.scripts[k];
    delete pkg.dependencies.knex;
  }
  return JSON.stringify(pkg, null, 2) + '\n';
}

// ---------------------------------------------------------------- small stack.json edits

export function setAddon(root, addon, enabled) {
  const raw = loadRawStack(root);
  raw.addons ??= {};
  raw.addons[addon] = { ...raw.addons[addon], enabled };
  if (!enabled) {
    const users = Object.entries(raw.services ?? {}).filter(([, s]) => (s.uses ?? []).includes(addon)).map(([n]) => n);
    if (users.length) throw new StackError(`Can't disable "${addon}": used by ${users.join(', ')}. Remove it from their "uses" first.`);
  }
  normalizeStack(raw);
  saveRawStack(root, raw);
}

export function setUses(root, service, addon, on) {
  const raw = loadRawStack(root);
  const s = raw.services?.[service];
  if (!s) throw new StackError(`Unknown service "${service}"`);
  const set = new Set(s.uses ?? []);
  if (on) {
    set.add(addon);
    raw.addons ??= {};
    raw.addons[addon] = { ...raw.addons[addon], enabled: true };
  } else set.delete(addon);
  s.uses = [...set];
  normalizeStack(raw);
  saveRawStack(root, raw);
}

export function setLink(root, from, to, on) {
  const raw = loadRawStack(root);
  const s = raw.services?.[from];
  if (!s) throw new StackError(`Unknown service "${from}"`);
  const set = new Set(s.calls ?? []);
  if (on) set.add(to);
  else set.delete(to);
  s.calls = [...set];
  normalizeStack(raw);
  saveRawStack(root, raw);
}

export function setGrant(root, owner, grantee, level) {
  const raw = loadRawStack(root);
  const s = raw.services?.[owner];
  if (!s) throw new StackError(`Unknown service "${owner}"`);
  const db = typeof s.db === 'string' || !s.db ? { mode: s.db ?? 'none', grants: {} } : { grants: {}, ...s.db };
  if (level === 'none') delete db.grants[grantee];
  else db.grants[grantee] = level;
  s.db = Object.keys(db.grants).length ? db : db.mode;
  normalizeStack(raw);
  saveRawStack(root, raw);
}

export function removeService(root, name) {
  const raw = loadRawStack(root);
  if (!raw.services?.[name]) throw new StackError(`Unknown service "${name}"`);
  delete raw.services[name];
  for (const s of Object.values(raw.services)) {
    if (s.calls) s.calls = s.calls.filter((c) => c !== name);
    if (s.routes) for (const [p, t] of Object.entries(s.routes)) if (t === name) delete s.routes[p];
    if (s.db && typeof s.db === 'object' && s.db.grants) delete s.db.grants[name];
  }
  normalizeStack(raw);
  saveRawStack(root, raw);
}
