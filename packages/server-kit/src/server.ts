import type { Server } from 'node:http';
import type { Express } from 'express';
import type { Logger } from './logger';

export type Cleanup = () => Promise<unknown> | unknown;

export interface StartServerOptions {
  port: number;
  logger: Logger;
  /** Run on shutdown after the server stops accepting connections, e.g. db.destroy(). */
  onShutdown?: Cleanup[];
  shutdownTimeoutMs?: number;
}

/**
 * Start listening and handle SIGTERM/SIGINT gracefully: stop accepting connections, finish
 * in-flight requests, close dependencies, exit. k8s sends SIGTERM on rollout/scale-down.
 */
export function startServer(app: Express, opts: StartServerOptions): Server {
  const { logger } = opts;
  const server = app.listen(opts.port, () => logger.info({ port: opts.port }, 'listening'));
  // Keep-alive longer than the gateway's idle timeout to avoid spurious 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, opts.shutdownTimeoutMs ?? 10_000);
    force.unref();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const cleanup of opts.onShutdown ?? []) {
      try {
        await cleanup();
      } catch (err) {
        logger.error({ err }, 'cleanup failed');
      }
    }
    logger.info('bye');
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  return server;
}

/** Wrap a service's main() so startup failures are logged clearly and exit non-zero. */
export function runMain(main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    // Logger may not exist yet (e.g. config error), so write plainly to stderr as well.
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
