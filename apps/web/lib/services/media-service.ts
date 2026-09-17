import { AppError, resolveViewOnceRequest, storagePathFor, validateUpload } from '@mt/domain';
import type { Media, MediaForAdmin } from '@mt/types';
import { IMAGE_MAX_BYTES, VOICE_MAX_BYTES } from '@mt/types';
import { newId, nowIso, sha256HexBytes } from '@mt/utils';
import type { MediaViewResult, UploadIntentResponse, UploadResult } from '@mt/api-client';
import { getData, type UserRecord } from '../data';
import { getStorage } from '../storage';
import { publish, topics } from '../realtime/bus';
import { logger } from '../logger';
import { requireParticipant } from './conversation-service';
import { otherParticipant } from '@mt/domain';
import { sendMessage } from './message-service';
import { writeAuditLog } from '../security/audit';
import type { SendMessageResponse } from '@mt/api-client';

const SIGNED_URL_TTL_SECONDS = 60;

export async function createUploadIntent(input: {
  actor: UserRecord;
  kind: 'image' | 'voice';
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  width?: number;
  height?: number;
}): Promise<UploadIntentResponse> {
  const data = await getData();
  const maxBytes = input.kind === 'image' ? IMAGE_MAX_BYTES : VOICE_MAX_BYTES;
  if (input.sizeBytes > maxBytes) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'file is too large', {
      context: { maxBytes, sizeBytes: input.sizeBytes },
    });
  }
  if (input.kind === 'voice' && input.durationMs !== undefined && input.durationMs < 500) {
    throw new AppError('BAD_REQUEST', 'recording is too short');
  }

  const now = nowIso();
  const mediaId = newId('media');
  const media: Media = {
    id: mediaId,
    ownerId: input.actor.id,
    conversationId: null,
    messageId: null,
    kind: input.kind,
    // Filled in once the bytes arrive and the real MIME type is sniffed.
    storagePath: `media/${input.actor.id}/drafts/${mediaId}.pending`,
    mimeType: input.mimeType,
    sizeBytes: 0,
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: input.durationMs ?? null,
    checksum: '',
    viewOnce: false,
    viewOnceState: null,
    viewedAt: null,
    viewedBy: null,
    deleted: false,
    deletedAt: null,
    deletedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  await data.media.create(media);

  return {
    mediaId,
    storagePath: media.storagePath,
    uploadUrl: `/api/v1/media/${mediaId}/upload`,
    maxBytes,
    mimeType: input.mimeType,
  };
}

/**
 * Receives the bytes, sniffs the real content type (the client declaration is
 * never trusted) and writes the object to private storage.
 */
export async function completeUpload(input: {
  actor: UserRecord;
  mediaId: string;
  bytes: Uint8Array;
  declaredMimeType: string;
}): Promise<UploadResult> {
  const data = await getData();
  const media = await data.media.getById(input.mediaId);
  if (!media) throw AppError.notFound('upload not found');
  if (media.ownerId !== input.actor.id) throw AppError.forbidden('that upload belongs to someone else');

  const validation = validateUpload({
    kind: media.kind,
    declaredMime: input.declaredMimeType,
    bytes: input.bytes,
  });
  const checksum = await sha256HexBytes(input.bytes);
  const storagePath = storagePathFor({
    ownerId: input.actor.id,
    conversationId: media.conversationId,
    mediaId: media.id,
    mimeType: validation.mimeType,
  });
  const storage = getStorage();
  await storage.put(storagePath, input.bytes, validation.mimeType);

  const updated = await data.media.update(media.id, {
    storagePath,
    mimeType: validation.mimeType,
    sizeBytes: validation.sizeBytes,
    checksum,
  });
  logger.info('media.uploaded', { mediaId: media.id, kind: media.kind, sizeBytes: validation.sizeBytes });

  return {
    mediaId: media.id,
    sizeBytes: validation.sizeBytes,
    mimeType: validation.mimeType,
    width: updated?.width ?? media.width,
    height: updated?.height ?? media.height,
    durationMs: updated?.durationMs ?? media.durationMs,
  };
}

export async function sendMediaMessage(input: {
  actor: UserRecord;
  conversationId: string;
  mediaId: string;
  type: 'image' | 'voice';
  caption?: string;
  clientMessageId: string;
  viewOnce?: boolean;
}): Promise<SendMessageResponse> {
  const data = await getData();
  const media = await data.media.getById(input.mediaId);
  if (!media) throw AppError.notFound('upload not found');
  if (media.sizeBytes === 0) {
    throw new AppError('PRECONDITION_FAILED', 'the upload has not finished yet');
  }
  return sendMessage({
    actor: input.actor,
    conversationId: input.conversationId,
    type: input.type,
    text: input.caption,
    mediaId: input.mediaId,
    viewOnce: input.viewOnce,
    clientMessageId: input.clientMessageId,
  });
}

/**
 * One-time view. The state transition is atomic in the persistence layer, so two
 * simultaneous taps cannot both open the image. The recipient then fetches the
 * bytes once from the content route, which flips `viewing` → `viewed`.
 */
export async function openViewOnce(input: {
  actor: UserRecord;
  mediaId: string;
}): Promise<MediaViewResult> {
  const data = await getData();
  const media = await data.media.getById(input.mediaId);
  if (!media) throw AppError.notFound('media not found');
  const conversation = media.conversationId
    ? await requireParticipant(media.conversationId, input.actor.id)
    : null;

  const decision = resolveViewOnceRequest({
    media,
    viewerId: input.actor.id,
    // Only the recipient — the participant who is *not* the owner of the media —
    // may open it, even though the route already proved the caller belongs to
    // the conversation. Without this a third participant (or the sender) could
    // consume the single view.
    allowedViewerId: conversation ? otherParticipant(conversation, media.ownerId) : undefined,
  });
  if (!decision.allowed) {
    throw new AppError('PRECONDITION_FAILED', decision.reason ?? 'this photo is no longer available');
  }

  const claim = await data.media.claimViewOnce(input.mediaId, input.actor.id);
  if (!claim.claimed) {
    throw new AppError('PRECONDITION_FAILED', 'this photo has already been opened');
  }

  if (media.conversationId) {
    publish(topics.messages(media.conversationId), 'media.viewed', {
      conversationId: media.conversationId,
      mediaId: media.id,
      viewerId: input.actor.id,
    });
  }

  return {
    mediaId: media.id,
    contentUrl: `/api/v1/media/${media.id}/content`,
    ttlSeconds: SIGNED_URL_TTL_SECONDS,
    mimeType: media.mimeType,
  };
}

export interface MediaContent {
  contentType: string;
  bytes: Uint8Array | null;
  redirectUrl: string | null;
  cacheControl: string;
}

/**
 * Authorised media retrieval. Ordinary users get the bytes only when the rules
 * allow it; administrators get an audit entry for every access, including to
 * soft deleted content.
 */
export async function fetchMediaContent(input: {
  viewer: UserRecord;
  mediaId: string;
  isAdminRequest: boolean;
  ipAddress?: string | null;
}): Promise<MediaContent> {
  const data = await getData();
  const media = await data.media.getById(input.mediaId);
  if (!media) throw AppError.notFound('media not found');

  if (input.isAdminRequest) {
    if (media.conversationId) {
      await requireParticipant(media.conversationId, input.viewer.id).catch(() => undefined);
    }
    await writeAuditLog({
      actor: { id: input.viewer.id, email: input.viewer.email },
      action: 'admin.media.downloaded',
      targetType: 'media',
      targetId: media.id,
      ipAddress: input.ipAddress ?? null,
      metadata: { deleted: media.deleted, viewOnce: media.viewOnce, kind: media.kind },
    });
  } else {
    if (media.conversationId) await requireParticipant(media.conversationId, input.viewer.id);
    if (media.deleted) throw AppError.notFound('media not available');
    if (media.viewOnce && media.ownerId !== input.viewer.id) {
      // Only the single, claimed read is served — and it consumes the claim.
      if (media.viewOnceState !== 'viewing') {
        throw new AppError('PRECONDITION_FAILED', 'this photo is no longer available');
      }
      await data.media.markViewed(media.id, input.viewer.id);
    }
  }

  const storage = getStorage();
  const signedUrl = await storage.createSignedUrl(media.storagePath, SIGNED_URL_TTL_SECONDS, media.mimeType);
  if (signedUrl) {
    return { contentType: media.mimeType, bytes: null, redirectUrl: signedUrl, cacheControl: 'private, no-store' };
  }
  const object = await storage.get(media.storagePath);
  if (!object) throw AppError.notFound('media bytes are missing');
  return {
    contentType: media.mimeType,
    bytes: object.bytes,
    redirectUrl: null,
    // Never cache user media: a shared device must not keep it around.
    cacheControl: 'private, no-store, must-revalidate',
  };
}

export async function softDeleteMedia(input: {
  actor: UserRecord;
  mediaId: string;
  reason?: string;
}): Promise<void> {
  const data = await getData();
  const media = await data.media.getById(input.mediaId);
  if (!media) throw AppError.notFound('media not found');
  if (media.ownerId !== input.actor.id) throw AppError.forbidden('you can only delete your own media');
  const now = nowIso();
  await data.media.update(media.id, {
    deleted: true,
    deletedAt: now,
    deletedBy: input.actor.id,
    viewOnceState: media.viewOnce ? 'deleted' : media.viewOnceState,
  });
  logger.info('media.deleted', { mediaId: media.id });
  void input.reason;
}

export async function markMediaViewed(input: { actor: UserRecord; mediaId: string }): Promise<void> {
  const data = await getData();
  const media = await data.media.getById(input.mediaId);
  if (!media) throw AppError.notFound('media not found');
  if (media.ownerId === input.actor.id) return;
  await data.media.markViewed(media.id, input.actor.id);
  if (media.conversationId) {
    publish(topics.messages(media.conversationId), 'media.viewed', {
      conversationId: media.conversationId,
      mediaId: media.id,
      viewerId: input.actor.id,
    });
  }
}

export async function getMediaRecord(input: {
  viewer: UserRecord;
  mediaId: string;
  isAdminRequest: boolean;
}): Promise<MediaForAdmin> {
  const data = await getData();
  const media = await data.media.getById(input.mediaId);
  if (!media) throw AppError.notFound('media not found');
  if (!input.isAdminRequest && media.conversationId) {
    await requireParticipant(media.conversationId, input.viewer.id);
  }
  return { ...media, messageSender: null, conversationParticipants: [] };
}

