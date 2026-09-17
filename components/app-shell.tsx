'use client';

import { useCallback, useEffect, useState } from 'react';
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
 * The single gate every visitor passes through.
 *
 * Order of checks: access session (typing game + secret code) → authentication →
 * chat. Nothing about the messaging app is rendered, routed or hinted at until
 * all three are satisfied.
 */
export function AppShell() {
  const challenge = useAccessStore((state) => state.challenge);
  const unlocked = useAccessStore((state) => state.unlocked);
  const boundUserId = useAccessStore((state) => state.boundUserId);
  const startChallenge = useAccessStore((state) => state.startChallenge);
  const lock = useAccessStore((state) => state.lock);
  const user = useAuthStore((state) => state.user);
  const initializing = useAuthStore((state) => state.initializing);
  const privacyLocked = useUiPrivacy();
  const [conversationId, setConversationId] = useState<string | null>(null);

  useKeystrokeUnlock(unlocked ? null : challenge);
  useVisibilityLock(true);

  const handleTripleTap = useCallback(() => {
    if (!unlocked) return;
    setConversationId(null);
    void lock();
  }, [unlocked, lock]);
  // Triple tap only matters once the chat is reachable.
  useTripleTap(handleTripleTap, unlocked);

  // The challenge is fetched on first paint so the detector is armed immediately.
  useEffect(() => {
    if (!challenge && !unlocked) void startChallenge();
  }, [challenge, unlocked, startChallenge]);

  // Re-arm after a lock so the next attempt works without a reload.
  useEffect(() => {
    if (!unlocked && !challenge) void startChallenge();
  }, [unlocked, challenge, startChallenge]);

  if (privacyLocked && !unlocked) {
    return <LockedScreen />;
  }

  if (!unlocked) {
    return <TypingGameScreen />;
  }

  if (initializing) {
    return <CenteredSpinner label="Checking your session…" />;
  }

  if (!user) {
    return <AuthPanel initialMode="login" />;
  }

  if (boundUserId !== user.id) {
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
