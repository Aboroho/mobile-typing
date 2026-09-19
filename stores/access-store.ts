import { create } from 'zustand';
import { sha256Hex } from '@mt/utils';
import type { AccessChallenge, AccessChallengeStatus } from '@mt/types';
import { api } from '@/lib/client/api';
import { useUiStore } from './ui-store';

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
  /**
   * Incremented by every `lock()`. A `refresh()` that started before a lock
   * must not restore `unlocked` from its (now stale) response.
   */
  lockVersion: number;
  startChallenge: () => Promise<AccessChallenge | null>;
  unlockWithCode: (code: string) => Promise<boolean>;
  /**
   * Locks immediately on the client and revokes the server session.
   * `force` revokes the server session even when this tab already believes
   * it is locked — used when a stored "hidden since" stamp says the session
   * should have ended while the page was away. `before` runs (best effort)
   * while the session is still valid, e.g. to end an active call.
   */
  lock: (options?: { silent?: boolean; force?: boolean; before?: () => Promise<void> }) => Promise<void>;
  refresh: () => Promise<void>;
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
  lockVersion: 0,

  async startChallenge() {
    set({ loading: true, error: null });
    try {
      const { challenge } = await api.access.challenge();
      set({
        challenge,
        status: {
          epoch: challenge.epoch,
          maxLength: challenge.maxLength,
          caseSensitive: challenge.caseSensitive,
          configured: true,
        },
        loading: false,
      });
      return challenge;
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
      return null;
    }
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
      set({ loading: false, error: errorMessage(error) });
      return false;
    }
  },

  async lock(options) {
    const wasUnlocked = get().unlocked;
    // Client state first and synchronously: the chat unmounts in this tick,
    // before any network round trip.
    set((state) => ({
      unlocked: false,
      boundUserId: null,
      epoch: null,
      expiresAt: null,
      challenge: null,
      lockVersion: state.lockVersion + 1,
    }));
    if (!wasUnlocked && !options?.force) return;
    if (options?.before) {
      // Work that still needs the session (ending a call) goes first, bounded
      // so a stuck request can never delay the revoke for long.
      await Promise.race([
        options.before().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    try {
      await api.access.lock();
    } catch {
      // The server session will expire on its own; the UI is already locked.
    }
    if (!options?.silent && wasUnlocked)
      useUiStore.getState().pushToast('Locked. Type the sequence again to continue.');
  },

  async refresh() {
    const version = get().lockVersion;
    try {
      const { status, unlocked, session } = await api.access.status();
      if (get().lockVersion !== version) {
        // Locked while the request was in flight: the answer describes a
        // session that has just been revoked. Keep the challenge metadata only.
        set({ status, epoch: status.epoch });
        return;
      }
      // Restores the unlocked UI after a reload: the httpOnly cookie is the
      // source of truth and the server told us whether it is still valid.
      set({
        status,
        unlocked,
        boundUserId: session?.userId ?? null,
        epoch: status.epoch,
        expiresAt: session?.expiresAt ?? null,
        ...(unlocked ? {} : { challenge: null }),
      });
    } catch {
      // Status is advisory; a failure here must not block the game.
    }
  },
}));

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'something went wrong';
}
