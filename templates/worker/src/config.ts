import type { z } from 'zod';
import { stackEnvSchema } from './stack.gen';

/** stack.json wiring (rabbitmq, plus db/redis/called services if declared) + worker settings. */
export const envSchema = stackEnvSchema.extend({});

export type Config = z.output<typeof envSchema>;
