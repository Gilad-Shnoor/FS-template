import type { z } from 'zod';
import { stackEnvSchema } from './stack.gen';

/** stack.json wiring (db, add-ons, called services) + settings specific to __name__. */
export const envSchema = stackEnvSchema.extend({
  // EXAMPLE_FLAG: envBool.default(false),
});

export type Config = z.output<typeof envSchema>;
