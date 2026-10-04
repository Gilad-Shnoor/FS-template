import { createApp, type BaseConfig, type Logger, type ReadinessCheck } from '@app/server-kit';
import { Router } from 'express';
import { registerRoutes } from './routes';

export interface AppDeps {
  config: BaseConfig;
  logger: Logger;
  readiness?: Record<string, ReadinessCheck>;
}

export function buildApp(deps: AppDeps) {
  return createApp({
    config: deps.config,
    logger: deps.logger,
    readiness: deps.readiness,
    routes: (app) => {
      const router = Router();
      registerRoutes(router);
      app.use(router);
    },
  });
}
