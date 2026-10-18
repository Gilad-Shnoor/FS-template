import type { Todo } from '@app/contracts/api';
import type { Knex } from 'knex';

/** Persistence port. Routes depend on this interface, not on Knex. */
export interface TodoRepo {
  list(userId: string, filter?: { completed?: boolean }): Promise<Todo[]>;
  create(userId: string, title: string): Promise<Todo>;
  update(userId: string, id: string, patch: { title?: string; completed?: boolean }): Promise<Todo | null>;
  remove(userId: string, id: string): Promise<boolean>;
}

interface TodoRow {
  id: string;
  user_id: string;
  title: string;
  completed: boolean;
  created_at: Date;
  updated_at: Date;
}

const toTodo = (r: TodoRow): Todo => ({
  id: r.id,
  title: r.title,
  completed: r.completed,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export function createKnexTodoRepo(db: Knex): TodoRepo {
  const table = () => db<TodoRow>('todos');
  return {
    async list(userId, filter = {}) {
      const q = table().where({ user_id: userId }).orderBy('created_at', 'desc');
      if (filter.completed !== undefined) q.andWhere({ completed: filter.completed });
      return (await q).map(toTodo);
    },
    async create(userId, title) {
      const [row] = await table().insert({ user_id: userId, title }).returning('*');
      return toTodo(row as TodoRow);
    },
    async update(userId, id, patch) {
      const [row] = await table()
        .where({ id, user_id: userId })
        .update({ ...patch, updated_at: db.fn.now() as unknown as Date })
        .returning('*');
      return row ? toTodo(row as TodoRow) : null;
    },
    async remove(userId, id) {
      return (await table().where({ id, user_id: userId }).delete()) > 0;
    },
  };
}
