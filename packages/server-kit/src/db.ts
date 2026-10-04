import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

export interface DbCliOptions {
  db: Knex;
  service: string;
  schema: string;
  /** Service root directory (contains migrations/ and seeds/). */
  root: string;
}

/**
 * Tiny migration CLI used by every service's `db:*` scripts:
 *   latest | rollback | status | make <name> | seed
 * Works from TS sources (dev, via tsx) and from compiled JS (prod build).
 */
export async function runDbCli(opts: DbCliOptions, argv = process.argv.slice(2)): Promise<void> {
  const [command = 'latest', name] = argv;
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const migrations: Knex.MigratorConfig = {
    directory: path.join(opts.root, 'migrations'),
    loadExtensions: [`.${ext}`],
    extension: ext,
    // Own schema: keep the bookkeeping table inside it. Shared schema: one table per service.
    ...(opts.schema === 'public'
      ? { tableName: `knex_migrations_${opts.service.replace(/-/g, '_')}` }
      : { schemaName: opts.schema, tableName: 'knex_migrations' }),
  };

  try {
    switch (command) {
      case 'latest': {
        const [batch, files] = (await opts.db.migrate.latest(migrations)) as [number, string[]];
        console.log(files.length ? `Batch ${batch}: ${files.join(', ')}` : 'Already up to date');
        break;
      }
      case 'rollback': {
        const [batch, files] = (await opts.db.migrate.rollback(migrations)) as [number, string[]];
        console.log(files.length ? `Rolled back batch ${batch}: ${files.join(', ')}` : 'Nothing to roll back');
        break;
      }
      case 'status': {
        const [done, pending] = (await opts.db.migrate.list(migrations)) as [
          { name: string }[],
          { file: string }[],
        ];
        console.log(`Applied (${done.length}):`, done.map((m) => m.name).join(', ') || '-');
        console.log(`Pending (${pending.length}):`, pending.map((m) => m.file).join(', ') || '-');
        break;
      }
      case 'make': {
        if (!name) throw new Error('Usage: db:make <name>');
        const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
        const file = path.join(opts.root, 'migrations', `${stamp}_${name.replace(/\W+/g, '_')}.ts`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, MIGRATION_TEMPLATE, { flag: 'wx' });
        console.log(`Created ${path.relative(process.cwd(), file)}`);
        break;
      }
      case 'seed': {
        const [files] = (await opts.db.seed.run({
          directory: path.join(opts.root, 'seeds'),
          loadExtensions: [`.${ext}`],
        })) as [string[]];
        console.log(`Ran ${files.length} seed file(s)`);
        break;
      }
      default:
        throw new Error(`Unknown db command "${command}" (latest | rollback | status | make <name> | seed)`);
    }
  } finally {
    await opts.db.destroy();
  }
}

const MIGRATION_TEMPLATE = `import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('example', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('example');
}
`;
