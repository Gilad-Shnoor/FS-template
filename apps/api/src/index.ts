import { createLogger, loadConfig, runMain, startServer, type Cleanup, type ReadinessCheck } from '@app/server-kit';
import { createDb } from '@app/server-kit/db';
import { createBroker } from '@app/server-kit/rabbitmq';
import { createRedis } from '@app/server-kit/redis';
import { buildApp } from './app';
import { apiEnvSchema } from './config';
import { createAuth } from './modules/auth/auth';
import { createKnexTodoRepo } from './modules/todos/repo';

runMain(async () => {
  const config = loadConfig(apiEnvSchema);
  const logger = createLogger(config);
  const readiness: Record<string, ReadinessCheck> = {};
  const cleanup: Cleanup[] = [];

  const db = createDb({ url: config.DATABASE_URL, schema: config.DB_SCHEMA, poolMax: config.DB_POOL_MAX, logger });
  readiness.db = () => db.raw('select 1');
  cleanup.push(() => db.destroy());

  const authBundle = config.AUTH_ENABLED ? createAuth(config) : null;
  if (authBundle) cleanup.push(() => authBundle.pool.end());
  else logger.warn('AUTH_ENABLED=false: every request is the fixed dev user');

  // Only present when stack.json lists redis in api's `uses` (npm run stack -- use api redis).
  // Pass `redis` into buildApp when a feature needs it (e.g. `cached()` from @app/server-kit/redis).
  const redis = 'REDIS_URL' in config ? createRedis(String(config.REDIS_URL), logger) : undefined;
  if (redis) {
    readiness.redis = () => redis.ping();
    cleanup.push(() => redis.quit());
  }

  // Only present when stack.json lists rabbitmq in api's `uses` (npm run stack -- use api rabbitmq).
  const broker = 'RABBITMQ_URL' in config ? await createBroker(String(config.RABBITMQ_URL), logger) : undefined;
  if (broker) {
    readiness.rabbitmq = () => broker.ping();
    cleanup.unshift(() => broker.close());
  }

  const app = buildApp({
    config,
    logger,
    auth: authBundle?.auth ?? null,
    todos: createKnexTodoRepo(db),
    readiness,
    publish: broker ? (event, payload) => broker.publish(event, payload) : undefined,
  });

  startServer(app, { port: config.PORT, logger, onShutdown: cleanup });
});
