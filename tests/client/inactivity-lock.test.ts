/**
 * @vitest-environment jsdom
 *
 * The chat-hiding rules end to end: the inactivity hook, the `hideChat()`
 * coordinator and the access/chat/ui stores, against a scripted API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const lockCalls: string[] = [];
let statusUnlocked = true;

vi.mock('@/lib/client/api', () => ({
  api: {
    access: {
      lock: vi.fn(async () => {
        lockCalls.push('lock');
        return { ok: true };
      }),
      status: vi.fn(async () => ({
        status: { epoch: 1, maxLength: 15, caseSensitive: true, configured: true },
        unlocked: statusUnlocked,
        session: statusUnlocked ? { userId: 'u_me', expiresAt: '2099-01-01T00:00:00.000Z' } : null,
      })),
      challenge: vi.fn(),
      unlock: vi.fn(),
    },
    conversations: {
      get: vi.fn(async () => ({ conversation: null, iceServers: [] })),
      list: vi.fn(async () => ({ items: [], hasMore: false })),
      typing: vi.fn(async () => ({ ok: true })),
      markRead: vi.fn(async () => ({ ok: true, updated: 0, messageIds: [] })),
    },
    messages: {
      list: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })),
      send: vi.fn(),
      markDelivered: vi.fn(async () => ({ updated: 0, messageIds: [] })),
      edit: vi.fn(),
      remove: vi.fn(),
    },
    media: { send: vi.fn() },
    users: { search: vi.fn(async () => ({ items: [] })) },
    calls: { end: vi.fn(async () => ({ ok: true })) },
  },
}));

vi.mock('@/lib/browser/sse-client', () => ({
  connectEventStream: vi.fn(() => () => undefined),
}));

import { CHAT_HIDDEN_LOCK_MS } from '@mt/types';
import { useInactivityLock } from '@/hooks/use-inactivity-lock';
import { CHAT_HIDDEN_EVENT, hideChat, type ChatHiddenDetail } from '@/lib/client/privacy-lock';
import { HIDDEN_STAMP_KEY } from '@/lib/browser/hidden-timer';
import { useAccessStore } from '@/stores/access-store';
import { useChatStore, __resetChatRuntimeForTests } from '@/stores/chat-store';
import { useUiStore } from '@/stores/ui-store';

let visibility: DocumentVisibilityState = 'visible';
const mounted: Array<{ unmount(): void }> = [];

/** Mounts the hook and guarantees it is unmounted even when an assertion fails. */
function mount(enabled = true) {
  const hook = renderHook(() => useInactivityLock(enabled));
  mounted.push(hook);
  return hook;
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

function unlockedState() {
  useAccessStore.setState({
    unlocked: true,
    boundUserId: 'u_me',
    epoch: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
    challenge: null,
  });
  useChatStore.setState({
    activeConversationId: 'c_1',
    messages: { c_1: [] },
    conversations: [],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  lockCalls.length = 0;
  statusUnlocked = true;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  window.sessionStorage.clear();
  document.documentElement.classList.remove('privacy-locked');
  __resetChatRuntimeForTests();
  useChatStore.getState().reset();
  useAccessStore.setState({ unlocked: false, boundUserId: null, lockVersion: 0 });
  useUiStore.setState({ privacyLocked: false });
});

afterEach(() => {
  for (const hook of mounted.splice(0)) hook.unmount();
  vi.useRealTimers();
});

describe('hideChat()', () => {
  it('locks synchronously, wipes chat state, blurs and revokes the server session', async () => {
    unlockedState();
    const events: ChatHiddenDetail[] = [];
    const onHidden = (event: Event) => events.push((event as CustomEvent<ChatHiddenDetail>).detail);
    window.addEventListener(CHAT_HIDDEN_EVENT, onHidden);

    hideChat('hide-button');

    // Everything below is true before any network round trip.
    expect(useAccessStore.getState().unlocked).toBe(false);
    expect(useAccessStore.getState().boundUserId).toBeNull();
    expect(useChatStore.getState().activeConversationId).toBeNull();
    expect(useChatStore.getState().messages).toEqual({});
    expect(document.documentElement.classList.contains('privacy-locked')).toBe(true);
    expect(events).toEqual([{ reason: 'hide-button' }]);

    await vi.advanceTimersByTimeAsync(0);
    expect(lockCalls).toEqual(['lock']);
    window.removeEventListener(CHAT_HIDDEN_EVENT, onHidden);
  });

  it('prevents an in-flight status refresh from re-opening the chat', async () => {
    unlockedState();
    const refreshing = useAccessStore.getState().refresh(); // response says "unlocked"
    hideChat('double-tap');
    await refreshing;
    expect(useAccessStore.getState().unlocked).toBe(false);
  });
});

describe('useInactivityLock', () => {
  it('does not lock when the tab is hidden for less than the threshold', async () => {
    unlockedState();
    const hook = mount();

    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHAT_HIDDEN_LOCK_MS - 1000);
    });
    act(() => setVisibility('visible'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * CHAT_HIDDEN_LOCK_MS);
    });

    expect(useAccessStore.getState().unlocked).toBe(true);
    expect(useChatStore.getState().activeConversationId).toBe('c_1');
    expect(lockCalls).toEqual([]);
    hook.unmount();
  });

  it('locks once the tab has been hidden for the threshold', async () => {
    unlockedState();
    const hook = mount();

    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHAT_HIDDEN_LOCK_MS);
    });

    expect(useAccessStore.getState().unlocked).toBe(false);
    expect(useChatStore.getState().messages).toEqual({});
    expect(lockCalls).toEqual(['lock']);
    hook.unmount();
  });

  it('locks on return when the timer could not run while hidden (suspended tab)', async () => {
    unlockedState();
    const hook = mount();

    act(() => setVisibility('hidden'));
    // Jump the clock without running timers, like a suspended mobile browser.
    vi.setSystemTime(Date.now() + 10 * CHAT_HIDDEN_LOCK_MS);
    act(() => setVisibility('visible'));

    expect(useAccessStore.getState().unlocked).toBe(false);
    hook.unmount();
  });

  it('never locks on blur/focus alone', async () => {
    unlockedState();
    const hook = mount();

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * CHAT_HIDDEN_LOCK_MS);
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(useAccessStore.getState().unlocked).toBe(true);
    expect(lockCalls).toEqual([]);
    hook.unmount();
  });

  it('honours a stamp left by a previous page lifetime', async () => {
    // The tab was hidden with the chat open, then discarded and restored later.
    window.sessionStorage.setItem(HIDDEN_STAMP_KEY, String(Date.now() - 2 * CHAT_HIDDEN_LOCK_MS));
    const refreshing = useAccessStore.getState().refresh(); // cookie still valid server side
    const hook = mount();
    await refreshing;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(useAccessStore.getState().unlocked).toBe(false);
    // Even though this tab already believed it was locked, the server session
    // is revoked because the stamp proves it should have been.
    expect(lockCalls).toEqual(['lock']);
    expect(window.sessionStorage.getItem(HIDDEN_STAMP_KEY)).toBeNull();
    hook.unmount();
  });

  it('does nothing while the game screen is showing', async () => {
    const hook = mount();
    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * CHAT_HIDDEN_LOCK_MS);
    });
    expect(lockCalls).toEqual([]);
    expect(window.sessionStorage.getItem(HIDDEN_STAMP_KEY)).toBeNull();
    hook.unmount();
  });

  it('cleans up its listeners on unmount', async () => {
    unlockedState();
    const hook = mount();
    hook.unmount();
    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * CHAT_HIDDEN_LOCK_MS);
    });
    expect(useAccessStore.getState().unlocked).toBe(true);
  });
});
