import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('todos', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    // No FK to "user": the todos module stays independent of the auth implementation
    // (and works with AUTH_ENABLED=false, where the user is a fixed dev user).
    t.text('user_id').notNullable();
    t.text('title').notNullable();
    t.boolean('completed').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['user_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('todos');
}
