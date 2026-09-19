'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { MessageForUser } from '@mt/types';
import { useChatStore } from '@/stores/chat-store';

type SeenInfo = Pick<MessageForUser, 'id' | 'senderId' | 'createdAt'>;

/** A bubble is "displayed" once at least this much of it is inside the list viewport. */
const VISIBLE_RATIO = 0.5;

/**
 * Decides when a peer message counts as *seen*: the bubble is at least half
 * inside the scrolling message list **and** the document is visible (not a
 * background tab, not a locked phone). Only then is the message reported to the
 * store, which turns it into a batched read watermark. A message that arrives
 * while the tab is hidden is reported the moment the tab becomes visible again
 * — if it is still on screen.
 *
 * Usage: attach the returned `register` as the ref of every peer bubble.
 */
export function useSeenObserver(conversationId: string, listRef: RefObject<HTMLElement | null>) {
  const report = useChatStore((state) => state.reportMessageSeen);
  const observerRef = useRef<IntersectionObserver | null>(null);
  /** Elements currently inside the viewport, with the message they show. */
  const visible = useRef(new Map<Element, SeenInfo>());
  /** Message info per observed element (so unobserve needs only the element). */
  const infoByElement = useRef(new Map<Element, SeenInfo>());
  const flushRef = useRef<() => void>(() => undefined);
  /** One stable ref callback per message id, so re-renders do not re-observe. */
  const callbacks = useRef(new Map<string, (element: HTMLElement | null) => (() => void) | undefined>());

  useEffect(() => {
    const root = listRef.current;
    const seen = new Set<string>();
    const onScreen = visible.current;
    const refCallbacks = callbacks.current;
    onScreen.clear();
    refCallbacks.clear();

    const flush = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      for (const info of onScreen.values()) {
        if (seen.has(info.id)) continue;
        seen.add(info.id);
        report(conversationId, info);
      }
    };
    flushRef.current = flush;

    if (typeof IntersectionObserver === 'undefined') {
      observerRef.current = null;
      // Fallback: everything rendered counts as displayed.
      for (const [element, info] of infoByElement.current) onScreen.set(element, info);
      flush();
    } else {
      observerRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const info = infoByElement.current.get(entry.target);
            if (!info) continue;
            if (entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO) onScreen.set(entry.target, info);
            else onScreen.delete(entry.target);
          }
          flush();
        },
        { root, threshold: [VISIBLE_RATIO] },
      );
      // Elements registered before the observer existed (first render).
      for (const element of infoByElement.current.keys()) observerRef.current.observe(element);
    }

    document.addEventListener('visibilitychange', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      observerRef.current?.disconnect();
      observerRef.current = null;
      onScreen.clear();
      refCallbacks.clear();
    };
  }, [conversationId, listRef, report]);

  /**
   * Ref callback for a peer bubble. Returns a cleanup (React 19) so a bubble
   * that unmounts — or whose element changes — is unobserved. Cached per
   * message id: the same function is handed back on every render.
   */
  const register = useCallback((info: SeenInfo) => {
    const cached = callbacks.current.get(info.id);
    if (cached) return cached;
    const callback = (element: HTMLElement | null) => {
      if (!element) return undefined;
      infoByElement.current.set(element, info);
      const observer = observerRef.current;
      if (observer) observer.observe(element);
      else {
        // No IntersectionObserver (very old browsers / test DOM): rendering
        // inside a visible document is the best available signal.
        visible.current.set(element, info);
        flushRef.current();
      }
      return () => {
        observer?.unobserve(element);
        infoByElement.current.delete(element);
        visible.current.delete(element);
      };
    };
    callbacks.current.set(info.id, callback);
    return callback;
  }, []);

  return register;
}
