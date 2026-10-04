// @if db
import type { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  await knex('__snake___items').del();
  await knex('__snake___items').insert([{ name: 'example' }]);
}
// @endif
