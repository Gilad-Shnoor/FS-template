// For test files: what the root vitest.global-setup.ts provided for this run.
import { inject } from 'vitest';
import type { ContainerUrls } from './testing';

/**
 * The env `service` gets in the cluster (db role and schema, add-ons, called services), pointed at
 * this run's containers. Pass it to loadConfig(): `loadConfig(envSchema, serviceEnv('billing'))`.
 */
export function serviceEnv(service: string): Record<string, string> {
  const env = inject('serviceEnv')[service];
  if (!env) throw new Error(`No test env for "${service}": is it a node service in stack.json?`);
  return env;
}

/** Raw container URLs, for testing server-kit itself (services should use serviceEnv()). */
export const containerUrls = (): ContainerUrls => inject('containers');
