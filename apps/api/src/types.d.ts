import type { AuthUser } from '@app/contracts/api';

declare module 'express-serve-static-core' {
  interface Request {
    /** Resolved by the auth module on every request: a user, or null when signed out. */
    user?: AuthUser | null;
  }
}
