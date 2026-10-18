import { randomUUID } from 'node:crypto';
import { defineEvent } from '@app/contracts';
import amqp from 'amqplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from './config';
import { currentRequestId, requestContext } from './context';
import { createLogger } from './logger';
import { createBroker, type Broker } from './rabbitmq';
import { containerUrls } from './testing-env';

const logger = createLogger(loadConfig(z.object({}), { LOG_LEVEL: 'silent' }));
// The broker is shared by every test file in the run: unique event and queue names per test.
const uniqueEvent = () => defineEvent(`test.${randomUUID()}.happened`, z.object({ n: z.number() }));
const uniqueQueue = () => `test.${randomUUID()}`;

let broker: Broker;
beforeAll(async () => {
  broker = await createBroker(containerUrls().rabbitmq, logger);
});
// Close before the containers stop: an unexpected connection loss makes the broker exit the process.
afterAll(() => broker.close());

describe('rabbitmq broker', () => {
  it('answers ping', async () => {
    await expect(broker.ping()).resolves.toBeUndefined();
  });

  it('delivers published events to subscribers, with the request id', async () => {
    const event = uniqueEvent();
    const received: { payload: unknown; requestId: string | undefined }[] = [];
    await broker.subscribe(event, uniqueQueue(), async (payload) => {
      received.push({ payload, requestId: currentRequestId() });
    });

    await requestContext.run({ requestId: 'req-123' }, () => broker.publish(event, { n: 1 }));

    await vi.waitFor(() => expect(received).toEqual([{ payload: { n: 1 }, requestId: 'req-123' }]));
  });

  it('drops (does not redeliver) a message that fails validation', async () => {
    const event = uniqueEvent();
    const queue = uniqueQueue();
    const handler = vi.fn(async () => undefined);
    const errors = vi.spyOn(logger, 'error');
    await broker.subscribe(event, queue, handler);

    // Bypass publish()'s validation, as a misbehaving producer would.
    const connection = await amqp.connect(containerUrls().rabbitmq);
    try {
      const channel = await connection.createConfirmChannel();
      channel.publish('events', event.name, Buffer.from(JSON.stringify({ n: 'not a number' })));
      await channel.waitForConfirms();
    } finally {
      await connection.close();
    }
    await broker.publish(event, { n: 2 });

    // Queues are FIFO: once the valid message is handled, the invalid one has been seen. Requeueing
    // it would redeliver it in a loop and log an error each time.
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({ n: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 300)); // give a redelivery loop time to show
    expect(handler).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.filter(([ctx]) => (ctx as { queue?: string }).queue === queue)).toHaveLength(1);
  });
});
