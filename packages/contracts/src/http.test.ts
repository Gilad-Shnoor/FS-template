import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiClientError } from './errors';
import { buildPath, buildQuery, createClient, defineRoute, defineRoutes } from './http';

const routes = defineRoutes({
  get: defineRoute({
    method: 'GET',
    path: '/items/:id',
    params: z.object({ id: z.string() }),
    response: z.object({ id: z.string() }),
  }),
  remove: defineRoute({ method: 'DELETE', path: '/items', response: z.void() }),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('buildPath / buildQuery', () => {
  it('substitutes and encodes params', () => {
    expect(buildPath('/a/:id/b/:x', { id: 'a b', x: 1 })).toBe('/a/a%20b/b/1');
  });
  it('throws on a missing param', () => {
    expect(() => buildPath('/a/:id', {})).toThrow(/Missing path param/);
  });
  it('skips undefined query values', () => {
    expect(buildQuery({ a: 1, b: undefined, c: ['x', 'y'] })).toBe('?a=1&c=x&c=y');
  });
});

describe('createClient', () => {
  it('calls the right URL and validates the response', async () => {
    const fetch = vi.fn(async () => json(200, { id: '42', extra: true }));
    const client = createClient(routes, { baseUrl: 'http://svc', fetch, headers: () => ({ 'x-request-id': 'r1' }) });

    await expect(client.get({ params: { id: '42' } })).resolves.toEqual({ id: '42' });
    expect(fetch).toHaveBeenCalledWith(
      'http://svc/items/42',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ 'x-request-id': 'r1' }) }),
    );
  });

  it('returns undefined for 204', async () => {
    const client = createClient(routes, { baseUrl: '', fetch: async () => new Response(null, { status: 204 }) });
    await expect(client.remove()).resolves.toBeUndefined();
  });

  it('turns error bodies into ApiClientError', async () => {
    const fetch = async () => json(404, { error: { code: 'NOT_FOUND', message: 'nope', requestId: 'r2' } });
    const client = createClient(routes, { baseUrl: '', fetch });
    const err = await client.get({ params: { id: '1' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ status: 404, code: 'NOT_FOUND', requestId: 'r2' });
  });
});
