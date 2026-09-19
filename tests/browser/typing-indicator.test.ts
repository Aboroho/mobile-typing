import { describe, expect, it, vi } from 'vitest';
import { createTypingPublisher, createTypingReceiver, type Scheduler } from '@/lib/browser/typing-indicator';

/** Deterministic clock + timers so the tests never wait on real time. */
function fakeScheduler(): Scheduler & { advance(ms: number): void } {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  return {
    now: () => now,
    setTimeout: (handler, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, handler });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as unknown as number);
    },
    advance(ms) {
      const target = now + ms;
      // Fire timers in order, allowing handlers to schedule new ones.
      for (;;) {
        const due = Array.from(timers.entries())
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].handler();
      }
      now = target;
    },
  };
}

describe('createTypingPublisher', () => {
  it('sends one "typing" for a burst of keystrokes and one "stopped" after the idle period', () => {
    const scheduler = fakeScheduler();
    const send = vi.fn();
    const publisher = createTypingPublisher({ send, scheduler, idleMs: 2500, heartbeatMs: 4000 });

    for (let index = 0; index < 20; index += 1) {
      publisher.noteActivity(true);
      scheduler.advance(50);
    }
    expect(send.mock.calls).toEqual([[true]]);
    expect(publisher.active).toBe(true);

    scheduler.advance(2500);
    expect(send.mock.calls).toEqual([[true], [false]]);
    expect(publisher.active).toBe(false);
  });

  it('refreshes the indicator once per heartbeat while typing continues', () => {
    const scheduler = fakeScheduler();
    const send = vi.fn();
    const publisher = createTypingPublisher({ send, scheduler, idleMs: 2500, heartbeatMs: 4000 });

    // 12 seconds of continuous typing, a key every 500 ms.
    for (let elapsed = 0; elapsed < 12_000; elapsed += 500) {
      publisher.noteActivity(true);
      scheduler.advance(500);
    }
    const trues = send.mock.calls.filter(([value]) => value === true).length;
    expect(trues).toBe(3); // t=0, t=4000, t=8000
    expect(send.mock.calls.some(([value]) => value === false)).toBe(false);
  });

  it('stops immediately when the message is sent or the composer is cleared', () => {
    const scheduler = fakeScheduler();
    const send = vi.fn();
    const publisher = createTypingPublisher({ send, scheduler });

    publisher.noteActivity(true);
    publisher.stop();
    expect(send.mock.calls).toEqual([[true], [false]]);

    publisher.noteActivity(true);
    publisher.noteActivity(false); // composer emptied
    expect(send.mock.calls).toEqual([[true], [false], [true], [false]]);

    // No trailing "stopped" from a stale idle timer.
    scheduler.advance(10_000);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('does nothing when stopped while already idle and ignores activity after dispose', () => {
    const scheduler = fakeScheduler();
    const send = vi.fn();
    const publisher = createTypingPublisher({ send, scheduler });
    publisher.stop();
    expect(send).not.toHaveBeenCalled();
    publisher.dispose();
    publisher.noteActivity(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('survives a failing transport', () => {
    const scheduler = fakeScheduler();
    const publisher = createTypingPublisher({
      send: () => Promise.reject(new Error('offline')),
      scheduler,
    });
    expect(() => publisher.noteActivity(true)).not.toThrow();
    expect(() => publisher.stop()).not.toThrow();
  });
});

describe('createTypingReceiver', () => {
  it('shows the indicator and expires it by itself when no refresh arrives', () => {
    const scheduler = fakeScheduler();
    const onChange = vi.fn();
    const receiver = createTypingReceiver({ onChange, scheduler, ttlMs: 7000 });

    receiver.receive(true);
    expect(onChange.mock.calls).toEqual([[true]]);

    scheduler.advance(4000);
    receiver.receive(true); // heartbeat from the sender
    scheduler.advance(4000); // 8 s after the first event, 4 s after the refresh
    expect(receiver.isTyping).toBe(true);

    scheduler.advance(3000);
    expect(receiver.isTyping).toBe(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('clears immediately on an explicit stop or when the message arrives', () => {
    const scheduler = fakeScheduler();
    const onChange = vi.fn();
    const receiver = createTypingReceiver({ onChange, scheduler });

    receiver.receive(true);
    receiver.receive(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);

    receiver.receive(true);
    receiver.clear();
    expect(onChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    scheduler.advance(60_000);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('does not report duplicate states', () => {
    const scheduler = fakeScheduler();
    const onChange = vi.fn();
    const receiver = createTypingReceiver({ onChange, scheduler });
    receiver.receive(true);
    receiver.receive(true);
    receiver.receive(false);
    receiver.receive(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });
});
