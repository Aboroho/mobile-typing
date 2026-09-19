import { parsePublicEnv } from '@mt/config';
import { useAccessStore } from '@/stores/access-store';
import { useChatStore } from '@/stores/chat-store';
import { endCallForPrivacyLock } from '@/stores/call-store';
import { useUiStore } from '@/stores/ui-store';

/**
 * Whether there is a typing game to hide behind. `NEXT_PUBLIC_*` values are
 * inlined at build time, so this is a static read.
 */
export const CHAT_HIDING_AVAILABLE = parsePublicEnv().NEXT_PUBLIC_ENABLE_TYPING_GAME;

export type HideChatReason =
  /** The "Hide" button in the chat header. */
  | 'hide-button'
  /** Double tap on the message area. */
  | 'double-tap'
  /** Legacy triple tap anywhere in the app. */
  | 'triple-tap'
  /** The page was hidden for longer than `CHAT_HIDDEN_LOCK_MS`. */
  | 'inactivity'
  /** The server reported the access session as expired or revoked. */
  | 'access-expired'
  /** Settings → "Lock now" / sign out. */
  | 'manual';

export interface ChatHiddenDetail {
  reason: HideChatReason;
  hiddenForMs?: number;
}

/** Fired on `window` after the chat was hidden, for screens that want to react. */
export const CHAT_HIDDEN_EVENT = 'mt:chat-hidden';

/**
 * Hides the chat and returns the app to the typing game — the one code path
 * behind the hide button, the double tap, the inactivity rule, access expiry
 * and the settings screen.
 *
 * Everything below is synchronous except the server call, so the chat is gone
 * from the screen in the same tick the gesture is recognised:
 *
 * 1. `privacy-locked` goes on `<html>` — CSS blurs any chat surface that may
 *    still be painted before React commits.
 * 2. Chat state is wiped: messages, conversations, live streams, typing
 *    indicators, pending receipts. Nothing private survives in memory.
 * 3. The access store flips to locked (the shell renders the game), an active
 *    call is ended with reason `privacy_lock`, and the server access session is
 *    revoked. `force` covers the case where this tab believes it is already
 *    locked but a stored "hidden since" stamp says the session must end anyway
 *    (see `useInactivityLock`).
 *
 * This is a *privacy* feature, not authorisation: every API route keeps
 * validating the httpOnly cookies regardless of what the client believes.
 */
export function hideChat(reason: HideChatReason, detail: { hiddenForMs?: number } = {}): void {
  // Without the game there is nothing to hide behind: the shell keeps showing
  // the chat, so the blur must not be applied (it would never be lifted).
  if (CHAT_HIDING_AVAILABLE) useUiStore.getState().setPrivacyLocked(true);
  // Streams close and the last "stopped typing" ping leaves before the revoke.
  useChatStore.getState().reset();
  // Local lock is synchronous inside `lock()`; the call is ended (bounded) with
  // the still-valid session, then the server session is revoked.
  void useAccessStore.getState().lock({
    silent: true,
    force: reason === 'inactivity',
    before: endCallForPrivacyLock,
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<ChatHiddenDetail>(CHAT_HIDDEN_EVENT, { detail: { reason, ...detail } }),
    );
  }
}
