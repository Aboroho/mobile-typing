/**
 * Durable outbox for WebSocket/SSE fan-out.
 *
 * Services publish events through `enqueueOutbox()`, which writes a row per
 * recipient to the OutboxEvent table (or memory array). The background worker
 * (`runOutboxWorker`) polls for pending rows and republishes them to the
 * in-process event bus, delivering to connected WebSocket clients and ensuring
 * reconnecting clients can replay anything they missed.
 */
import { newId } from '@mt/utils';
import { getData } from '../data';
import type { OutboxEventRecord } from '../data/types';
import { publish, topics } from '../realtime/bus';
import { logger } from '../logger';

export interface OutboxInput {
  /** User ids that should receive the event. */
  recipientUserIds: string[];
  topic: string;
  type: string;
  payload: unknown;
}

export async function enqueueOutbox(input: OutboxInput): Promise<void> {
  const data = await getData();
  const now = new Date();
  const idBase = newId('evt');
  let idx = 0;
  for (const uid of input.recipientUserIds) {
    const id = `${idBase}_${idx++}`;
    await data.outbox.enqueue({
      id,
      userId: uid,
      topic: input.topic,
      type: input.type,
      payload: input.payload,
      createdAt: now,
    });
  }
  // Immediately publish in-process for any connected sockets on this node.
  publish(input.topic, input.type, input.payload);
}

/** Helper: enqueue a conversation event to all current participants. */
export async function enqueueConversationEvent(
  conversation: { id: string; participantIds: string[] },
  type: string,
  payload: unknown,
): Promise<void> {
  await enqueueOutbox({
    recipientUserIds: [...conversation.participantIds],
    topic: topics.messages(conversation.id),
    type,
    payload,
  });
}

export interface OutboxWorker {
  stop(): Promise<void>;
}

/**
 * Starts a polling loop that claims pending outbox rows and republishes them.
 * In multi-instance deployments, every instance polls; OutboxEvent rows are
 * marked delivered when any subscriber has received them (single-node VPS
 * model). For multi-DC, replace the in-process bus with Redis Streams or
 * Postgres LISTEN/NOTIFY.
 */
export function runOutboxWorker(options: { pollMs?: number; batchSize?: number } = {}): OutboxWorker {
  const pollMs = options.pollMs ?? 500;
  const batchSize = options.batchSize ?? 200;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function tick() {
    try {
      const data = await getData();
      const pending: OutboxEventRecord[] = await data.outbox.claimPending(batchSize);
      if (pending.length === 0) return;
      for (const evt of pending) {
        publish(evt.topic, evt.type, evt.payload);
      }
      await data.outbox.markDelivered(pending.map((e) => e.id));
      logger.debug('outbox.delivered', { count: pending.length });
    } catch (err) {
      logger.warn('outbox.tick_failed', { error: String(err) });
    }
  }

  async function loop() {
    while (!stopped) {
      await inFlight;
      inFlight = tick();
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  const loopPromise = loop();

  return {
    async stop() {
      stopped = true;
      await inFlight;
      await loopPromise;
    },
  };
}
