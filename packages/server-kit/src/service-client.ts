import { createClient, type Client, type RouteMap } from '@app/contracts';
import { REQUEST_ID_HEADER, currentRequestId } from './context';

/**
 * Typed client for calling another service inside the cluster (k8s DNS: http://<service>:3000).
 * Propagates the current request id so one id traces a request across every service it touches.
 */
export function createServiceClient<const M extends RouteMap>(routes: M, baseUrl: string): Client<M> {
  return createClient(routes, {
    baseUrl,
    headers: () => ({ [REQUEST_ID_HEADER]: currentRequestId() }),
  });
}
