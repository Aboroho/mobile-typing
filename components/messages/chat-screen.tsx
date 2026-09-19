'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, EyeOff, Phone, ShieldAlert } from 'lucide-react';
import type { MessageForUser } from '@mt/types';
import { messageKey } from '@mt/domain';
import { isSameDay } from '@mt/utils';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import { useCallStore } from '@/stores/call-store';
import { CHAT_HIDING_AVAILABLE, hideChat } from '@/lib/client/privacy-lock';
import { useDoubleTap } from '@/hooks/use-double-tap';
import { useSeenObserver } from '@/hooks/use-seen-observer';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Composer } from './composer';
import { MessageBubble } from './message-bubble';
import { TypingBubble } from './typing-bubble';

// Zustand selectors are read through React's useSyncExternalStore. Returning a
// new array for a missing conversation makes every snapshot look different and
// causes React to render forever, so the fallback must have a stable identity.
const EMPTY_MESSAGES: MessageForUser[] = [];

/** How close to the bottom (px) the list must be for new messages to auto-scroll. */
const STICK_TO_BOTTOM_PX = 120;

export function ChatScreen({ conversationId, onBack }: { conversationId: string; onBack: () => void }) {
  const user = useAuthStore((state) => state.user);
  const conversation = useChatStore((state) => state.activeConversation);
  const messages = useChatStore((state) => state.messages[conversationId] ?? EMPTY_MESSAGES);
  const loadState = useChatStore((state) => state.loadState[conversationId]);
  const hasMore = useChatStore((state) => state.hasMore[conversationId] ?? false);
  const loadingOlder = useChatStore((state) => state.loadingOlder[conversationId] ?? false);
  const typing = useChatStore((state) => state.typingPeer[conversationId] ?? false);
  const streamState = useChatStore((state) => state.streamState[conversationId]);
  const openConversation = useChatStore((state) => state.openConversation);
  const leaveConversation = useChatStore((state) => state.leaveConversation);
  const loadOlder = useChatStore((state) => state.loadOlderMessages);
  const editMessage = useChatStore((state) => state.editMessage);
  const deleteMessage = useChatStore((state) => state.deleteMessage);
  const retry = useChatStore((state) => state.retry);
  const discardFailed = useChatStore((state) => state.discardFailed);
  const startCall = useCallStore((state) => state.startCall);

  const [editing, setEditing] = useState<MessageForUser | null>(null);
  const [editText, setEditText] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastKey = useRef<string | null>(null);
  /** Scroll metrics captured right before an older page is requested. */
  const prependAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  // One subscription per open conversation; leaving tears it down (stream,
  // typing indicator, pending receipts) so nothing runs for a closed chat.
  useEffect(() => {
    void openConversation(conversationId);
    return () => leaveConversation(conversationId);
  }, [conversationId, openConversation, leaveConversation]);

  // Track whether the user is reading history or following the latest messages.
  const onScroll = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_TO_BOTTOM_PX;
  }, []);

  // Follow new messages (and the typing bubble) when at the bottom; never yank
  // the view while reading history. When an older page was prepended, keep the
  // same message under the finger (manual scroll anchoring — Safari has none).
  const newestKey = messages.length > 0 ? messageKey(messages[messages.length - 1]!) : null;
  const oldestKey = messages.length > 0 ? messageKey(messages[0]!) : null;
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const anchor = prependAnchor.current;
    if (anchor && !loadingOlder) {
      prependAnchor.current = null;
      element.scrollTop = anchor.scrollTop + (element.scrollHeight - anchor.scrollHeight);
      lastKey.current = newestKey;
      return;
    }
    const newestChanged = newestKey !== lastKey.current;
    lastKey.current = newestKey;
    if ((newestChanged && (stickToBottom.current || loadState !== 'ready')) || (typing && stickToBottom.current)) {
      element.scrollTop = element.scrollHeight;
    }
  }, [newestKey, oldestKey, loadState, loadingOlder, typing]);

  const onLoadOlder = useCallback(() => {
    const element = listRef.current;
    if (element) prependAnchor.current = { scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
    void loadOlder(conversationId);
  }, [conversationId, loadOlder]);

  // Seen receipts: a peer bubble reports itself once it is on screen.
  const registerSeen = useSeenObserver(conversationId, listRef);

  // Privacy: double-tap on the message area hides the chat.
  const onHide = useCallback((reason: 'hide-button' | 'double-tap') => hideChat(reason), []);
  const onDoubleTap = useCallback(() => onHide('double-tap'), [onHide]);
  useDoubleTap(listRef, onDoubleTap, { enabled: CHAT_HIDING_AVAILABLE });

  const onRetry = useCallback(
    (message: MessageForUser) => {
      if (message.clientMessageId) void retry(conversationId, message.clientMessageId);
    },
    [conversationId, retry],
  );
  const onDiscard = useCallback(
    (message: MessageForUser) => {
      if (message.clientMessageId) discardFailed(conversationId, message.clientMessageId);
    },
    [conversationId, discardFailed],
  );
  const onReply = useCallback((id: string) => setReplyTo(id), []);
  const onEdit = useCallback((target: MessageForUser) => {
    setEditing(target);
    setEditText(target.text ?? '');
  }, []);
  const onDelete = useCallback((id: string) => setPendingDelete(id), []);

  const ownId = user?.id ?? 'me';
  let lastDay = '';

  return (
    <div className="privacy-blur mx-auto flex h-dvh w-full max-w-lg flex-col md:max-w-2xl lg:max-w-3xl">
      <header className="flex items-center gap-1 border-b border-line bg-surface px-1 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to conversations"
          className="rounded-full p-2 text-ink-muted hover:bg-surface-raised"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        {conversation ? (
          <>
            <Avatar
              name={conversation.otherUser.name}
              src={conversation.otherUser.photoUrl}
              size="sm"
              online={conversation.otherUser.presence === 'online'}
            />
            <div className="ml-1 min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{conversation.otherUser.name}</p>
              <p className="truncate text-[11px] text-ink-muted" aria-live="polite">
                {typing ? (
                  <span className="text-brand">typing…</span>
                ) : streamState === 'reconnecting' ? (
                  'reconnecting…'
                ) : conversation.otherUser.presence === 'online' ? (
                  'online'
                ) : (
                  'last seen recently'
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void startCall(conversationId)}
              aria-label="Start audio call"
              className="rounded-full p-2 text-brand hover:bg-brand-soft"
            >
              <Phone className="h-5 w-5" />
            </button>
          </>
        ) : (
          <div className="ml-1 min-w-0 flex-1">
            <p className="h-4 w-32 animate-pulse rounded bg-surface-raised" />
          </div>
        )}
        {CHAT_HIDING_AVAILABLE ? (
          <button
            type="button"
            onClick={() => onHide('hide-button')}
            aria-label="Hide chat and return to the typing game"
            title="Hide chat"
            className="flex h-11 min-w-11 items-center justify-center gap-1 rounded-full px-3 text-ink-muted transition-colors hover:bg-danger/10 hover:text-danger active:bg-danger/20"
          >
            <EyeOff className="h-5 w-5" />
            <span className="hidden text-xs font-medium sm:inline">Hide</span>
          </button>
        ) : null}
      </header>

      <div
        ref={listRef}
        onScroll={onScroll}
        className="chat-backdrop flex-1 space-y-1 overflow-y-auto bg-surface-sunken py-3"
        role="log"
        aria-label="Messages"
      >
        {CHAT_HIDING_AVAILABLE ? (
          <p className="mx-auto mb-2 w-fit rounded-full bg-warning/10 px-3 py-1 text-[11px] text-ink-muted">
            <ShieldAlert className="mr-1 inline h-3 w-3" />
            Double-tap here or use Hide to close the chat instantly.
          </p>
        ) : null}
        {hasMore ? (
          <button
            type="button"
            onClick={onLoadOlder}
            disabled={loadingOlder}
            className="mx-auto mb-2 block rounded-full bg-surface px-3 py-1 text-[11px] text-ink-muted disabled:opacity-60"
          >
            {loadingOlder ? 'Loading…' : 'Load earlier messages'}
          </button>
        ) : null}
        {messages.map((message) => {
          const day = new Date(message.createdAt).toDateString();
          const showDay = day !== lastDay;
          lastDay = day;
          const own = message.senderId === ownId;
          // Keyed by the logical identity (clientMessageId ?? id), which stays
          // the same when a placeholder is replaced by the server's message —
          // so the bubble is updated in place instead of unmounted/remounted.
          const key = messageKey(message);
          return (
            <div
              key={key}
              ref={own ? undefined : registerSeen({ id: message.id, senderId: message.senderId, createdAt: message.createdAt })}
              data-message-key={key}
              className={message.deliveryState === 'sending' ? 'animate-fade-in' : undefined}
            >
              {showDay ? (
                <p className="my-2 text-center text-[11px] text-ink-faint">
                  {isSameDay(message.createdAt, Date.now()) ? 'Today' : new Date(message.createdAt).toLocaleDateString()}
                </p>
              ) : null}
              <MessageBubble
                message={message}
                own={own}
                replyTarget={replyTo}
                onReply={onReply}
                onEdit={onEdit}
                onDelete={onDelete}
                onRetry={onRetry}
                onDiscard={onDiscard}
              />
            </div>
          );
        })}
        {typing ? <TypingBubble /> : null}
        {loadState === 'loading' && messages.length === 0 ? (
          <p className="px-6 py-10 text-center text-xs text-ink-faint">Loading messages…</p>
        ) : null}
        {loadState === 'error' && messages.length === 0 ? (
          <div className="px-6 py-10 text-center text-xs text-ink-faint">
            <p>Could not load this conversation.</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => void openConversation(conversationId)}>
              Try again
            </Button>
          </div>
        ) : null}
        {loadState === 'ready' && messages.length === 0 ? (
          <p className="px-6 py-10 text-center text-xs text-ink-faint">
            No messages yet. Say hello — or tap the phone icon to start an audio call.
          </p>
        ) : null}
      </div>

      <Composer conversationId={conversationId} replyToId={replyTo} onClearReply={() => setReplyTo(null)} />

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit message"
        description="Edits are allowed for two minutes after sending."
      >
        <div className="space-y-3">
          <Input
            value={editText}
            onChange={(event) => setEditText(event.target.value)}
            data-secret-ignore="true"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!editing) return;
                await editMessage(editing.id, editText);
                setEditing(null);
              }}
            >
              Save
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete message"
        description="The message disappears from the chat for everyone."
      >
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPendingDelete(null)}>
            Keep
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              if (!pendingDelete) return;
              await deleteMessage(pendingDelete, 'everyone');
              setPendingDelete(null);
            }}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
