import { createLogger, loadConfig } from '@app/server-kit';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app';

const config = loadConfig(z.object({}), { SERVICE_NAME: '__name__', LOG_LEVEL: 'silent' });

describe('__name__', () => {
  it('answers ping', async () => {
    const res = await request(buildApp({ config, logger: createLogger(config) })).get('/api/__name__/ping');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('__name__');
  });
});
