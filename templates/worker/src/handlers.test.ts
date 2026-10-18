import { randomUUID } from 'node:crypto';
import { apiEvents } from '@app/contracts/api';
import { createLogger, loadConfig } from '@app/server-kit';
import { serviceEnv } from '@app/server-kit/testing-env';
import { describe, expect, it, vi } from 'vitest';
import { envSchema } from './config';
import { registerHandlers } from './handlers';
import { connectStack } from './stack.gen';

// serviceEnv(): the env this worker gets in the cluster, pointed at this test run's containers.
const config = loadConfig(envSchema, serviceEnv('__name__'));
const logger = createLogger(config);

describe('__name__', () => {
  it('handles todo-completed events', async () => {
    const { broker, readiness, cleanup } = await connectStack(config, logger);
    try {
      for (const check of Object.values(readiness)) await check();
      const info = vi.spyOn(logger, 'info');
      await registerHandlers({ broker, logger });

      const todoId = randomUUID();
      await broker.publish(apiEvents.todoCompleted, { todoId, userId: 'u1', completedAt: new Date().toISOString() });

      await vi.waitFor(() => expect(info).toHaveBeenCalledWith({ todoId }, 'todo completed'));
    } finally {
      // Broker first (connectStack orders it so): an unexpected connection loss exits the process.
      for (const close of cleanup) await close();
    }
  });
});
