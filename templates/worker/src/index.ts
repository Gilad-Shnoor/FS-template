import { createApp, createLogger, loadConfig, runMain, startServer, type Cleanup, type ReadinessCheck } from '@app/server-kit';
// @if db
import { createDb } from '@app/server-kit/db';
// @endif
// @if redis
import { createRedis } from '@app/server-kit/redis';
// @endif
import { createBroker } from '@app/server-kit/rabbitmq';
import { envSchema } from './config';
import { registerHandlers } from './handlers';

// A worker consumes queue messages. It still runs a tiny HTTP server for /healthz and /readyz
// so Kubernetes can probe it like any other service.
runMain(async () => {
  const config = loadConfig(envSchema);
  const logger = createLogger(config);
  const readiness: Record<string, ReadinessCheck> = {};
  const cleanup: Cleanup[] = [];

// @if db
  const db = createDb({ url: config.DATABASE_URL, schema: config.DB_SCHEMA, poolMax: config.DB_POOL_MAX, logger });
  readiness.db = () => db.raw('select 1');
  cleanup.push(() => db.destroy());

// @endif
// @if redis
  const redis = createRedis(config.REDIS_URL, logger);
  readiness.redis = () => redis.ping();
  cleanup.push(() => redis.quit());

// @endif
  const broker = await createBroker(config.RABBITMQ_URL, logger);
  readiness.rabbitmq = () => broker.ping();
  cleanup.unshift(() => broker.close());

  await registerHandlers({ broker, logger });

  const app = createApp({ config, logger, readiness, routes: () => undefined });
  startServer(app, { port: config.PORT, logger, onShutdown: cleanup });
});
