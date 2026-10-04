import type { z } from 'zod';
import { ApiClientError, ApiErrorBody } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A single HTTP endpoint. The SAME object is used by:
 *  - the server (`implement()` in @app/server-kit) to validate input and output
 *  - every client (`createClient()` below) to build typed calls
 * so the two sides can't drift apart.
 */
export interface RouteDef {
  method: HttpMethod;
  /** Express-style path, e.g. `/api/todos/:id`. */
  path: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Use `z.void()` for 204 No Content. */
  response: z.ZodType;
  /** Success status code. Defaults to 200 (204 when response is void). */
  status?: number;
  summary?: string;
}

export type RouteMap = Record<string, RouteDef>;

export function defineRoute<const R extends RouteDef>(route: R): R {
  return route;
}

export function defineRoutes<const M extends RouteMap>(routes: M): M {
  return routes;
}

type ParamsPart<R> = R extends { params: infer P extends z.ZodType } ? { params: z.input<P> } : unknown;
type QueryPart<R> = R extends { query: infer Q extends z.ZodType } ? { query: z.input<Q> } : unknown;
type BodyPart<R> = R extends { body: infer B extends z.ZodType } ? { body: z.input<B> } : unknown;

/** What a caller must pass (wire format, i.e. Zod *input* types). */
export type RouteInput<R extends RouteDef> = ParamsPart<R> & QueryPart<R> & BodyPart<R>;

/** What a handler receives after validation (Zod *output* types). */
export type ParsedRouteInput<R extends RouteDef> = (R extends { params: infer P extends z.ZodType }
  ? { params: z.output<P> }
  : unknown) &
  (R extends { query: infer Q extends z.ZodType } ? { query: z.output<Q> } : unknown) &
  (R extends { body: infer B extends z.ZodType } ? { body: z.output<B> } : unknown);

export type RouteOutput<R extends RouteDef> = z.output<R['response']>;

type HasInput<R extends RouteDef> = R extends { params: z.ZodType } | { query: z.ZodType } | { body: z.ZodType }
  ? true
  : false;

export interface CallOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export type ClientFn<R extends RouteDef> =
  HasInput<R> extends true
    ? (input: RouteInput<R>, options?: CallOptions) => Promise<RouteOutput<R>>
    : (input?: Record<string, never>, options?: CallOptions) => Promise<RouteOutput<R>>;

export type Client<M extends RouteMap> = { [K in keyof M]: ClientFn<M[K]> };

export interface ClientOptions {
  /** '' for same-origin (browser), or e.g. 'http://billing:3000' between services. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Headers added to every request (evaluated per call), e.g. request-id propagation. */
  headers?: () => Record<string, string | undefined>;
  /** RequestInit (not the DOM-only RequestCredentials) so this compiles for Node services too. */
  credentials?: RequestInit['credentials'];
  /** Validate responses against the contract. Default true. */
  validateResponse?: boolean;
}

export function buildPath(path: string, params: Record<string, unknown> | undefined): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => {
    const value = params?.[key];
    if (value === undefined || value === null) {
      throw new Error(`Missing path param "${key}" for ${path}`);
    }
    return encodeURIComponent(String(value));
  });
}

export function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, String(v)));
    else search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/** Build a typed client for a service from its route map. */
export function createClient<const M extends RouteMap>(routes: M, options: ClientOptions): Client<M> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const validate = options.validateResponse ?? true;

  const client: Record<string, unknown> = {};
  for (const [name, route] of Object.entries(routes)) {
    client[name] = async (input: Record<string, unknown> = {}, call: CallOptions = {}) => {
      const url =
        options.baseUrl +
        buildPath(route.path, input.params as Record<string, unknown> | undefined) +
        buildQuery(input.query as Record<string, unknown> | undefined);

      const headers: Record<string, string> = { accept: 'application/json' };
      for (const [k, v] of Object.entries(options.headers?.() ?? {})) if (v) headers[k] = v;
      Object.assign(headers, call.headers);
      if (input.body !== undefined) headers['content-type'] = 'application/json';

      const res = await doFetch(url, {
        method: route.method,
        headers,
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
        credentials: options.credentials,
        signal: call.signal,
      });

      if (!res.ok) {
        const raw: unknown = await res.json().catch(() => undefined);
        const parsed = ApiErrorBody.safeParse(raw);
        if (parsed.success) {
          const e = parsed.data.error;
          throw new ApiClientError(res.status, e.code, e.message, e.details, e.requestId);
        }
        throw new ApiClientError(res.status, 'HTTP_ERROR', `${route.method} ${url} failed with ${res.status}`);
      }

      if (res.status === 204) return undefined;
      const data: unknown = await res.json();
      return validate ? route.response.parse(data) : data;
    };
  }
  return client as Client<M>;
}
