import type { ParsedRouteInput, RouteDef, RouteOutput } from '@app/contracts';
import type { Request, RequestHandler, Response, Router } from 'express';
import { ContractViolationError } from './errors';

export type HandlerArgs<R extends RouteDef> = ParsedRouteInput<R> & { req: Request; res: Response };
export type Handler<R extends RouteDef> = (args: HandlerArgs<R>) => Promise<RouteOutput<R>> | RouteOutput<R>;

export interface ImplementOptions {
  /** Run before validation, e.g. `requireAuth`. */
  middleware?: RequestHandler[];
}

/**
 * Bind a contract route to a handler.
 *  - params/query/body are parsed with the contract's Zod schemas (400 on failure)
 *  - the return value is parsed with the response schema (unknown fields are stripped,
 *    mismatches become a 500 ContractViolationError naming the route)
 *  - async errors propagate to the error middleware (Express 5)
 */
export function implement<R extends RouteDef>(
  router: Router,
  route: R,
  handler: Handler<R>,
  options: ImplementOptions = {},
): void {
  const method = route.method.toLowerCase() as Lowercase<RouteDef['method']>;
  const label = `${route.method} ${route.path}`;
  const successStatus = route.status ?? 200;

  const run: RequestHandler = async (req, res) => {
    const input: Record<string, unknown> = {};
    if (route.params) input.params = route.params.parse(req.params);
    if (route.query) input.query = route.query.parse(req.query);
    if (route.body) input.body = route.body.parse(req.body);

    const result = await handler({ ...input, req, res } as HandlerArgs<R>);
    if (res.headersSent) return;

    const checked = route.response.safeParse(result);
    if (!checked.success) throw new ContractViolationError(label, checked.error.issues);

    if (checked.data === undefined) {
      res.status(successStatus === 200 ? 204 : successStatus).end();
    } else {
      res.status(successStatus).json(checked.data);
    }
  };

  router[method](route.path, ...(options.middleware ?? []), run);
}
