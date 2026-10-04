// @if db
import type { Knex } from 'knex';

// Tables are created in this service's own schema (search_path), or in `public` for db: shared.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('__snake___items', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.text('name').notNullable();
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('__snake___items');
}
// @endif
