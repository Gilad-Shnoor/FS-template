import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrationConfig, renameLegacyMigrations } from './db';
import { containerUrls } from './testing-env';

const MIGRATION = `
export async function up(knex) { await knex.schema.createTable('things', (t) => { t.increments('id'); }); }
export async function down(knex) { await knex.schema.dropTable('things'); }
`;

// The same migration as dev runs it (.ts via tsx) and as the prod build ships it (.js).
let tsRoot: string;
let jsRoot: string;
const schema = `mig_${randomUUID().slice(0, 8)}`;
const db = createDb({ url: containerUrls().postgres, schema });
const opts = (root: string, ext: 'ts' | 'js') => migrationConfig({ root, service: 'svc', schema, ext });

async function serviceRoot(ext: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'migrations-'));
  await mkdir(path.join(root, 'migrations'));
  await writeFile(path.join(root, 'migrations', `20260101000000_things.${ext}`), MIGRATION);
  // The prod build ships source maps next to each migration; they must not count as migrations.
  await writeFile(path.join(root, 'migrations', `20260101000000_things.${ext}.map`), '{}');
  return root;
}

beforeAll(async () => {
  [tsRoot, jsRoot] = await Promise.all([serviceRoot('ts'), serviceRoot('js')]);
  await db.raw('create schema ??', [schema]);
});
afterAll(async () => {
  await db.raw('drop schema ?? cascade', [schema]);
  await db.destroy();
  await Promise.all([tsRoot, jsRoot].map((r) => rm(r, { recursive: true, force: true })));
});

describe('migrations', () => {
  it('are recorded without their extension, so dev (.ts) and prod (.js) share one database', async () => {
    const [, applied] = (await db.migrate.latest(opts(tsRoot, 'ts'))) as [number, string[]];
    expect(applied).toEqual(['20260101000000_things']);

    const [done, pending] = (await db.migrate.list(opts(jsRoot, 'js'))) as [{ name: string }[], unknown[]];
    expect(done.map((m) => m.name)).toEqual(['20260101000000_things']);
    expect(pending).toEqual([]);
  });

  it('renames rows recorded with an extension by earlier versions', async () => {
    await db.withSchema(schema).table('knex_migrations').update({ name: '20260101000000_things.ts' });

    await renameLegacyMigrations(db, opts(jsRoot, 'js'));

    const [, pending] = (await db.migrate.list(opts(jsRoot, 'js'))) as [unknown[], unknown[]];
    expect(pending).toEqual([]);
    expect(await db.withSchema(schema).table('knex_migrations').pluck('name')).toEqual(['20260101000000_things']);
  });

  it('renaming is a no-op before the first migration', async () => {
    const fresh = migrationConfig({ root: jsRoot, service: 'svc', schema: `none_${randomUUID().slice(0, 8)}`, ext: 'js' });
    await expect(renameLegacyMigrations(db, fresh)).resolves.toBeUndefined();
  });
});
