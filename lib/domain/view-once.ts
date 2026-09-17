import { ViewOnceState, type Media } from '@mt/types';

/**
 * One-time-view state machine.
 *
 * `viewable -> viewing -> viewed` is the only path to consuming an image, and
 * the persistence layer performs the `viewable -> viewing` step inside a
 * transaction so two concurrent taps cannot both succeed. `viewing` also acts
 * as a crash guard: a client that opened the image but never confirmed leaves
 * it unrecoverable rather than re-openable.
 */
export type ViewOnceEvent = 'deliver' | 'request' | 'opened' | 'expire' | 'delete';

const TRANSITIONS: Record<ViewOnceState, Partial<Record<ViewOnceEvent, ViewOnceState>>> = {
  [ViewOnceState.Sent]: {
    deliver: ViewOnceState.Delivered,
    delete: ViewOnceState.Deleted,
  },
  [ViewOnceState.Delivered]: {
    request: ViewOnceState.Viewable,
    delete: ViewOnceState.Deleted,
  },
  [ViewOnceState.Viewable]: {
    request: ViewOnceState.Viewing,
    expire: ViewOnceState.Expired,
    delete: ViewOnceState.Deleted,
  },
  [ViewOnceState.Viewing]: {
    opened: ViewOnceState.Viewed,
    expire: ViewOnceState.Expired,
    delete: ViewOnceState.Deleted,
  },
  [ViewOnceState.Viewed]: { delete: ViewOnceState.Deleted },
  [ViewOnceState.Expired]: { delete: ViewOnceState.Deleted },
  [ViewOnceState.Deleted]: {},
};

export function transitionViewOnce(
  current: ViewOnceState | null,
  event: ViewOnceEvent,
): ViewOnceState | null {
  if (current === null) return null;
  return TRANSITIONS[current][event] ?? null;
}

export function isTerminalViewOnceState(state: ViewOnceState | null): boolean {
  return (
    state === ViewOnceState.Viewed || state === ViewOnceState.Expired || state === ViewOnceState.Deleted
  );
}

export function canRequestViewOnce(state: ViewOnceState | null): boolean {
  return state === ViewOnceState.Delivered || state === ViewOnceState.Viewable;
}

/**
 * Whether the recipient may fetch the bytes right now. Only the transient
 * `viewing` state grants access, immediately after the atomic claim.
 */
export function canFetchViewOnceBytes(state: ViewOnceState | null): boolean {
  return state === ViewOnceState.Viewing;
}

export interface ViewOnceDecision {
  allowed: boolean;
  reason: string | null;
  nextState: ViewOnceState | null;
}

/**
 * Authorisation + transition in one pure function so the persistence layer only
 * has to wrap it in a transaction. `viewerId` must be the recipient: the sender
 * never consumes their own view-once media.
 */
export function resolveViewOnceRequest(options: {
  media: Pick<Media, 'viewOnce' | 'viewOnceState' | 'ownerId' | 'deleted'>;
  viewerId: string;
  /**
   * The only user entitled to open this media — the recipient of the
   * conversation it belongs to. Callers must pass it: a request from anyone
   * else is refused here rather than relying on the caller having checked
   * membership first.
   */
  allowedViewerId?: string;
  isAdmin?: boolean;
}): ViewOnceDecision {
  const { media, viewerId } = options;
  if (options.allowedViewerId !== undefined && viewerId !== options.allowedViewerId && !options.isAdmin) {
    return { allowed: false, reason: 'you are not the recipient of this photo', nextState: null };
  }
  if (media.deleted && !options.isAdmin) {
    return { allowed: false, reason: 'this media was deleted', nextState: null };
  }
  if (!media.viewOnce) {
    // Regular media is fetched through the plain content route.
    return { allowed: false, reason: 'media is not view-once', nextState: null };
  }
  if (media.ownerId === viewerId && !options.isAdmin) {
    return { allowed: false, reason: 'the sender cannot open their own view-once media', nextState: null };
  }
  if (isTerminalViewOnceState(media.viewOnceState)) {
    return { allowed: false, reason: 'this photo has already been viewed', nextState: null };
  }
  const nextState = transitionViewOnce(media.viewOnceState, 'request');
  if (nextState === null) {
    return { allowed: false, reason: 'this photo is not available', nextState: null };
  }
  return { allowed: true, reason: null, nextState };
}
