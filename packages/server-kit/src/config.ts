import { z } from 'zod';

/** "true"/"false"/"1"/"0" → boolean. (z.coerce.boolean() treats "false" as true.) */
export const envBool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** "a,b , c" → ['a','b','c'] */
export const envList = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

/** Every service gets these. Values come from the generated Deployment env (see stack.json). */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('service'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: envList.default([]),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
});
export type BaseConfig = z.infer<typeof baseEnvSchema>;

/** Add to a service schema when stack.json gives it a database (`db: own | shared`). */
export const dbEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DB_SCHEMA: z.string().default('public'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
});

/** Add when the service `uses` the redis add-on. */
export const redisEnvSchema = z.object({ REDIS_URL: z.string().min(1) });

/** Add when the service `uses` the rabbitmq add-on. */
export const rabbitmqEnvSchema = z.object({ RABBITMQ_URL: z.string().min(1) });

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Validate process.env against base + service schema. Fails fast with every problem listed,
 * so a misconfigured pod crashes with a readable message instead of misbehaving later.
 */
export function loadConfig<S extends z.ZodObject>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): BaseConfig & z.output<S> {
  const full = baseEnvSchema.extend(schema.shape);
  const result = full.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data as BaseConfig & z.output<S>;
}

/** Read a required env var at call time (used by generated service clients). */
export function requireEnv(name: string, env: Record<string, string | undefined> = process.env): string {
  const value = env[name];
  if (!value) {
    throw new ConfigError(`Missing env var ${name}. Is the dependency declared in stack.json ("calls"/"uses")?`);
  }
  return value;
}
