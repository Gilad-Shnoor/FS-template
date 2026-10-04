import { createLogger, loadConfig, runMain, startServer } from '@app/server-kit';
import { buildApp } from './app';
import { apiEnvSchema } from './config';
import { createAuth } from './modules/auth/auth';
import { createKnexTodoRepo } from './modules/todos/repo';
import { connectStack } from './stack.gen';

runMain(async () => {
  const config = loadConfig(apiEnvSchema);
  const logger = createLogger(config);

  // db/redis/broker as declared in stack.json, plus their /readyz checks and shutdown hooks.
  // `redis` and `broker` are typed `undefined` until stack.json gives api the add-on
  // (npm run stack -- use api redis|rabbitmq). buildApp takes `broker` for todo events;
  // pass `redis` the same way when a feature needs it.
  const { db, broker, readiness, cleanup } = await connectStack(config, logger);

  const authBundle = config.AUTH_ENABLED ? createAuth(config) : null;
  if (authBundle) cleanup.push(() => authBundle.pool.end());
  else logger.warn('AUTH_ENABLED=false: every request is the fixed dev user');

  const app = buildApp({
    config,
    logger,
    auth: authBundle?.auth ?? null,
    todos: createKnexTodoRepo(db),
    readiness,
    broker,
  });

  startServer(app, { port: config.PORT, logger, onShutdown: cleanup });
});
