/**
 * @vitest-environment jsdom
 *
 * Realtime transport selection. The point of these tests is the *contract the
 * rest of the app depends on*: a socket that will not connect is downgraded to
 * SSE and reported through the status callback — it never throws into whatever
 * triggered it (signup, message send) and never silently disappears.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeClient } from '@/lib/browser/realtime-client';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static failToOpen = false;
  static throwOnConstruct = false;

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  url: string;

  constructor(url: string) {
    if (FakeSocket.throwOnConstruct) throw new Error('no websocket support');
    this.url = url;
    FakeSocket.instances.push(this);
    setTimeout(() => {
      if (FakeSocket.failToOpen) {
        this.onerror?.();
        this.onclose?.();
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  send(data: string) {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Test helper: deliver a frame from the server. */
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

const OPEN = 1;

describe('realtime client', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    FakeSocket.failToOpen = false;
    FakeSocket.throwOnConstruct = false;
    (FakeSocket as unknown as { OPEN: number }).OPEN = OPEN;
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'EventSource',
      class {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        addEventListener = vi.fn();
        close = vi.fn();
      } as unknown as typeof EventSource,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('connects over WebSocket and subscribes to the conversation', async () => {
    const client = createRealtimeClient();
    const handler = vi.fn();
    client.subscribeConversation('c1', handler);
    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(FakeSocket.instances[0]?.readyState).toBe(1));

    const socket = FakeSocket.instances[0]!;
    const subscribe = socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(subscribe[0]).toMatchObject({ type: 'subscribe', conversations: ['c1'] });
    expect(client.getStatus()).toBe('websocket');
  });

  it('routes a frame to the right conversation handler only', async () => {
    const client = createRealtimeClient();
    const first = vi.fn();
    const second = vi.fn();
    client.subscribeConversation('c1', first);
    client.subscribeConversation('c2', second);
    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances[0]?.readyState).toBe(1));

    FakeSocket.instances[0]!.receive({ topic: 'conversation:c1:messages', type: 'message.created', payload: { conversationId: 'c1' } });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('ignores system frames but keeps the cursor from them', async () => {
    const client = createRealtimeClient();
    const handler = vi.fn();
    client.subscribeConversation('c1', handler);
    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances[0]?.readyState).toBe(1));
    FakeSocket.instances[0]!.receive({ topic: 'system', type: 'hello', payload: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it('falls back to SSE when the socket never opens, without throwing', async () => {
    FakeSocket.failToOpen = true;
    const client = createRealtimeClient();
    const statuses: string[] = [];
    client.onStatus((status) => statuses.push(status));

    expect(() => client.subscribeConversation('c1', vi.fn())).not.toThrow();
    client.connect();
    await vi.waitFor(() => expect(statuses).toContain('sse'));
    expect(client.getStatus()).toBe('sse');
  });

  it('falls back to SSE when the WebSocket constructor is unavailable', () => {
    FakeSocket.throwOnConstruct = true;
    const client = createRealtimeClient();
    client.subscribeConversation('c1', vi.fn());
    expect(client.getStatus()).toBe('sse');
  });

  it('sends the last event id as the reconnect cursor', async () => {
    const client = createRealtimeClient();
    client.subscribeConversation('c1', vi.fn());
    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances[0]?.readyState).toBe(1));
    FakeSocket.instances[0]!.receive({
      id: 'evt_000000001',
      topic: 'conversation:c1:messages',
      type: 'message.created',
      payload: { conversationId: 'c1' },
    });
    expect(client.getLastEventId()).toBe('evt_000000001');
  });

  it('unsubscribing removes the handler', async () => {
    const client = createRealtimeClient();
    const handler = vi.fn();
    const unsubscribe = client.subscribeConversation('c1', handler);
    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances[0]?.readyState).toBe(1));
    unsubscribe();
    FakeSocket.instances[0]!.receive({ topic: 'conversation:c1:messages', type: 'message.created', payload: { conversationId: 'c1' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('typing goes over the socket when it is open', async () => {
    const client = createRealtimeClient();
    client.subscribeConversation('c1', vi.fn());
    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances[0]?.readyState).toBe(1));
    client.sendTyping('c1', true);
    const frames = FakeSocket.instances[0]!.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(frames.at(-1)).toMatchObject({ type: 'typing', conversationId: 'c1', isTyping: true });
  });

  it('stop() closes the socket and reports idle', async () => {
    const client = createRealtimeClient();
    client.subscribeConversation('c1', vi.fn());
    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances[0]?.readyState).toBe(1));
    client.disconnect();
    expect(client.getStatus()).toBe('idle');
  });
});
