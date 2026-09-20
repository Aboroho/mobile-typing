import { create } from 'zustand';
import { sha256Hex } from '@mt/utils';
import { parsePublicEnv } from '@mt/config';
import type { AccessChallenge, AccessChallengeStatus } from '@mt/types';
import { api } from '@/lib/client/api';
import { useUiStore } from './ui-store';

/**
 * `NEXT_PUBLIC_ENABLE_TYPING_GAME=false` removes the typing-game disguise and
 * the secret-code gate. The server skips the access-session check entirely
 * (`requireAccess`), so this browser has nothing to unlock either. `NEXT_PUBLIC_*`
 * values are inlined at build time, so this is a static read, not a fetch.
 */
export const TYPING_GAME_ENABLED = parsePublicEnv().NEXT_PUBLIC_ENABLE_TYPING_GAME;

interface AccessState {
  challenge: AccessChallenge | null;
  status: AccessChallengeStatus | null;
  /** Client-side mirror of the server-issued access session. */
  unlocked: boolean;
  /** User id the server bound the access session to, if any. */
  boundUserId: string | null;
  epoch: number | null;
  expiresAt: string | null;
  loading: boolean;
  error: string | null;
  startChallenge: () => Promise<AccessChallenge | null>;
  unlockWithCode: (code: string) => Promise<boolean>;
  lock: (options?: { silent?: boolean }) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Challenge fetching is single-flight and self-healing.
 *
 * `startChallenge()` is called from an effect, which React invokes twice on
 * mount in development, and again whenever the access state is reset. Without
 * the guards below each call was a separate `POST /api/v1/access/challenge`,
 * which burned the (per-IP) rate-limit budget several times faster than the
 * page loads themselves: after a few reloads the endpoint answered 429, the
 * store kept `challenge: null`, no keystroke detector was ever attached, and
 * typing the secret code silently did nothing until the window expired.
 *
 * Now concurrent callers share one request, and a failed one is retried with
 * backoff (honouring `Retry-After` from a rate-limited response) so the gate
 * re-arms on its own instead of staying dead until a manual reload.
 */
let challengeRequest: Promise<AccessChallenge | null> | null = null;
let challengeRetryTimer: ReturnType<typeof setTimeout> | null = null;
let challengeAttempt = 0;

/** Delay before the next challenge attempt: server hint first, then backoff. */
export function challengeRetryDelayMs(error: unknown, attempt: number): number {
  const hinted = (error as { context?: { retryAfterSeconds?: number } } | null)?.context
    ?.retryAfterSeconds;
  if (typeof hinted === 'number' && Number.isFinite(hinted) && hinted > 0) {
    return Math.min(hinted * 1000, 60_000);
  }
  const base = 1000 * 2 ** Math.min(attempt, 4); // 1s, 2s, 4s, 8s, 16s
  return Math.min(base, 30_000);
}

function cancelChallengeRetry(): void {
  if (challengeRetryTimer) clearTimeout(challengeRetryTimer);
  challengeRetryTimer = null;
}

function scheduleChallengeRetry(error: unknown): void {
  if (challengeRetryTimer) return;
  const delay = challengeRetryDelayMs(error, challengeAttempt);
  challengeAttempt += 1;
  challengeRetryTimer = setTimeout(() => {
    challengeRetryTimer = null;
    const state = useAccessStore.getState();
    // Unlocked (nothing left to arm) or already armed by somebody else.
    if (state.unlocked || state.challenge) {
      challengeAttempt = 0;
      return;
    }
    void state.startChallenge();
  }, delay);
}

/**
 * Access (secret-code) state.
 *
 * The boolean here is only a rendering hint: the server issues an httpOnly
 * access cookie and every protected route re-validates it, so tampering with
 * this store cannot expose any data.
 */
export const useAccessStore = create<AccessState>((set, get) => ({
  challenge: null,
  status: null,
  unlocked: false,
  boundUserId: null,
  epoch: null,
  expiresAt: null,
  loading: false,
  error: null,

  async startChallenge() {
    const current = get();
    if (current.challenge) return current.challenge;
    // One request per arming, however many callers ask for it.
    if (challengeRequest) return challengeRequest;

    cancelChallengeRetry();
    set({ loading: true, error: null });
    challengeRequest = (async () => {
      try {
        const { challenge } = await api.access.challenge();
        challengeAttempt = 0;
        set({
          challenge,
          status: {
            epoch: challenge.epoch,
            maxLength: challenge.maxLength,
            caseSensitive: challenge.caseSensitive,
            configured: true,
          },
          loading: false,
          error: null,
        });
        return challenge;
      } catch (error) {
        // Rate limited (429) or offline: keep the game usable and retry, so the
        // gate re-arms by itself rather than requiring a reload.
        set({ loading: false, error: errorMessage(error) });
        scheduleChallengeRetry(error);
        return null;
      } finally {
        challengeRequest = null;
      }
    })();
    return challengeRequest;
  },

  async unlockWithCode(code) {
    const { challenge } = get();
    if (!challenge) {
      // No live challenge (e.g. after a reload): fetch one and retry immediately.
      const fresh = await get().startChallenge();
      if (!fresh) return false;
      return get().unlockWithCode(code);
    }
    set({ loading: true, error: null });
    try {
      // Only the digest leaves the browser, so the code never appears in logs.
      const digest = await sha256Hex(code);
      const result = await api.access.unlock({ challengeToken: challenge.challengeToken, digest });
      set({
        unlocked: result.unlocked,
        boundUserId: result.user?.id ?? null,
        epoch: result.epoch,
        expiresAt: result.expiresAt,
        loading: false,
        challenge: null,
      });
      return result.unlocked;
    } catch (error) {
      // The server consumes a challenge on every unlock attempt, so a single
      // failed one (a typo, a rotated code, a dropped request) leaves the token
      // in hand dead. Clearing it here makes the detector re-attach and the
      // next attempt work without a page reload.
      const message = errorMessage(error);
      set({ loading: false, error: message, challenge: null });
      // Never fail silently: on a phone a silent no-op looks exactly like the
      // keyboard being ignored, so the user has no way to tell anything went
      // wrong. The toast says what happened and that retyping is worth trying.
      useUiStore.getState().pushToast(`${message} — type the sequence again`, 'error');
      void get().startChallenge();
      return false;
    }
  },

  async lock(options) {
    const wasUnlocked = get().unlocked;
    cancelChallengeRetry();
    challengeAttempt = 0;
    set({
      unlocked: false,
      boundUserId: null,
      epoch: null,
      expiresAt: null,
      challenge: null,
      loading: false,
    });
    if (!wasUnlocked) return;
    try {
      await api.access.lock();
    } catch {
      // The server session will expire on its own; the UI is already locked.
    }
    if (!options?.silent)
      useUiStore.getState().pushToast('Locked. Type the sequence again to continue.');
  },

  async refresh() {
    try {
      const { status, unlocked, session } = await api.access.status();
      // Restores the unlocked UI after a reload: the httpOnly cookie is the
      // source of truth and the server told us whether it is still valid.
      //
      // A challenge that is already in hand is kept unless the server reports a
      // different epoch (the code was rotated while this page was open). The
      // status call races the challenge fetch on first paint, and clearing the
      // fresh challenge here used to trigger another request — which is how a
      // couple of reloads exhausted the challenge rate limit.
      const challenge = get().challenge;
      const stale = challenge !== null && challenge.epoch !== status.epoch;
      set({
        status,
        unlocked,
        boundUserId: session?.userId ?? null,
        epoch: status.epoch,
        expiresAt: session?.expiresAt ?? null,
        ...(stale ? { challenge: null } : {}),
      });
    } catch {
      // Status is advisory; a failure here must not block the game.
    }
  },
}));

/**
 * True when this browser has cleared the access gate (or when there is no
 * gate). Everything that talks to a user-scoped API — the call stream, the
 * realtime transport, the routed pages — must wait for this, because every one
 * of those routes is rejected with 403 `ACCESS_REQUIRED` until the secret-code
 * session exists. Subscribing early is a 403 every few seconds in the server
 * log and a hint that a messaging app lives behind the typing game.
 */
export function useAccessGateOpen(): boolean {
  return useAccessStore((state) => state.unlocked) || !TYPING_GAME_ENABLED;
}

/** Non-hook form of {@link useAccessGateOpen} for stores and event handlers. */
export function isAccessGateOpen(): boolean {
  return useAccessStore.getState().unlocked || !TYPING_GAME_ENABLED;
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'something went wrong';
}
