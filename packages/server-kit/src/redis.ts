// Redis add-on helper. Enable with: npm run stack -- use <service> redis; the service's generated
// connectStack() (src/stack.gen.ts) then creates the client and its readiness check.
import { Redis } from 'ioredis';
import type { Logger } from './logger';

export type { Redis };

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    // Reconnect with capped backoff; readiness reports unhealthy meanwhile.
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  redis.on('ready', () => logger.info('redis ready'));
  return redis;
}

/** Cache-aside helper: return cached JSON or compute, store with TTL, and return. */
export async function cached<T>(redis: Redis, key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit) as T;
  const value = await compute();
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  return value;
}
