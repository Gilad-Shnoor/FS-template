import type { z } from 'zod';

/**
 * An async message published to the message broker (RabbitMQ add-on).
 * Producers and consumers import the same definition, so payloads are validated on both ends.
 * Name events `<service>.<entity>.<past-tense-verb>`, e.g. `api.todo.completed`.
 */
export interface EventDef<N extends string = string, S extends z.ZodType = z.ZodType> {
  name: N;
  schema: S;
}

export function defineEvent<const N extends string, S extends z.ZodType>(name: N, schema: S): EventDef<N, S> {
  return { name, schema };
}

export type EventPayload<E extends EventDef> = z.output<E['schema']>;
