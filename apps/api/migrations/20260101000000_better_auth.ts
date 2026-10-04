import type { Knex } from 'knex';

// Better Auth core schema (user, session, account, verification), owned by Knex.
// Column names are camelCase because that's what Better Auth queries.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('email').notNullable().unique();
    t.boolean('emailVerified').notNullable().defaultTo(false);
    t.text('image');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('session', (t) => {
    t.text('id').primary();
    t.timestamp('expiresAt', { useTz: true }).notNullable();
    t.text('token').notNullable().unique();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('ipAddress');
    t.text('userAgent');
    t.text('userId').notNullable().references('id').inTable('user').onDelete('CASCADE');
    t.index(['userId']);
  });

  await knex.schema.createTable('account', (t) => {
    t.text('id').primary();
    t.text('accountId').notNullable();
    t.text('providerId').notNullable();
    t.text('userId').notNullable().references('id').inTable('user').onDelete('CASCADE');
    t.text('accessToken');
    t.text('refreshToken');
    t.text('idToken');
    t.timestamp('accessTokenExpiresAt', { useTz: true });
    t.timestamp('refreshTokenExpiresAt', { useTz: true });
    t.text('scope');
    t.text('password');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['userId']);
  });

  await knex.schema.createTable('verification', (t) => {
    t.text('id').primary();
    t.text('identifier').notNullable();
    t.text('value').notNullable();
    t.timestamp('expiresAt', { useTz: true }).notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['identifier']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('verification');
  await knex.schema.dropTableIfExists('account');
  await knex.schema.dropTableIfExists('session');
  await knex.schema.dropTableIfExists('user');
}
