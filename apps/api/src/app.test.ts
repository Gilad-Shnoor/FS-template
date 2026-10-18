import { createLogger, loadConfig } from '@app/server-kit';
import { createDb } from '@app/server-kit/db';
import { serviceEnv } from '@app/server-kit/testing-env';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { apiEnvSchema } from './config';
import { createKnexTodoRepo } from './modules/todos/repo';

// Auth disabled (fixed dev user), real Postgres (the run's test container, migrated like the cluster).
const config = loadConfig(apiEnvSchema, { ...serviceEnv('api'), AUTH_ENABLED: 'false' });
const db = createDb({ url: config.DATABASE_URL, schema: config.DB_SCHEMA });
const app = () => buildApp({ config, logger: createLogger(config), auth: null, todos: createKnexTodoRepo(db) });

afterAll(() => db.destroy());

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

    // Other tests share the dev user, so look for this todo rather than counting.
    const completed = await request(a).get('/api/todos').query({ completed: 'true' });
    expect(completed.body.items.map((t: { id: string }) => t.id)).toContain(id);
    const open = await request(a).get('/api/todos').query({ completed: 'false' });
    expect(open.body.items.map((t: { id: string }) => t.id)).not.toContain(id);

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
