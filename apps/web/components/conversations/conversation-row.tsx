'use client';

import { formatClock, isSameDay, formatRelative } from '@mt/utils';
import type { ConversationView } from '@mt/types';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/components/ui/cn';

export function ConversationRow({
  conversation,
  active,
  onSelect,
  onHide,
}: {
  conversation: ConversationView;
  active?: boolean;
  onSelect: () => void;
  onHide?: () => void;
}) {
  const { lastMessage } = conversation.conversation;
  const prefix = lastMessage ? (lastMessage.senderId === conversation.otherUser.id ? '' : 'You: ') : '';
  return (
    <li className={cn('relative', active && 'bg-surface-raised')}>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised"
      >
        <Avatar
          name={conversation.otherUser.name}
          src={conversation.otherUser.photoUrl}
          online={conversation.otherUser.presence === 'online'}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-semibold text-ink">{conversation.otherUser.name}</span>
            <span className="shrink-0 text-[11px] text-ink-faint">
              {lastMessage
                ? isSameDay(lastMessage.createdAt, Date.now())
                  ? formatClock(lastMessage.createdAt)
                  : formatRelative(lastMessage.createdAt)
                : ''}
            </span>
          </span>
          <span className="mt-0.5 flex items-center justify-between gap-2">
            <span className="truncate text-xs text-ink-muted">
              {conversation.isTyping ? (
                <em className="text-brand">typing…</em>
              ) : lastMessage ? (
                `${prefix}${lastMessage.text}`
              ) : (
                'No messages yet'
              )}
            </span>
            {conversation.unreadCount > 0 ? (
              <span className="ml-2 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-semibold text-white">
                {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {onHide ? (
        <button
          type="button"
          onClick={onHide}
          aria-label={`Hide conversation with ${conversation.otherUser.name}`}
          className="absolute right-2 top-2 rounded-full p-1 text-ink-faint opacity-0 transition-opacity hover:bg-surface-sunken hover:text-danger focus:opacity-100"
        >
          ✕
        </button>
      ) : null}
    </li>
  );
}
