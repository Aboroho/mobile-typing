'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Phone, ShieldAlert } from 'lucide-react';
import type { MessageForUser } from '@mt/types';
import { isSameDay } from '@mt/utils';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import { useCallStore } from '@/stores/call-store';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Composer } from './composer';
import { MessageBubble } from './message-bubble';

// Zustand selectors are read through React's useSyncExternalStore. Returning a
// new array for a missing conversation makes every snapshot look different and
// causes React to render forever, so the fallback must have a stable identity.
const EMPTY_MESSAGES: MessageForUser[] = [];

export function ChatScreen({ conversationId, onBack }: { conversationId: string; onBack: () => void }) {
  const user = useAuthStore((state) => state.user);
  const conversation = useChatStore((state) => state.activeConversation);
  const messages = useChatStore((state) => state.messages[conversationId] ?? EMPTY_MESSAGES);
  const typing = useChatStore((state) => state.typingPeer[conversationId] ?? false);
  const openConversation = useChatStore((state) => state.openConversation);
  const loadOlder = useChatStore((state) => state.loadOlderMessages);
  const editMessage = useChatStore((state) => state.editMessage);
  const deleteMessage = useChatStore((state) => state.deleteMessage);
  const retry = useChatStore((state) => state.retry);
  const startCall = useCallStore((state) => state.startCall);

  const [editing, setEditing] = useState<MessageForUser | null>(null);
  const [editText, setEditText] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void openConversation(conversationId);
  }, [conversationId, openConversation]);

  // Keep the newest message in view.
  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length]);

  const onRetry = useCallback(
    (message: MessageForUser) => {
      if (!message.text) return;
      void retry(conversationId, message.clientMessageId ?? '', message.text);
    },
    [conversationId, retry],
  );

  const ownId = user?.id ?? 'me';
  let lastDay = '';

  return (
    <div className="mx-auto flex h-dvh w-full max-w-lg flex-col md:max-w-2xl lg:max-w-3xl">
      <header className="flex items-center gap-2 border-b border-line bg-surface px-2 py-2">
        <button type="button" onClick={onBack} aria-label="Back to conversations" className="rounded-full p-2 text-ink-muted hover:bg-surface-raised">
          <ArrowLeft className="h-5 w-5" />
        </button>
        {conversation ? (
          <>
            <Avatar name={conversation.otherUser.name} src={conversation.otherUser.photoUrl} size="sm" online={conversation.otherUser.presence === 'online'} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{conversation.otherUser.name}</p>
              <p className="truncate text-[11px] text-ink-muted">
                {typing ? <span className="text-brand">typing…</span> : conversation.otherUser.presence === 'online' ? 'online' : 'last seen recently'}
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
        ) : null}
      </header>

      <div ref={listRef} className="chat-backdrop flex-1 space-y-1 overflow-y-auto bg-surface-sunken py-3">
        <p className="mx-auto mb-2 w-fit rounded-full bg-warning/10 px-3 py-1 text-[11px] text-ink-muted">
          <ShieldAlert className="mr-1 inline h-3 w-3" />
          Messages are private. Leaving the app locks the chat.
        </p>
        <button
          type="button"
          onClick={() => void loadOlder(conversationId)}
          className="mx-auto mb-2 block rounded-full bg-surface px-3 py-1 text-[11px] text-ink-muted"
        >
          Load earlier messages
        </button>
        {messages.map((message) => {
          const day = new Date(message.createdAt).toDateString();
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={message.id}>
              {showDay ? (
                <p className="my-2 text-center text-[11px] text-ink-faint">
                  {isSameDay(message.createdAt, Date.now()) ? 'Today' : new Date(message.createdAt).toLocaleDateString()}
                </p>
              ) : null}
              <MessageBubble
                message={message}
                own={message.senderId === ownId || message.deliveryState === 'sending'}
                replyTarget={replyTo}
                onReply={(id) => setReplyTo(id)}
                onEdit={(target) => {
                  setEditing(target);
                  setEditText(target.text ?? '');
                }}
                onDelete={(id) => setPendingDelete(id)}
                onRetry={onRetry}
              />
            </div>
          );
        })}
        {messages.length === 0 ? (
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
