import type { Knex } from 'knex';

// Sample data for the dev user (used when AUTH_ENABLED=false). Idempotent.
export async function seed(knex: Knex): Promise<void> {
  await knex('todos').where({ user_id: 'dev-user' }).delete();
  await knex('todos').insert([
    { user_id: 'dev-user', title: 'Read the assignment twice', completed: true },
    { user_id: 'dev-user', title: 'Sketch the data model' },
    { user_id: 'dev-user', title: 'Ship it' },
  ]);
}
