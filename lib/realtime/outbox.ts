import type { RealtimeEvent } from './bus';
import { publish, topics } from '../realtime/bus';
import { getData } from '../data';
import { logger } from '../logger';

export interface OutboxRecipient {
  userId: string;
  /**
   * The payload *this* recipient is allowed to see. Messages are rendered per
   * viewer (media permissions, blocked senders, read receipts), so the durable
   * row stores the tailored copy rather than one shared blob.
   */
  payload: unknown;
}

export interface OutboxInput {
  /** User ids that should receive the event. */
  recipientUserIds: string[];
  topic: string;
  type: string;
  payload: unknown;
}

export interface PublishEventInput {
  topic: string;
  type: string;
  recipients: OutboxRecipient[];
}

/**
 * Time-ordered, collision-resistant event ids.
 *
 * The reconnect cursor is `WHERE id > :afterId ORDER BY createdAt, id`, so the
 * id itself has to sort in creation order — a purely random id would silently
 * skip events on catch-up. Format: `evt_<ms base36>_<seq>_<rand>`.
 */
let sequence = 0;
let lastMs = 0;
export function newEventId(): string {
  const now = Date.now();
  if (now === lastMs) sequence += 1;
  else {
    lastMs = now;
    sequence = 0;
  }
  const rand = Math.random().toString(36).slice(2, 8);
  return `evt_${now.toString(36).padStart(9, '0')}_${sequence.toString(36).padStart(4, '0')}_${rand}`;
}

/**
 * The durable fan-out path.
 *
 * 1. one `OutboxEvent` row per recipient is written first — that is the record
 *    a reconnecting client replays from, and it survives a restart, a crash
 *    between the write and the publish, and a deployment;
 * 2. the event is then published on the in-process bus for sockets that are
 *    already connected;
 * 3. the rows are marked delivered so the worker does not publish them a second
 *    time. Rows that never got marked (crash, or written by another process)
 *    stay pending and the worker republishes them.
 *
 * PostgreSQL stays the source of truth: a successful WebSocket send is never
 * treated as proof the transaction committed, and a failed publish never rolls
 * the calling transaction back.
 */
export async function publishEvent(input: PublishEventInput): Promise<void> {
  const data = await getData();
  const now = new Date();
  const written: string[] = [];

  for (const recipient of input.recipients) {
    const id = newEventId();
    try {
      await data.outbox.enqueue({
        id,
        userId: recipient.userId,
        topic: input.topic,
        type: input.type,
        payload: recipient.payload,
        createdAt: now,
      });
      written.push(id);
    } catch (error) {
      // A full outbox must not break the write that produced the event; the
      // client still reconciles from REST on the next fetch.
      logger.warn('outbox.enqueue_failed', { type: input.type, error: String(error) });
    }
  }

  // One publish per distinct payload. Every subscriber filters by recipient
  // (see `eventAddressedTo`), so publishing a tailored copy per recipient is
  // what keeps private fields out of the other participant's stream.
  for (const recipient of input.recipients) {
    publish(input.topic, input.type, recipient.payload);
  }

  if (written.length > 0) {
    await data.outbox.markDelivered(written).catch((error) => {
      logger.warn('outbox.mark_failed', { error: String(error) });
    });
  }
}

/** Convenience wrapper: same payload for every recipient. */
export async function enqueueOutbox(input: OutboxInput): Promise<void> {
  await publishEvent({
    topic: input.topic,
    type: input.type,
    recipients: input.recipientUserIds.map((userId) => ({ userId, payload: input.payload })),
  });
}

/**
 * Notify-first delivery.
 *
 * Publishes to the in-process bus immediately — connected sockets and SSE
 * streams receive the event in the same tick — without touching the database.
 * Message delivery must never wait for an insert to commit; durability is the
 * background writer's job (see `persistOutbox`).
 */
export function publishLive(input: {
  topic: string;
  type: string;
  recipients: OutboxRecipient[];
}): void {
  for (const recipient of input.recipients) {
    publish(input.topic, input.type, recipient.payload);
  }
}

/**
 * Writes the durable outbox rows for an event that was already published live,
 * then marks them delivered so the recovery worker does not republish them.
 * Returns the ids that were written; failures are logged, never thrown — a
 * missing replay row only costs a reconnecting client one catch-up event, it
 * must never take the write path down.
 */
export async function persistOutbox(input: {
  topic: string;
  type: string;
  recipients: OutboxRecipient[];
}): Promise<string[]> {
  const data = await getData();
  const now = new Date();
  const written: string[] = [];

  for (const recipient of input.recipients) {
    const id = newEventId();
    try {
      await data.outbox.enqueue({
        id,
        userId: recipient.userId,
        topic: input.topic,
        type: input.type,
        payload: recipient.payload,
        createdAt: now,
      });
      written.push(id);
    } catch (error) {
      logger.warn('outbox.enqueue_failed', { type: input.type, error: String(error) });
    }
  }

  if (written.length > 0) {
    await data.outbox.markDelivered(written).catch((error) => {
      logger.warn('outbox.mark_failed', { error: String(error) });
    });
  }
  return written;
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
 * Republishes outbox rows that were never marked delivered, so events survive a
 * restart or a publish failure. Rows younger than `graceMs` are left alone:
 * those are in flight inside `publishEvent`, which marks them itself, and
 * claiming them here would deliver the same event twice.
 */
export function runOutboxWorker(
  options: { pollMs?: number; batchSize?: number; graceMs?: number; retentionDays?: number } = {},
): OutboxWorker {
  const pollMs = options.pollMs ?? 500;
  const batchSize = options.batchSize ?? 200;
  const graceMs = options.graceMs ?? 2_000;
  const retentionDays = options.retentionDays ?? 7;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let lastPrune = 0;

  async function tick() {
    try {
      const data = await getData();
      const pending = await data.outbox.claimPending(batchSize);
      const stale = pending.filter((event) => Date.now() - event.createdAt.getTime() > graceMs);
      for (const evt of stale) {
        publish(evt.topic, evt.type, evt.payload);
      }
      if (stale.length > 0) {
        await data.outbox.markDelivered(stale.map((e) => e.id));
        logger.info('outbox.recovered', { count: stale.length });
      }
      const now = Date.now();
      if (now - lastPrune > 60 * 60 * 1000) {
        lastPrune = now;
        const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000);
        const pruned = await data.outbox.pruneOlderThan(cutoff).catch(() => 0);
        if (pruned > 0) logger.info('outbox.pruned', { count: pruned });
      }
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

export type { RealtimeEvent };
