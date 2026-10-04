import { ApiClientError, ErrorCode, type ApiErrorBody } from '@app/contracts';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/** Throw these from handlers; the error middleware turns them into ApiErrorBody responses. */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message = 'Bad request', details?: unknown) =>
  new HttpError(400, ErrorCode.BAD_REQUEST, message, details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, ErrorCode.UNAUTHORIZED, message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, ErrorCode.FORBIDDEN, message);
export const notFound = (message = 'Not found') => new HttpError(404, ErrorCode.NOT_FOUND, message);
export const conflict = (message = 'Conflict', details?: unknown) =>
  new HttpError(409, ErrorCode.CONFLICT, message, details);

/** Raised by `implement()` when a handler's return value doesn't match its contract. */
export class ContractViolationError extends Error {
  override readonly name = 'ContractViolationError';
  constructor(
    readonly route: string,
    readonly issues: ZodError['issues'],
  ) {
    super(`Response for ${route} does not match its contract`);
  }
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFound(`No route for ${req.method} ${req.path}`));
};

export function createErrorHandler(opts: { exposeInternals: boolean }): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    const requestId = String(req.id ?? '');
    let status = 500;
    let body: ApiErrorBody['error'];

    if (err instanceof HttpError) {
      status = err.status;
      body = { code: err.code, message: err.message, details: err.details };
    } else if (err instanceof ZodError) {
      status = 400;
      body = { code: ErrorCode.VALIDATION_FAILED, message: 'Request validation failed', details: err.issues };
    } else if (err instanceof ApiClientError) {
      // A downstream service failed. Surface it as 502 and keep its request id for tracing.
      status = 502;
      body = {
        code: ErrorCode.UPSTREAM_FAILED,
        message: opts.exposeInternals ? `Upstream: ${err.message}` : 'Upstream service failed',
        details: opts.exposeInternals ? { status: err.status, code: err.code } : undefined,
      };
    } else if (isBodyParserError(err)) {
      status = err.status;
      body = { code: ErrorCode.BAD_REQUEST, message: err.message };
    } else {
      const e = err instanceof Error ? err : new Error(String(err));
      body = {
        code: ErrorCode.INTERNAL,
        message: opts.exposeInternals ? e.message : 'Internal server error',
        details:
          opts.exposeInternals && err instanceof ContractViolationError
            ? err.issues
            : opts.exposeInternals
              ? { stack: e.stack?.split('\n').slice(0, 8) }
              : undefined,
      };
    }

    if (status >= 500) req.log?.error({ err }, 'request failed');
    else req.log?.warn({ code: body.code, status }, body.message);

    res.status(status).json({ error: { ...body, requestId } } satisfies ApiErrorBody);
  };
}

function isBodyParserError(err: unknown): err is { status: number; message: string; type: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number' &&
    (err as { status: number }).status < 500
  );
}
