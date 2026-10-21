import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import knex, { type Knex } from 'knex';
import type { Logger } from './logger';

export type { Knex };

export interface DbOptions {
  url: string;
  /** Postgres schema owned by this service (stack.json `db: own`), or 'public' for `db: shared`. */
  schema: string;
  poolMax?: number;
  logger?: Logger;
}

/**
 * Knex instance scoped to the service's schema via search_path, so queries use unqualified
 * table names. Reaching into another service's schema must be explicit: `billing.invoices`
 * (and requires a grant in stack.json).
 */
export function createDb(opts: DbOptions): Knex {
  return knex({
    client: 'pg',
    connection: opts.url,
    searchPath: [opts.schema],
    pool: { min: 0, max: opts.poolMax ?? 10 },
    log: opts.logger
      ? {
          warn: (m: unknown) => opts.logger?.warn({ knex: m }, 'knex warning'),
          error: (m: unknown) => opts.logger?.error({ knex: m }, 'knex error'),
          deprecate: (m: unknown) => opts.logger?.warn({ knex: m }, 'knex deprecation'),
          debug: (m: unknown) => opts.logger?.debug({ knex: m }, 'knex debug'),
        }
      : undefined,
  });
}

export interface DbConnection {
  db: Knex;
  service: string;
  schema: string;
}

export interface DbCliOptions {
  /** Service root directory (contains migrations/ and seeds/). */
  root: string;
  /**
   * Load config and connect. Only called for commands that touch the database, so
   * `make` works on the host without DATABASE_URL.
   */
  connect: () => DbConnection;
}

// TS sources (dev via tsx, tests via vitest) or compiled JS (prod build).
const sourceExt = () => (import.meta.url.endsWith('.ts') ? 'ts' : 'js');
const EXTENSION = /\.(ts|js)$/;

/**
 * Migration files of one extension, recorded by name WITHOUT it: dev runs `x.ts`, the prod build
 * ships `x.js`, and both must see the same applied migration in the same database.
 */
class MigrationFiles implements Knex.MigrationSource<string> {
  constructor(
    private readonly directory: string,
    private readonly ext: string,
  ) {}

  async getMigrations(): Promise<string[]> {
    const files = await readdir(this.directory).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    return files.filter((f) => f.endsWith(`.${this.ext}`)).sort();
  }

  getMigrationName(file: string): string {
    return file.replace(EXTENSION, '');
  }

  getMigration(file: string): Promise<Knex.Migration> {
    return import(pathToFileURL(path.join(this.directory, file)).href) as Promise<Knex.Migration>;
  }
}

/** Where a service's migrations live and where Knex records them. Shared by the CLI and tests. */
export function migrationConfig(opts: {
  root: string;
  service: string;
  schema: string;
  ext?: 'ts' | 'js';
}): Knex.MigratorConfig {
  return {
    migrationSource: new MigrationFiles(path.join(opts.root, 'migrations'), opts.ext ?? sourceExt()),
    // Own schema: keep the bookkeeping table inside it. Shared schema: one table per service.
    ...(opts.schema === 'public'
      ? { tableName: `knex_migrations_${opts.service.replace(/-/g, '_')}` }
      : { schemaName: opts.schema, tableName: 'knex_migrations' }),
  };
}

/**
 * Earlier versions recorded migrations with their extension (`x.ts`). Strip it so the migrator
 * recognises them. Idempotent, and a no-op before the first migration has run.
 */
export async function renameLegacyMigrations(db: Knex, config: Knex.MigratorConfig): Promise<void> {
  const table = config.tableName!;
  const schema = config.schemaName ?? 'public';
  if (!(await db.schema.withSchema(schema).hasTable(table))) return;
  await db
    .withSchema(schema)
    .table(table)
    .whereRaw(`name ~ '\\.(ts|js)$'`)
    .update({ name: db.raw(`regexp_replace(name, '\\.(ts|js)$', '')`) });
}

/**
 * Tiny migration CLI used by every service's `db:*` scripts:
 *   latest | rollback | status | make <name> | seed
 * Works from TS sources (dev, via tsx) and from compiled JS (prod build).
 */
export async function runDbCli(opts: DbCliOptions, argv = process.argv.slice(2)): Promise<void> {
  const [command = 'latest', name] = argv;

  if (command === 'make') {
    if (!name) throw new Error('Usage: db:make <name>');
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const file = path.join(opts.root, 'migrations', `${stamp}_${name.replace(/\W+/g, '_')}.ts`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, MIGRATION_TEMPLATE, { flag: 'wx' });
    console.log(`Created ${path.relative(process.cwd(), file)}`);
    return;
  }

  if (!['latest', 'rollback', 'status', 'seed'].includes(command)) {
    throw new Error(
      `Unknown db command "${command}" (latest | rollback | status | make <name> | seed)`,
    );
  }

  const { db, service, schema } = opts.connect();
  const ext = sourceExt();
  const migrations = migrationConfig({ root: opts.root, service, schema });

  try {
    if (command !== 'seed') await renameLegacyMigrations(db, migrations);
    switch (command) {
      case 'latest': {
        const [batch, files] = (await db.migrate.latest(migrations)) as [number, string[]];
        console.log(files.length ? `Batch ${batch}: ${files.join(', ')}` : 'Already up to date');
        break;
      }
      case 'rollback': {
        const [batch, files] = (await db.migrate.rollback(migrations)) as [number, string[]];
        console.log(
          files.length ? `Rolled back batch ${batch}: ${files.join(', ')}` : 'Nothing to roll back',
        );
        break;
      }
      case 'status': {
        const [done, pending] = (await db.migrate.list(migrations)) as [{ name: string }[], string[]];
        console.log(`Applied (${done.length}):`, done.map((m) => m.name).join(', ') || '-');
        console.log(`Pending (${pending.length}):`, pending.join(', ') || '-');
        break;
      }
      case 'seed': {
        const [files] = (await db.seed.run({
          directory: path.join(opts.root, 'seeds'),
          loadExtensions: [`.${ext}`],
        })) as [string[]];
        console.log(`Ran ${files.length} seed file(s)`);
        break;
      }
    }
  } finally {
    await db.destroy();
  }
}

// Tilt applies a migration as soon as the file is saved, and Knex never re-runs an applied one.
// A runnable placeholder would be applied on creation and your edits silently ignored, so the
// generated file throws (inside Knex's transaction, so nothing is recorded) until it's written.
const MIGRATION_TEMPLATE = `import type { Knex } from 'knex';

// Delete both throws once up() and down() are written. Until then this migration refuses to run,
// because Tilt applies migrations on save and Knex never re-runs one that's already applied.

export async function up(knex: Knex): Promise<void> {
  throw new Error('Migration not written yet');
  // e.g. await knex.schema.alterTable('todos', (t) => { t.text('notes'); });
}

export async function down(knex: Knex): Promise<void> {
  throw new Error('Migration not written yet');
  // e.g. await knex.schema.alterTable('todos', (t) => { t.dropColumn('notes'); });
}
`;
