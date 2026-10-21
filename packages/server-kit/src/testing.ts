// Test-only helpers (testcontainers is a devDependency): the root vitest.global-setup.ts starts
// fresh containers once per `npm test` run and hands tests their URLs (see ./testing-env.ts).
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer } from '@testcontainers/redis';
import { createDb, migrationConfig, renameLegacyMigrations } from './db';
import { IMAGES } from './images.gen';

export interface StartedContainer {
  url: string;
  stop(): Promise<void>;
}

/** Container URLs for this run. Postgres's is the superuser; services connect with their own role. */
export interface ContainerUrls {
  postgres: string;
  redis: string;
  rabbitmq: string;
}

declare module 'vitest' {
  interface ProvidedContext {
    containers: ContainerUrls;
    /** Per service: the env it gets in the cluster, pointed at this run's containers. */
    serviceEnv: Record<string, Record<string, string>>;
  }
}

export async function startPostgres(database = 'app'): Promise<StartedContainer> {
  const c = await new PostgreSqlContainer(IMAGES.postgres)
    .withDatabase(database)
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  return { url: c.getConnectionUri(), stop: async () => void (await c.stop()) };
}

export async function startRedis(): Promise<StartedContainer> {
  const c = await new RedisContainer(IMAGES.redis).start();
  return { url: c.getConnectionUrl(), stop: async () => void (await c.stop()) };
}

export async function startRabbitMQ(): Promise<StartedContainer> {
  const c = await new RabbitMQContainer(IMAGES.rabbitmq).start();
  return { url: c.getAmqpUrl(), stop: async () => void (await c.stop()) };
}

/** Run a service's migrations, exactly as its `migrate` init container does in the cluster. */
export async function migrate(opts: { url: string; root: string; service: string; schema: string }): Promise<void> {
  const db = createDb({ url: opts.url, schema: opts.schema });
  try {
    const config = migrationConfig(opts);
    await renameLegacyMigrations(db, config);
    await db.migrate.latest(config);
  } finally {
    await db.destroy();
  }
}
