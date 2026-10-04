import { createLogger, loadConfig } from '@app/server-kit';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app';
import { createMemoryTodoRepo } from './modules/todos/repo';

// Fast, DB-free tests: auth disabled (dev user) + in-memory repo.
const config = loadConfig(z.object({}), { SERVICE_NAME: 'api', LOG_LEVEL: 'silent' });
const app = () => buildApp({ config, logger: createLogger(config), auth: null, todos: createMemoryTodoRepo() });

describe('api', () => {
  it('reports the dev user when auth is disabled', async () => {
    const res = await request(app()).get('/api/me');
    expect(res.body).toEqual({ user: { id: 'dev-user', email: 'dev@example.com', name: 'Dev User' }, authEnabled: false });
  });

  it('creates, lists, updates and deletes todos', async () => {
    const a = app();
    const created = await request(a).post('/api/todos').send({ title: '  write tests ' });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe('write tests');

    const id = created.body.id as string;
    const updated = await request(a).patch(`/api/todos/${id}`).send({ completed: true });
    expect(updated.body.completed).toBe(true);

    const list = await request(a).get('/api/todos').query({ completed: 'true' });
    expect(list.body.items).toHaveLength(1);

    expect((await request(a).delete(`/api/todos/${id}`)).status).toBe(204);
    expect((await request(a).delete(`/api/todos/${id}`)).status).toBe(404);
  });

  it('rejects invalid input with VALIDATION_FAILED', async () => {
    const res = await request(app()).post('/api/todos').send({ title: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a malformed id', async () => {
    const res = await request(app()).patch('/api/todos/not-a-uuid').send({ completed: true });
    expect(res.status).toBe(400);
  });
});
