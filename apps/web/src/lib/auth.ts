import { createAuthClient } from 'better-auth/react';

/** Better Auth client. Talks to the api's /api/auth/* through the same-origin gateway route. */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
});
