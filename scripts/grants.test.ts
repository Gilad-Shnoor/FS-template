// Grants do what they say in a real Postgres, not just in the generated SQL: apply provisionSql()
// to a fresh container, connect as each grantee and try every operation. Its own container (not the
// run's shared one) because it needs a cluster where only these test roles exist.
import { createDb, type Knex } from '@app/server-kit/db';
import { startPostgres, type StartedContainer } from '@app/server-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_PASSWORD, provisionSql } from './lib/render.mjs';
import { normalizeStack } from './lib/stack.mjs';

type Level = 'read' | 'write' | 'modify' | 'delete';
type Op = 'select' | 'insert' | 'update' | 'delete';
const OPS: Op[] = ['select', 'insert', 'update', 'delete'];
const ALLOWS: Record<Level, Op> = { read: 'select', write: 'insert', modify: 'update', delete: 'delete' };

/** Grantee service → its grant on api's schema. */
const GRANTS: Record<string, Level[]> = {
  reader: ['read'],
  inserter: ['write'],
  appender: ['read', 'write'],
  editor: ['read', 'modify'],
  remover: ['read', 'delete'],
  admin: ['read', 'write', 'modify', 'delete'],
};

const stackWith = (grants: Record<string, Level[]>) =>
  normalizeStack({
    project: 'grants-test',
    services: {
      api: { template: 'http', db: Object.keys(grants).length ? { mode: 'own', grants } : 'own' },
      ...Object.fromEntries(Object.keys(GRANTS).map((name) => [name, { template: 'http', db: 'own' }])),
    },
  });

let pg: StartedContainer;
const pools = new Map<string, Knex>();
/** One pool per role, logged in with the password provisionSql() gives it. */
function connect(role: string): Knex {
  let db = pools.get(role);
  if (!db) {
    const url = new URL(pg.url);
    url.username = role;
    url.password = DEV_PASSWORD(role);
    db = createDb({ url: url.toString(), schema: role, poolMax: 2 });
    pools.set(role, db);
  }
  return db;
}

async function provision(grants: Record<string, Level[]>) {
  const admin = createDb({ url: pg.url, schema: 'public' });
  try {
    await admin.raw(provisionSql(stackWith(grants)).replace(/^\\set .*$/m, ''));
  } finally {
    await admin.destroy();
  }
}

/** Run `op` on api.<table> as `role`: 'ok', or the Postgres error code. */
async function attempt(role: string, op: Op, table: string): Promise<string> {
  const db = connect(role);
  // Every operation targets a row the owner created, so WHERE clauses have something to match.
  const [{ id }] = await connect('api')(`api.${table}`).insert({ name: 'seed' }).returning('id');
  const t = () => db(`api.${table}`);
  try {
    if (op === 'select') await t().select('*');
    if (op === 'insert') await t().insert({ name: role }); // no RETURNING: INSERT alone must suffice
    if (op === 'update') await t().where({ id }).update({ name: 'changed' });
    if (op === 'delete') await t().where({ id }).delete();
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

const expected = (levels: Level[], op: Op) => (levels.some((l) => ALLOWS[l] === op) ? 'ok' : '42501');

beforeAll(async () => {
  pg = await startPostgres();
  // A table that exists before the grants (GRANT ... ON ALL TABLES) and one created after them
  // (ALTER DEFAULT PRIVILEGES), both with a serial column so inserts need sequence usage.
  await provision({});
  await connect('api').raw('create table api.before_grants (id serial primary key, name text)');
  await provision(GRANTS);
  await connect('api').raw('create table api.after_grants (id serial primary key, name text)');
}, 120_000);

afterAll(async () => {
  await Promise.all([...pools.values()].map((db) => db.destroy()));
  await pg?.stop();
});

describe('grants in a real Postgres', () => {
  for (const table of ['before_grants', 'after_grants']) {
    for (const [role, levels] of Object.entries(GRANTS)) {
      it(`${role} (${levels.join('+')}) on a table created ${table.replace('_', ' ')}`, async () => {
        const results = Object.fromEntries(await Promise.all(OPS.map(async (op) => [op, await attempt(role, op, table)])));
        expect(results).toEqual(Object.fromEntries(OPS.map((op) => [op, expected(levels, op)])));
      });
    }
  }

  it('re-provisioning with changed grants revokes what was removed', async () => {
    await provision({ ...GRANTS, admin: ['read'], appender: ['write'] });
    try {
      for (const table of ['before_grants', 'after_grants']) {
        expect(await attempt('admin', 'insert', table)).toBe('42501');
        expect(await attempt('admin', 'delete', table)).toBe('42501');
        expect(await attempt('admin', 'select', table)).toBe('ok');
        expect(await attempt('appender', 'select', table)).toBe('42501');
        expect(await attempt('appender', 'insert', table)).toBe('ok');
      }

      const { reader: _removed, ...rest } = GRANTS;
      await provision(rest);
      expect(await attempt('reader', 'select', 'before_grants')).toBe('42501');
      expect(await attempt('reader', 'select', 'after_grants')).toBe('42501');
    } finally {
      await provision(GRANTS);
    }
  });
});
