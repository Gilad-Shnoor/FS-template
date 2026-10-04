import { z } from 'zod';
import { defineEvent } from '../events';
import { defineRoute, defineRoutes } from '../http';
import { ReadinessResponse } from '../system';

// ---------- Schemas (source of truth; types are inferred) ----------

export const AuthUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
});
export type AuthUser = z.infer<typeof AuthUser>;

export const MeResponse = z.object({
  user: AuthUser.nullable(),
  authEnabled: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const Todo = z.object({
  id: z.uuid(),
  title: z.string(),
  completed: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Todo = z.infer<typeof Todo>;

export const CreateTodoBody = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
});
export type CreateTodoBody = z.infer<typeof CreateTodoBody>;

export const UpdateTodoBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    completed: z.boolean().optional(),
  })
  .refine((b) => b.title !== undefined || b.completed !== undefined, 'Nothing to update');
export type UpdateTodoBody = z.infer<typeof UpdateTodoBody>;

const TodoIdParams = z.object({ id: z.uuid() });

// ---------- Routes ----------

export const apiRoutes = defineRoutes({
  readiness: defineRoute({ method: 'GET', path: '/api/readyz', response: ReadinessResponse }),

  me: defineRoute({ method: 'GET', path: '/api/me', response: MeResponse }),

  listTodos: defineRoute({
    method: 'GET',
    path: '/api/todos',
    query: z.object({ completed: z.enum(['true', 'false']).optional() }),
    response: z.object({ items: z.array(Todo) }),
  }),
  createTodo: defineRoute({
    method: 'POST',
    path: '/api/todos',
    body: CreateTodoBody,
    response: Todo,
    status: 201,
  }),
  updateTodo: defineRoute({
    method: 'PATCH',
    path: '/api/todos/:id',
    params: TodoIdParams,
    body: UpdateTodoBody,
    response: Todo,
  }),
  deleteTodo: defineRoute({
    method: 'DELETE',
    path: '/api/todos/:id',
    params: TodoIdParams,
    response: z.void(),
  }),
});

// ---------- Events (used once the rabbitmq add-on is enabled) ----------

export const apiEvents = {
  todoCompleted: defineEvent(
    'api.todo.completed',
    z.object({ todoId: z.uuid(), userId: z.string(), completedAt: z.iso.datetime() }),
  ),
};
