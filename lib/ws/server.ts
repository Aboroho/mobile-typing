/**
 * Authenticated WebSocket server for realtime chat events.
 *
 * Bootstrapped by the standalone server (server.ts) via tsx or bundled at
 * build time. Verifies mt_session cookies against the argon2 session service,
 * tracks connections per user, subscribes to the in-process event bus for
 * conversations the client joins, and replays OutboxEvents after reconnect.
 *
 * WebSocket is transport only — PostgreSQL is the source of truth.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import { verifySession } from '../auth/session';
import { logger } from '../logger';
import { subscribe, topics } from '../realtime/bus';
import { getData } from '../data';

export interface WireEvent {
  id?: string;
  topic: string;
  type: string;
  payload: unknown;
  at: string;
}

interface Client {
  ws: WebSocket;
  userId: string;
  subscriptions: Set<string>;
  lastEventId: string | null;
  isAlive: boolean;
  ip: string | null;
}

const HEARTBEAT_MS = 30_000;

export interface KeypadWSServer {
  handleUpgrade(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void;
  clientsFor(userId: string): number;
  close(): Promise<void>;
}

export function createKeypadWSServer(options: { path?: string } = {}): KeypadWSServer {
  const path = options.path ?? '/api/v1/ws';
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<Client>();
  const unsubs = new Map<Client, Array<() => void>>();

  function send(c: Client, evt: WireEvent): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    try { c.ws.send(JSON.stringify(evt)); }
    catch (err) { logger.warn('ws.send_failed', { error: String(err), userId: c.userId }); }
  }

  function attach(c: Client): void {
    clients.add(c);
    addUserTopics(c);
    logger.info('ws.connected', { userId: c.userId, total: clients.size });
  }

  function detach(c: Client): void {
    if (!clients.has(c)) return;
    clients.delete(c);
    for (const u of unsubs.get(c) ?? []) u();
    unsubs.delete(c);
    try { c.ws.close(); } catch { /* ignore */ }
    logger.info('ws.disconnected', { userId: c.userId, total: clients.size });
  }

  function addUserTopics(c: Client): void {
    const current = unsubs.get(c) ?? [];
    for (const u of current) u();
    const fresh: Array<() => void> = [
      subscribe(topics.userCalls(c.userId), (evt) => send(c, evt)),
      subscribe(`user:${c.userId}:access`, (evt) => send(c, evt)),
    ];
    unsubs.set(c, fresh);
    c.subscriptions = new Set();
  }

  async function subscribeConversations(c: Client, conversationIds: string[]): Promise<void> {
    const current = unsubs.get(c) ?? [];
    for (const u of current) u();
    const fresh: Array<() => void> = [
      subscribe(topics.userCalls(c.userId), (evt) => send(c, evt)),
      subscribe(`user:${c.userId}:access`, (evt) => send(c, evt)),
    ];
    c.subscriptions = new Set();
    for (const cid of conversationIds) {
      c.subscriptions.add(cid);
      fresh.push(subscribe(topics.messages(cid), (evt) => send(c, evt)));
      fresh.push(subscribe(topics.conversation(cid), (evt) => send(c, evt)));
      fresh.push(subscribe(topics.typing(cid), (evt) => send(c, evt)));
      fresh.push(subscribe(topics.call(cid), (evt) => send(c, evt)));
    }
    unsubs.set(c, fresh);
  }

  async function catchUp(c: Client): Promise<void> {
    const data = await getData();
    const outbox = (data as unknown as { outbox?: { listForUser(userId: string, afterId: string | null, limit: number): Promise<WireEvent[]> } }).outbox;
    if (!outbox) return;
    const events = await outbox.listForUser(c.userId, c.lastEventId, 200);
    for (const evt of events) {
      send(c, evt);
      if (evt.id) c.lastEventId = evt.id;
    }
  }

  async function onMessage(c: Client, raw: string): Promise<void> {
    let msg: { type: string; conversations?: string[]; since?: string };
    try { msg = JSON.parse(raw) as typeof msg; }
    catch { send(c, { topic: 'system', type: 'error', payload: { code: 'BAD_FRAME' }, at: new Date().toISOString() }); return; }
    if (msg.type === 'subscribe' && Array.isArray(msg.conversations)) {
      if (typeof msg.since === 'string') c.lastEventId = msg.since;
      await subscribeConversations(c, msg.conversations);
      await catchUp(c);
      send(c, { topic: 'system', type: 'subscribed', payload: { conversations: Array.from(c.subscriptions) }, at: new Date().toISOString() });
    } else if (msg.type === 'ping') {
      send(c, { topic: 'system', type: 'pong', payload: { at: Date.now() }, at: new Date().toISOString() });
    }
  }

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, client: Client) => {
    ws.on('message', (buf) => { void onMessage(client, buf.toString('utf8')); });
    ws.on('close', () => detach(client));
    ws.on('pong', () => { client.isAlive = true; });
    ws.on('error', () => detach(client));
    attach(client);
    send(client, {
      topic: 'system', type: 'hello',
      payload: { userId: client.userId, serverTime: new Date().toISOString() },
      at: new Date().toISOString(),
    });
  });

  async function authenticate(req: IncomingMessage): Promise<Client | null> {
    try {
      const verified = await verifySession(req as unknown as Request);
      if (!verified) return null;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ?? (req.socket as { remoteAddress?: string }).remoteAddress ?? null;
      return {
        ws: null as unknown as WebSocket, userId: verified.uid, subscriptions: new Set(),
        lastEventId: url.searchParams.get('since'), isAlive: true, ip,
      };
    } catch (err) {
      logger.warn('ws.auth_failed', { error: String(err) });
      return null;
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) { socket.destroy(); return; }
    authenticate(req).then((client) => {
      if (!client) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        client.ws = ws;
        wss.emit('connection', ws, req, client);
      });
    }).catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n'); socket.destroy();
    });
  }

  const heartbeat = setInterval(() => {
    for (const c of Array.from(clients)) {
      if (!c.isAlive) { detach(c); continue; }
      c.isAlive = false;
      try { c.ws.ping(); } catch { detach(c); }
    }
  }, HEARTBEAT_MS);

  return {
    handleUpgrade,
    clientsFor(userId: string) { let n = 0; for (const c of clients) if (c.userId === userId) n++; return n; },
    async close() {
      clearInterval(heartbeat);
      for (const c of Array.from(clients)) detach(c);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
