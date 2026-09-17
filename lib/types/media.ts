import type { EntityTimestamps, Timestamp } from './common';

export const MediaKind = {
  Image: 'image',
  Voice: 'voice',
} as const;
export type MediaKind = (typeof MediaKind)[keyof typeof MediaKind];

export const ViewOnceState = {
  Sent: 'sent',
  Delivered: 'delivered',
  Viewable: 'viewable',
  Viewing: 'viewing',
  Viewed: 'viewed',
  Expired: 'expired',
  Deleted: 'deleted',
} as const;
export type ViewOnceState = (typeof ViewOnceState)[keyof typeof ViewOnceState];

export interface Media extends EntityTimestamps {
  id: string;
  ownerId: string;
  conversationId: string | null;
  messageId: string | null;
  kind: MediaKind;
  storagePath: string;
  mimeType: string;
  /** Bytes on the storage backend. */
  sizeBytes: number;
  width: number | null;
  height: number | null;
  /** Milliseconds, only for voice messages. */
  durationMs: number | null;
  /** SHA-256 of the bytes, used for integrity + duplicate detection. */
  checksum: string;
  viewOnce: boolean;
  viewOnceState: ViewOnceState | null;
  viewedAt: Timestamp | null;
  viewedBy: string | null;
  deleted: boolean;
  deletedAt: Timestamp | null;
  deletedBy: string | null;
}

/** Attachment as embedded in a message and shown to participants. */
export interface MediaView {
  mediaId: string;
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  viewOnce: boolean;
  viewOnceState: ViewOnceState | null;
  /** True when the current viewer is allowed to fetch the bytes right now. */
  canView: boolean;
  /** Route relative URL, only present when `canView` is true. */
  contentUrl: string | null;
  /** Short lived signed URL for storage backends that support it. */
  signedUrl: string | null;
  deleted: boolean;
}

export interface MediaContentResult {
  mediaId: string;
  contentType: string;
  sizeBytes: number;
  /** Signed URL when the backend supports one, otherwise inline bytes. */
  signedUrl: string | null;
  bytes: Uint8Array | null;
  /** Seconds the client may cache/keep the resource. */
  maxAgeSeconds: number;
  viewOnceConsumed: boolean;
}

export interface MediaForAdmin extends Media {
  messageSender: { id: string; name: string } | null;
  conversationParticipants: string[];
}
