import { __camel__Routes } from '@app/contracts/__name__';
import { implement } from '@app/server-kit';
import type { Router } from 'express';

/** Implement every route from @app/contracts/__name__ here (or split into src/modules/<feature>/). */
export function registerRoutes(router: Router): void {
  implement(router, __camel__Routes.ping, () => ({ service: '__name__', time: new Date().toISOString() }));
}
