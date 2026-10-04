import { envBool, envList } from '@app/server-kit';
import { z } from 'zod';
import { stackEnvSchema } from './stack.gen';

/**
 * Service config = what stack.json wires in (stackEnvSchema: DB, add-ons, called services)
 * + this service's own settings. Values come from the generated Deployment env.
 */
export const apiEnvSchema = stackEnvSchema.extend({
  AUTH_ENABLED: envBool.default(true),
  BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 chars (openssl rand -base64 32)'),
  /** Public origin the browser uses, e.g. http://app.localhost (auth lives at /api/auth there). */
  BETTER_AUTH_URL: z.url(),
  TRUSTED_ORIGINS: envList.default([]),
});

export type ApiConfig = z.output<typeof apiEnvSchema>;
