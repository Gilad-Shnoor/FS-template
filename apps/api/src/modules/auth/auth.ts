import { betterAuth } from 'better-auth';
import pg from 'pg';
import type { ApiConfig } from '../../config';

/**
 * Better Auth, wired to this service's Postgres schema. Its tables (user, session, account,
 * verification) are created by a regular Knex migration (migrations/*_better_auth.ts) so Knex
 * stays the single owner of the schema. If you enable a Better Auth plugin that adds tables,
 * run `npx @better-auth/cli generate` and copy the new columns into a new Knex migration.
 */
export function createAuth(config: ApiConfig) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    options: `-c search_path=${config.DB_SCHEMA}`,
    max: 5,
  });

  const auth = betterAuth({
    database: pool,
    baseURL: config.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: config.TRUSTED_ORIGINS,
    emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
    // Add social providers here, e.g.
    // socialProviders: { github: { clientId: ..., clientSecret: ... } },
  });

  return { auth, pool };
}

export type Auth = ReturnType<typeof createAuth>['auth'];
