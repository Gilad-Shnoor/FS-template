import { createApp, type BaseConfig, type Logger, type ReadinessCheck } from '@app/server-kit';
import { Router } from 'express';
import type { Auth } from './modules/auth/auth';
import { createAuthModule } from './modules/auth';
import type { TodoRepo } from './modules/todos/repo';
import { registerTodoRoutes, type TodoRoutesDeps } from './modules/todos/routes';

export interface AppDeps {
  config: BaseConfig;
  logger: Logger;
  auth: Auth | null;
  todos: TodoRepo;
  readiness?: Record<string, ReadinessCheck>;
  /** Present when stack.json gives api the rabbitmq add-on. */
  publish?: TodoRoutesDeps['publish'];
}

/** Pure composition: takes dependencies, returns an Express app. index.ts wires real ones; tests wire fakes. */
export function buildApp(deps: AppDeps) {
  const authModule = createAuthModule(deps.auth);

  return createApp({
    config: deps.config,
    logger: deps.logger,
    readiness: deps.readiness,
    beforeBodyParsers: (app) => authModule.mountHandler(app),
    routes: (app) => {
      const router = Router();
      router.use(authModule.resolveUser);
      authModule.registerRoutes(router);
      registerTodoRoutes(router, { repo: deps.todos, requireAuth: authModule.requireAuth, publish: deps.publish });
      // Register new feature modules here.
      app.use(router);
    },
  });
}
