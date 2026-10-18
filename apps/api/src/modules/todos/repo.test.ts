import { randomUUID } from 'node:crypto';
import { createDb } from '@app/server-kit/db';
import { serviceEnv } from '@app/server-kit/testing-env';
import { afterAll, describe, expect, it } from 'vitest';
import { createKnexTodoRepo } from './repo';

// Each test uses its own random users, so tests (and files) sharing the database never collide.
const env = serviceEnv('api');
const db = createDb({ url: env.DATABASE_URL!, schema: env.DB_SCHEMA! });
const repo = createKnexTodoRepo(db);
const newUser = () => `user-${randomUUID()}`;

afterAll(() => db.destroy());

describe('knex todo repo', () => {
  it('creates, updates and removes a todo', async () => {
    const user = newUser();
    const todo = await repo.create(user, 'write tests');
    expect(todo).toMatchObject({ title: 'write tests', completed: false });

    const updated = await repo.update(user, todo.id, { completed: true, title: 'wrote tests' });
    expect(updated).toMatchObject({ id: todo.id, title: 'wrote tests', completed: true });
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(todo.updatedAt));

    expect(await repo.remove(user, todo.id)).toBe(true);
    expect(await repo.remove(user, todo.id)).toBe(false);
    expect(await repo.list(user)).toEqual([]);
  });

  it('lists newest first and filters by completed', async () => {
    const user = newUser();
    const first = await repo.create(user, 'first');
    const second = await repo.create(user, 'second');
    await repo.update(user, first.id, { completed: true });

    expect((await repo.list(user)).map((t) => t.id)).toEqual([second.id, first.id]);
    expect((await repo.list(user, { completed: true })).map((t) => t.id)).toEqual([first.id]);
    expect((await repo.list(user, { completed: false })).map((t) => t.id)).toEqual([second.id]);
  });

  it("never exposes or changes another user's todos", async () => {
    const owner = newUser();
    const other = newUser();
    const todo = await repo.create(owner, 'private');

    expect(await repo.list(other)).toEqual([]);
    expect(await repo.update(other, todo.id, { completed: true })).toBeNull();
    expect(await repo.remove(other, todo.id)).toBe(false);
    expect(await repo.list(owner)).toMatchObject([{ id: todo.id, completed: false }]);
  });
});
