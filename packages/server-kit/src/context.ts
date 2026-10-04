import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

/**
 * Per-request context, available anywhere in the call stack without passing `req` around.
 * Used to propagate `x-request-id` to downstream services and into log lines.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export const currentRequestId = (): string | undefined => requestContext.getStore()?.requestId;

export const REQUEST_ID_HEADER = 'x-request-id';
