import { createLogger, loadConfig, runMain, startServer } from '@app/server-kit';
import { buildApp } from './app';
import { envSchema } from './config';
import { connectStack } from './stack.gen';

runMain(async () => {
  const config = loadConfig(envSchema);
  const logger = createLogger(config);

  // db/redis/broker as declared in stack.json (typed `undefined` when not declared), plus their
  // /readyz checks and shutdown hooks. Pass the ones a feature needs into buildApp.
  const { readiness, cleanup } = await connectStack(config, logger);

  const app = buildApp({ config, logger, readiness });
  startServer(app, { port: config.PORT, logger, onShutdown: cleanup });
});
