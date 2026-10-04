import { randomUUID } from 'node:crypto';
import type { ReadinessResponse } from '@app/contracts';
import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { BaseConfig } from './config';
import { REQUEST_ID_HEADER, requestContext } from './context';
import { createErrorHandler, notFoundHandler } from './errors';
import type { Logger } from './logger';

export type ReadinessCheck = () => Promise<unknown>;

export interface CreateAppOptions {
  config: BaseConfig;
  logger: Logger;
  /** Dependency checks for /readyz, e.g. { db: () => db.raw('select 1') }. */
  readiness?: Record<string, ReadinessCheck>;
  /** Mounted BEFORE body parsers. Use for handlers that read the raw body (e.g. Better Auth, webhooks). */
  beforeBodyParsers?: (app: Express) => void;
  /** Mount your routers here. */
  routes: (app: Express) => void;
}

const startedAt = Date.now();

/**
 * The standard middleware stack every service shares:
 * request id → structured request logging → helmet → CORS → compression → rate limit →
 * health endpoints → [beforeBodyParsers] → JSON body parsing → routes → 404 → error handler.
 */
export function createApp(opts: CreateAppOptions): Express {
  const { config, logger } = opts;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);

  // Request id: reuse the caller's (gateway or upstream service) or mint one, then expose it
  // to the whole async call stack so logs and downstream calls carry it.
  app.use((req, res, next) => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const id = incoming && incoming.length <= 128 ? incoming : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, id);
    requestContext.run({ requestId: id }, next);
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => String(res.getHeader(REQUEST_ID_HEADER)),
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false,
      credentials: true,
      exposedHeaders: [REQUEST_ID_HEADER],
    }),
  );
  app.use(compression());
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: config.RATE_LIMIT_PER_MINUTE,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => req.path.endsWith('/healthz') || req.path.endsWith('/readyz'),
      handler: (req, res) =>
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId: String(req.id) } }),
    }),
  );

  // Liveness: process is up. Readiness: dependencies reachable (k8s stops routing traffic if not).
  // The /api/* aliases let the web app reach them through the gateway's /api route.
  const liveness: express.RequestHandler = (_req, res) => {
    res.json({ status: 'ok' });
  };
  const readiness: express.RequestHandler = async (_req, res) => {
    const checks: ReadinessResponse['checks'] = {};
    await Promise.all(
      Object.entries(opts.readiness ?? {}).map(async ([name, check]) => {
        try {
          await withTimeout(check(), 2_000);
          checks[name] = { ok: true };
        } catch (err) {
          checks[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    const ok = Object.values(checks).every((c) => c.ok);
    const body: ReadinessResponse = {
      status: ok ? 'ok' : 'degraded',
      service: config.SERVICE_NAME,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks,
    };
    res.status(ok ? 200 : 503).json(body);
  };
  app.get(['/healthz', '/api/healthz'], liveness);
  app.get(['/readyz', '/api/readyz'], readiness);

  opts.beforeBodyParsers?.(app);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  opts.routes(app);

  app.use(notFoundHandler);
  app.use(createErrorHandler({ exposeInternals: config.NODE_ENV !== 'production' }));

  return app;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
