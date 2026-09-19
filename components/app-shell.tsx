'use client';

import { useCallback, useEffect, useState } from 'react';
import { parsePublicEnv } from '@mt/config';
import { useAccessStore } from '@/stores/access-store';
import { useAuthStore } from '@/stores/auth-store';
import { useUiStore } from '@/stores/ui-store';
import { hideChat } from '@/lib/client/privacy-lock';
import { useKeystrokeUnlock } from '@/hooks/use-keystroke-unlock';
import { useTripleTap } from '@/hooks/use-triple-tap';
import { useInactivityLock } from '@/hooks/use-inactivity-lock';
import { TypingGameScreen } from '@/components/typing-game/typing-game-screen';
import { AuthPanel } from '@/components/auth/auth-panel';
import { ConversationList } from '@/components/conversations/conversation-list';
import { ChatScreen } from '@/components/messages/chat-screen';

/**
 * `NEXT_PUBLIC_ENABLE_TYPING_GAME=false` skips the typing-game disguise and
 * the secret-code gate entirely: visitors land directly on sign-in, then
 * chat. `NEXT_PUBLIC_*` values are inlined at build time, so this is a static
 * read, not a live fetch.
 */
const GAME_ENABLED = parsePublicEnv().NEXT_PUBLIC_ENABLE_TYPING_GAME;

/**
 * The single gate every visitor passes through.
 *
 * Order of checks (when the game is enabled): access session (typing game +
 * secret code) → authentication → chat. Nothing about the messaging app is
 * rendered, routed or hinted at until all three are satisfied. When the game
 * is disabled, the access-session gate is skipped and visitors go straight to
 * authentication → chat.
 *
 * Hiding the chat (hide button, double tap, triple tap, 60 s hidden, access
 * expiry) goes through `hideChat()`, which flips `unlocked` to false in the same
 * tick — the typing game is what renders next, never an intermediate screen.
 */
export function AppShell() {
  const challenge = useAccessStore((state) => state.challenge);
  const unlocked = useAccessStore((state) => state.unlocked) || !GAME_ENABLED;
  const boundUserId = useAccessStore((state) => state.boundUserId);
  const startChallenge = useAccessStore((state) => state.startChallenge);
  const setPrivacyLocked = useUiStore((state) => state.setPrivacyLocked);
  const user = useAuthStore((state) => state.user);
  const initializing = useAuthStore((state) => state.initializing);
  const [conversationId, setConversationId] = useState<string | null>(null);

  useKeystrokeUnlock(GAME_ENABLED && !unlocked ? challenge : null);
  // Hidden (tab/app in background, screen off) for more than 60 s → back to the
  // game. Losing focus alone never locks; see the hook for the full rule.
  useInactivityLock(GAME_ENABLED);

  const handleTripleTap = useCallback(() => {
    if (!unlocked) return;
    hideChat('triple-tap');
  }, [unlocked]);
  // Triple tap only matters once the chat is reachable, and only makes sense
  // when there is a game/lock screen to return to.
  useTripleTap(handleTripleTap, GAME_ENABLED && unlocked);

  // The challenge is fetched on first paint so the detector is armed immediately.
  useEffect(() => {
    if (GAME_ENABLED && !challenge && !unlocked) void startChallenge();
  }, [challenge, unlocked, startChallenge]);

  // Re-arm after a lock so the next attempt works without a reload.
  useEffect(() => {
    if (GAME_ENABLED && !unlocked && !challenge) void startChallenge();
  }, [unlocked, challenge, startChallenge]);

  // After a lock the next unlock starts from the conversation list, and the
  // blur class set by `hideChat()` is lifted once the chat is reachable again.
  useEffect(() => {
    if (!unlocked) setConversationId(null);
    else setPrivacyLocked(false);
  }, [unlocked, setPrivacyLocked]);

  if (GAME_ENABLED && !unlocked) {
    return <TypingGameScreen />;
  }

  if (initializing) {
    return <CenteredSpinner label="Checking your session…" />;
  }

  if (!user) {
    return <AuthPanel initialMode="login" />;
  }

  if (GAME_ENABLED && boundUserId !== user.id) {
    return <AuthPanel initialMode="reauth" />;
  }

  if (conversationId) {
    return <ChatScreen conversationId={conversationId} onBack={() => setConversationId(null)} />;
  }

  return <ConversationList onOpen={setConversationId} />;
}

function CenteredSpinner({ label }: { label: string }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand" />
      <p className="text-sm text-ink-muted">{label}</p>
    </main>
  );
}
