// RabbitMQ add-on helper. Enable with: npm run addon rabbitmq  (and add "rabbitmq" to `uses`)
import type { EventDef, EventPayload } from '@app/contracts';
import amqp from 'amqplib';
import { REQUEST_ID_HEADER, currentRequestId, requestContext } from './context';
import type { Logger } from './logger';

const EXCHANGE = 'events';

export interface Broker {
  publish<E extends EventDef>(event: E, payload: EventPayload<E>): Promise<void>;
  /**
   * Consume an event into a durable queue named `<queue>`. Payloads are validated against the
   * event schema. Handler errors are logged and the message is dropped (nack, no requeue) —
   * add a dead-letter exchange here if an assignment needs retries.
   */
  subscribe<E extends EventDef>(
    event: E,
    queue: string,
    handler: (payload: EventPayload<E>) => Promise<void>,
  ): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Topic exchange `events`; routing key = event name. On connection loss the process exits so
 * Kubernetes restarts it cleanly (simpler and more predictable than in-process reconnects).
 */
export async function createBroker(url: string, logger: Logger): Promise<Broker> {
  const connection = await amqp.connect(url);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.prefetch(10);

  let closing = false;
  connection.on('close', () => {
    if (closing) return;
    logger.fatal('rabbitmq connection closed unexpectedly, exiting');
    process.exit(1);
  });
  connection.on('error', (err: Error) => logger.error({ err: err.message }, 'rabbitmq error'));

  return {
    async publish(event, payload) {
      const body = event.schema.parse(payload);
      const reqId = currentRequestId();
      await new Promise<void>((resolve, reject) => {
        channel.publish(
          EXCHANGE,
          event.name,
          Buffer.from(JSON.stringify(body)),
          {
            persistent: true,
            contentType: 'application/json',
            headers: reqId ? { [REQUEST_ID_HEADER]: reqId } : {},
          },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      logger.debug({ event: event.name }, 'event published');
    },

    async subscribe(event, queue, handler) {
      await channel.assertQueue(queue, { durable: true });
      await channel.bindQueue(queue, EXCHANGE, event.name);
      await channel.consume(queue, (msg) => {
        if (!msg) return;
        const reqId = String(msg.properties.headers?.[REQUEST_ID_HEADER] ?? crypto.randomUUID());
        void requestContext.run({ requestId: reqId }, async () => {
          try {
            const payload = event.schema.parse(JSON.parse(msg.content.toString())) as EventPayload<typeof event>;
            await handler(payload);
            channel.ack(msg);
          } catch (err) {
            logger.error({ err, event: event.name, queue }, 'event handler failed; dropping message');
            channel.nack(msg, false, false);
          }
        });
      });
      logger.info({ event: event.name, queue }, 'subscribed');
    },

    async ping() {
      await channel.checkExchange(EXCHANGE);
    },

    async close() {
      closing = true;
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    },
  };
}
