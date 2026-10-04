import { z } from 'zod';
import { defineRoute, defineRoutes } from '../http';

// Contract for the __name__ service: schemas are the source of truth, types are inferred.
// Callers get a typed client from this via `serviceClients().__camel__` (see stack.json `calls`).

export const __Pascal__Ping = z.object({ service: z.string(), time: z.iso.datetime() });
export type __Pascal__Ping = z.infer<typeof __Pascal__Ping>;

export const __camel__Routes = defineRoutes({
  ping: defineRoute({ method: 'GET', path: '/api/__name__/ping', response: __Pascal__Ping }),
});

export const __camel__Events = {};
