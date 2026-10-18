import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { cached, createRedis } from './redis';
import { containerUrls } from './testing-env';

const logger = createLogger(loadConfig(z.object({}), { LOG_LEVEL: 'silent' }));
const redis = createRedis(containerUrls().redis, logger);
// The container is shared by every test file in the run: keep keys unique.
const key = (name: string) => `test:${randomUUID()}:${name}`;

afterAll(() => redis.quit());

describe('redis', () => {
  it('cached() computes on a miss, then serves the stored value', async () => {
    const k = key('answer');
    const compute = vi.fn(async () => ({ answer: 42 }));

    expect(await cached(redis, k, 60, compute)).toEqual({ answer: 42 });
    expect(await cached(redis, k, 60, compute)).toEqual({ answer: 42 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('cached() stores values with the given TTL', async () => {
    const k = key('ttl');
    await cached(redis, k, 30, async () => 'value');
    const ttl = await redis.ttl(k);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });
});
