import { createApp, createLogger, loadConfig, runMain, startServer } from '@app/server-kit';
import { envSchema } from './config';
import { registerHandlers } from './handlers';
import { connectStack } from './stack.gen';

// A worker consumes queue messages. It still runs a tiny HTTP server for /healthz and /readyz
// so Kubernetes can probe it like any other service.
runMain(async () => {
  const config = loadConfig(envSchema);
  const logger = createLogger(config);

  // broker (plus db/redis if declared in stack.json), their /readyz checks and shutdown hooks.
  const { broker, readiness, cleanup } = await connectStack(config, logger);

  await registerHandlers({ broker, logger });

  const app = createApp({ config, logger, readiness, routes: () => undefined });
  startServer(app, { port: config.PORT, logger, onShutdown: cleanup });
});
