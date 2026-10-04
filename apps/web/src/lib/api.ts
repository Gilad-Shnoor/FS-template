import { ApiClientError, createClient } from '@app/contracts';
import { apiRoutes } from '@app/contracts/api';
import { queryOptions } from '@tanstack/react-query';

/**
 * Typed client for the api service. Same origin: the gateway routes app.localhost/api → api,
 * so cookies just work and there's no CORS in the browser.
 */
export const api = createClient(apiRoutes, { baseUrl: '', credentials: 'include' });

/** Query keys and options live next to the client so every component shares them. */
export const queries = {
  me: () => queryOptions({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 60_000 }),
  readiness: () =>
    queryOptions({
      queryKey: ['readiness'],
      // readiness returns 503 with a body when degraded; surface that body instead of throwing.
      queryFn: () =>
        api.readiness().catch((e: unknown) => {
          if (e instanceof ApiClientError) return null;
          throw e;
        }),
      refetchInterval: 10_000,
    }),
  todos: () => queryOptions({ queryKey: ['todos'], queryFn: () => api.listTodos({ query: {} }) }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
