'use client';

import { useCallback, useEffect, useState } from 'react';
import { parsePublicEnv } from '@mt/config';
import { useAccessStore } from '@/stores/access-store';
import { useAuthStore } from '@/stores/auth-store';
import { useKeystrokeUnlock } from '@/hooks/use-keystroke-unlock';
import { useTripleTap } from '@/hooks/use-triple-tap';
import { useVisibilityLock } from '@/hooks/use-visibility-lock';
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
 */
export function AppShell() {
  const challenge = useAccessStore((state) => state.challenge);
  const unlocked = useAccessStore((state) => state.unlocked) || !GAME_ENABLED;
  const boundUserId = useAccessStore((state) => state.boundUserId);
  const startChallenge = useAccessStore((state) => state.startChallenge);
  const lock = useAccessStore((state) => state.lock);
  const user = useAuthStore((state) => state.user);
  const initializing = useAuthStore((state) => state.initializing);
  const privacyLocked = useUiPrivacy();
  const [conversationId, setConversationId] = useState<string | null>(null);

  useKeystrokeUnlock(GAME_ENABLED && !unlocked ? challenge : null);
  useVisibilityLock(GAME_ENABLED);

  const handleTripleTap = useCallback(() => {
    if (!unlocked) return;
    setConversationId(null);
    void lock();
  }, [unlocked, lock]);
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

  if (GAME_ENABLED && privacyLocked && !unlocked) {
    return <LockedScreen />;
  }

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

function useUiPrivacy() {
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const onChange = () => setLocked(document.documentElement.classList.contains('privacy-locked'));
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    onChange();
    return () => observer.disconnect();
  }, []);
  return locked;
}

function LockedScreen() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">Locked</h1>
      <p className="max-w-xs text-sm text-ink-muted">
        The screen was hidden, so the session was closed. Return to the typing test to continue.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white"
      >
        Back to the typing test
      </button>
    </main>
  );
}

function CenteredSpinner({ label }: { label: string }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand" />
      <p className="text-sm text-ink-muted">{label}</p>
    </main>
  );
}
