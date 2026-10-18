import { createLogger, loadConfig } from '@app/server-kit';
import { serviceEnv } from '@app/server-kit/testing-env';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { envSchema } from './config';
import { connectStack } from './stack.gen';

// serviceEnv(): the env this service gets in the cluster, pointed at this test run's containers.
const config = loadConfig(envSchema, serviceEnv('__name__'));
const logger = createLogger(config);

describe('__name__', () => {
  it('answers ping', async () => {
    const res = await request(buildApp({ config, logger })).get('/api/__name__/ping');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('__name__');
  });

  it('connects to everything stack.json gives it', async () => {
    const { readiness, cleanup } = await connectStack(config, logger);
    try {
      const res = await request(buildApp({ config, logger, readiness })).get('/readyz');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } finally {
      for (const close of cleanup) await close();
    }
  });
});
