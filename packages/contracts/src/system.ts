import { z } from 'zod';

/** Shape of `/readyz` (and its `/api/readyz` alias) on every service. */
export const ReadinessResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  uptimeSeconds: z.number(),
  checks: z.record(z.string(), z.object({ ok: z.boolean(), error: z.string().optional() })),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;
