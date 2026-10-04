import { apiEvents } from '@app/contracts/api';
import type { Logger } from '@app/server-kit';
import type { Broker } from '@app/server-kit/rabbitmq';

/**
 * Event subscriptions for __name__. Queue names are `<service>.<purpose>` so each worker gets its
 * own durable queue; scaling this Deployment's replicas makes them compete for messages.
 */
export async function registerHandlers({ broker, logger }: { broker: Broker; logger: Logger }): Promise<void> {
  await broker.subscribe(apiEvents.todoCompleted, '__name__.todo-completed', async (event) => {
    logger.info({ todoId: event.todoId }, 'todo completed');
  });
}
