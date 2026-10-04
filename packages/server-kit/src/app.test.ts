import { defineRoute } from '@app/contracts';
import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from './app';
import { loadConfig } from './config';
import { notFound } from './errors';
import { createLogger } from './logger';
import { implement } from './route';

const config = loadConfig(z.object({}), { SERVICE_NAME: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);

const echo = defineRoute({
  method: 'POST',
  path: '/echo/:id',
  params: z.object({ id: z.coerce.number() }),
  body: z.object({ name: z.string() }),
  response: z.object({ id: z.number(), name: z.string() }),
  status: 201,
});
const broken = defineRoute({ method: 'GET', path: '/broken', response: z.object({ ok: z.boolean() }) });
const missing = defineRoute({ method: 'GET', path: '/missing', response: z.object({}) });

function build(readiness = {}) {
  return createApp({
    config,
    logger,
    readiness,
    routes: (app) => {
      const r = Router();
      implement(r, echo, ({ params, body }) => Object.assign({ id: params.id, name: body.name }, { secret: 'stripped' }));
      // @ts-expect-error deliberately violates the contract
      implement(r, broken, () => ({ ok: 'yes' }));
      implement(r, missing, () => {
        throw notFound('gone');
      });
      app.use(r);
    },
  });
}

describe('createApp', () => {
  it('validates input, strips unknown output fields, and sets the status', async () => {
    const res = await request(build()).post('/echo/7').send({ name: 'a' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 7, name: 'a' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('returns VALIDATION_FAILED with issues for bad input', async () => {
    const res = await request(build()).post('/echo/7').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('propagates an incoming request id', async () => {
    const res = await request(build()).get('/healthz').set('x-request-id', 'abc');
    expect(res.headers['x-request-id']).toBe('abc');
  });

  it('reports contract violations as 500 with details outside production', async () => {
    const res = await request(build()).get('/broken');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/GET \/broken/);
  });

  it('maps HttpError and unknown routes to 404', async () => {
    expect((await request(build()).get('/missing')).body.error.code).toBe('NOT_FOUND');
    expect((await request(build()).get('/nope')).status).toBe(404);
  });

  it('reports readiness per dependency', async () => {
    const res = await request(build({ db: async () => 1, cache: async () => Promise.reject(new Error('down')) })).get(
      '/readyz',
    );
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ db: { ok: true }, cache: { ok: false, error: 'down' } });
  });
});

describe('loadConfig', () => {
  it('lists every invalid variable', () => {
    expect(() => loadConfig(z.object({ DATABASE_URL: z.string() }), { PORT: 'x' })).toThrow(/PORT[\s\S]*DATABASE_URL/);
  });
});
