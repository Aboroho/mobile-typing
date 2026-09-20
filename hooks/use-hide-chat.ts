'use client';

import { useCallback } from 'react';
import { disconnectAllStreams } from '@/stores/chat-store';
import { endCallForPrivacyLock } from '@/stores/call-store';
import { useAccessStore } from '@/stores/access-store';

/**
 * The single "hide the chat" action, shared by the header button, the
 * double-tap gesture and the 60-second visibility timeout so all three behave
 * identically.
 *
 * It does four things, in this order:
 *  1. drops every live subscription and clears ephemeral in-memory chat state
 *     (message streams, typing indicators, seen-event cache);
 *  2. ends any in-progress call so no microphone stays open behind the game;
 *  3. clears the client-side unlocked state **and** revokes the access session
 *     on the server, so reopening the chat needs the secret code and password
 *     again;
 *  4. runs the caller's navigation callback (the routed pages go back to `/`,
 *     the single-page shell simply re-renders the typing game).
 *
 * The user's *authentication* session is deliberately left intact: hiding the
 * chat is a privacy gesture, not a logout. The backend keeps protecting every
 * route regardless of what the browser is showing.
 */
export function useHideChat(options: { onHidden?: () => void } = {}): () => void {
  const { onHidden } = options;
  return useCallback(() => {
    disconnectAllStreams();
    void endCallForPrivacyLock();
    void useAccessStore.getState().lock({ silent: true });
    onHidden?.();
  }, [onHidden]);
}
