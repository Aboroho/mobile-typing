import type { Media, MediaView } from '@mt/types';

/**
 * Builds the attachment view embedded in a message.
 *
 * `canView` is advisory UI state — the content route re-checks every rule
 * server side. Rules:
 *  - soft deleted media is never viewable by ordinary users;
 *  - regular media is viewable by both participants;
 *  - view-once media is viewable by its owner, and by the recipient only while
 *    the one-shot claim is open (`viewing`), which happens through
 *    `POST /api/v1/media/{id}/view`.
 */
export function buildMediaView(media: Media | null, viewerId: string): MediaView | null {
  if (!media) return null;
  const isOwner = media.ownerId === viewerId;
  const viewable = !media.deleted && (!media.viewOnce || isOwner || media.viewOnceState === 'viewing');
  return {
    mediaId: media.id,
    kind: media.kind,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    width: media.width,
    height: media.height,
    durationMs: media.durationMs,
    viewOnce: media.viewOnce,
    viewOnceState: media.viewOnceState,
    canView: viewable,
    contentUrl: viewable ? `/api/v1/media/${media.id}/content` : null,
    signedUrl: null,
    deleted: media.deleted,
  };
}
