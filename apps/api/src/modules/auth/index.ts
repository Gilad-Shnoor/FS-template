import { apiRoutes, type AuthUser } from '@app/contracts/api';
import { implement, unauthorized } from '@app/server-kit';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { Express, RequestHandler, Router } from 'express';
import type { Auth } from './auth';

/**
 * The auth module's whole surface. The rest of the app only uses:
 *   - `requireAuth` middleware
 *   - `req.user` (AuthUser | null)
 * Swapping Better Auth for something else (JWT, Passport, an IdP) only touches this folder.
 *
 * With AUTH_ENABLED=false every request is the fixed DEV_USER, handy for quick prototyping.
 */
export const DEV_USER: AuthUser = { id: 'dev-user', email: 'dev@example.com', name: 'Dev User' };

export interface AuthModule {
  /** Mount BEFORE body parsers (Better Auth reads the raw body). */
  mountHandler(app: Express): void;
  /** Resolves req.user on every request. */
  resolveUser: RequestHandler;
  requireAuth: RequestHandler;
  registerRoutes(router: Router): void;
}

export function createAuthModule(auth: Auth | null): AuthModule {
  return {
    mountHandler(app) {
      if (auth) app.all('/api/auth/*splat', toNodeHandler(auth));
    },

    resolveUser: async (req, _res, next) => {
      if (!auth) {
        req.user = DEV_USER;
        return next();
      }
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      req.user = session ? { id: session.user.id, email: session.user.email, name: session.user.name } : null;
      next();
    },

    requireAuth: (req, _res, next) => (req.user ? next() : next(unauthorized())),

    registerRoutes(router) {
      implement(router, apiRoutes.me, ({ req }) => ({ user: req.user ?? null, authEnabled: auth !== null }));
    },
  };
}
