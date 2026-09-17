import { beforeEach, describe, expect, it } from 'vitest';
import { resetStore } from '@/lib/data/memory';
import { POST as createConversationRoute } from '@/app/api/v1/conversations/route';
import { POST as uploadIntentRoute } from '@/app/api/v1/media/upload-intent/route';
import { POST as uploadRoute } from '@/app/api/v1/media/[mediaId]/upload/route';
import { POST as sendMediaRoute } from '@/app/api/v1/media/messages/route';
import { POST as viewRoute } from '@/app/api/v1/media/[mediaId]/view/route';
import { POST as viewedRoute } from '@/app/api/v1/media/[mediaId]/viewed/route';
import { GET as contentRoute } from '@/app/api/v1/media/[mediaId]/content/route';
import { call, jsonRequest, queryRequest, registerUser, type TestUser } from '../helpers/api';

/** Smallest plausible JPEG: the magic bytes the server sniffs, plus padding. */
function jpegBytes(size = 512): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  bytes[size - 2] = 0xff;
  bytes[size - 1] = 0xd9;
  return bytes;
}

let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let conversationId: string;

beforeEach(async () => {
  resetStore();
  alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
  bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
  carol = await registerUser({ name: 'Carol', email: 'carol@example.com' });
  const created = await call<{ conversation: { conversation: { id: string } } }>(
    createConversationRoute,
    jsonRequest('POST', '/api/v1/conversations', { participantId: bob.id }, alice.jar),
  );
  conversationId = created.body.data!.conversation.conversation.id;
});

async function uploadImage(actor: TestUser): Promise<string> {
  const bytes = jpegBytes();
  const intent = await call<{ mediaId: string }>(
    uploadIntentRoute,
    jsonRequest('POST', '/api/v1/media/upload-intent', { kind: 'image', mimeType: 'image/jpeg', sizeBytes: bytes.byteLength }, actor.jar),
  );
  if (!intent.body.data) throw new Error(`intent failed: ${JSON.stringify(intent.body)}`);
  const mediaId = intent.body.data.mediaId;

  const form = new FormData();
  form.set('file', new File([bytes as unknown as BlobPart], 'photo.jpg', { type: 'image/jpeg' }));
  const response = await uploadRoute(
    new Request(`http://localhost:3000/api/v1/media/${mediaId}/upload`, {
      method: 'POST',
      headers: { Cookie: actor.jar.header() },
      body: form,
    }),
    { params: { mediaId } },
  );
  const body = (await response.json()) as { ok: boolean; error?: { message: string } };
  if (!body.ok) throw new Error(`upload failed: ${body.error?.message}`);
  return mediaId;
}

async function sendPhoto(actor: TestUser, mediaId: string, viewOnce: boolean): Promise<string> {
  const result = await call<{ message: { id: string } }>(
    sendMediaRoute,
    jsonRequest(
      'POST',
      '/api/v1/media/messages',
      { conversationId, mediaId, type: 'image', clientMessageId: `cm-${Math.random().toString(36).slice(2)}`, viewOnce },
      actor.jar,
    ),
  );
  if (!result.body.data) throw new Error(`send media failed: ${JSON.stringify(result.body)}`);
  return result.body.data.message.id;
}

describe('image uploads', () => {
  it('rejects a file whose bytes are not an image, whatever the client claims', async () => {
    const intent = await call<{ mediaId: string }>(
      uploadIntentRoute,
      jsonRequest('POST', '/api/v1/media/upload-intent', { kind: 'image', mimeType: 'image/png', sizeBytes: 64 }, alice.jar),
    );
    const mediaId = intent.body.data!.mediaId;
    const form = new FormData();
    form.set('file', new File([new Uint8Array(64) as unknown as BlobPart], 'evil.png', { type: 'image/png' }));
    const response = await uploadRoute(
      new Request(`http://localhost:3000/api/v1/media/${mediaId}/upload`, {
        method: 'POST',
        headers: { Cookie: alice.jar.header() },
        body: form,
      }),
      { params: { mediaId } },
    );
    const body = (await response.json()) as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('serves the bytes only through the authorised route', async () => {
    const mediaId = await uploadImage(alice);
    await sendPhoto(alice, mediaId, false);

    const forRecipient = await contentRoute(
      queryRequest('GET', `/api/v1/media/${mediaId}/content`, undefined, bob.jar),
      { params: { mediaId } },
    );
    expect(forRecipient.status).toBe(200);
    expect(forRecipient.headers.get('content-type')).toBe('image/jpeg');
    expect(forRecipient.headers.get('cache-control')).toContain('no-store');

    const forStranger = await call(
      contentRoute,
      queryRequest('GET', `/api/v1/media/${mediaId}/content`, undefined, carol.jar),
      { mediaId },
    );
    expect(forStranger.status).toBeGreaterThanOrEqual(400);
  });
});

describe('view-once photos', () => {
  it('opens exactly once and then serves the bytes exactly once', async () => {
    const mediaId = await uploadImage(alice);
    await sendPhoto(alice, mediaId, true);

    const firstOpen = await call(viewRoute, jsonRequest('POST', `/api/v1/media/${mediaId}/view`, {}, bob.jar), { mediaId });
    expect(firstOpen.status).toBe(200);

    const secondOpen = await call(viewRoute, jsonRequest('POST', `/api/v1/media/${mediaId}/view`, {}, bob.jar), { mediaId });
    expect(secondOpen.status).toBe(412);
    expect(secondOpen.body.error?.message).toMatch(/already been opened|not available/);

    const firstFetch = await contentRoute(queryRequest('GET', `/api/v1/media/${mediaId}/content`, undefined, bob.jar), { params: { mediaId } });
    expect(firstFetch.status).toBe(200);
    expect((await firstFetch.arrayBuffer()).byteLength).toBe(512);

    const secondFetch = await call(
      contentRoute,
      queryRequest('GET', `/api/v1/media/${mediaId}/content`, undefined, bob.jar),
      { mediaId },
    );
    expect(secondFetch.status).toBeGreaterThanOrEqual(400);
  });

  it('cannot be opened by the sender or a third party', async () => {
    const mediaId = await uploadImage(alice);
    await sendPhoto(alice, mediaId, true);

    const bySender = await call(viewRoute, jsonRequest('POST', `/api/v1/media/${mediaId}/view`, {}, alice.jar), { mediaId });
    expect(bySender.status).toBe(412);

    const byStranger = await call(viewRoute, jsonRequest('POST', `/api/v1/media/${mediaId}/view`, {}, carol.jar), { mediaId });
    expect(byStranger.status).toBeGreaterThanOrEqual(400);
  });

  it('survives two simultaneous taps: only one claim wins', async () => {
    const mediaId = await uploadImage(alice);
    await sendPhoto(alice, mediaId, true);

    const results = await Promise.all([
      call(viewRoute, jsonRequest('POST', `/api/v1/media/${mediaId}/view`, {}, bob.jar), { mediaId }),
      call(viewRoute, jsonRequest('POST', `/api/v1/media/${mediaId}/view`, {}, bob.jar), { mediaId }),
    ]);
    const succeeded = results.filter((result) => result.status === 200).length;
    expect(succeeded).toBe(1);
  });

  it('records the view so the sender is notified', async () => {
    const mediaId = await uploadImage(alice);
    await sendPhoto(alice, mediaId, true);
    await call(viewRoute, jsonRequest('POST', `/api/v1/media/${mediaId}/view`, {}, bob.jar), { mediaId });
    const ack = await call(viewedRoute, jsonRequest('POST', `/api/v1/media/${mediaId}/viewed`, { mediaId }, bob.jar), { mediaId });
    expect(ack.status).toBe(200);

    const { getData } = await import('@/lib/data');
    const data = await getData();
    const stored = await data.media.getById(mediaId);
    expect(stored?.viewOnceState).toBe('viewed');
    expect(stored?.viewedAt).not.toBeNull();
  });
});
