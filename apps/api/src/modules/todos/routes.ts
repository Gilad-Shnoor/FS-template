import { apiEvents, apiRoutes } from '@app/contracts/api';
import { implement, notFound, unauthorized } from '@app/server-kit';
import type { Request, RequestHandler, Router } from 'express';
import type { TodoRepo } from './repo';

export interface TodoRoutesDeps {
  repo: TodoRepo;
  requireAuth: RequestHandler;
  /** Optional event publisher (present when the rabbitmq add-on is enabled for this service). */
  publish?: (event: typeof apiEvents.todoCompleted, payload: { todoId: string; userId: string; completedAt: string }) => Promise<void>;
}

const userId = (req: Request) => {
  if (!req.user) throw unauthorized();
  return req.user.id;
};

/** Example feature module: routes → repo. Copy this folder as the starting point for new features. */
export function registerTodoRoutes(router: Router, deps: TodoRoutesDeps): void {
  const middleware = [deps.requireAuth];

  implement(
    router,
    apiRoutes.listTodos,
    async ({ req, query }) => ({
      items: await deps.repo.list(userId(req), {
        completed: query.completed === undefined ? undefined : query.completed === 'true',
      }),
    }),
    { middleware },
  );

  implement(router, apiRoutes.createTodo, ({ req, body }) => deps.repo.create(userId(req), body.title), { middleware });

  implement(
    router,
    apiRoutes.updateTodo,
    async ({ req, params, body }) => {
      const todo = await deps.repo.update(userId(req), params.id, body);
      if (!todo) throw notFound('Todo not found');
      if (body.completed && deps.publish) {
        await deps.publish(apiEvents.todoCompleted, { todoId: todo.id, userId: userId(req), completedAt: todo.updatedAt });
      }
      return todo;
    },
    { middleware },
  );

  implement(
    router,
    apiRoutes.deleteTodo,
    async ({ req, params }) => {
      if (!(await deps.repo.remove(userId(req), params.id))) throw notFound('Todo not found');
    },
    { middleware },
  );
}
