'use client';

import { useState } from 'react';
import { Check, CheckCheck, Clock, Pencil, Phone, Trash2, X } from 'lucide-react';
import type { MessageForUser } from '@mt/types';
import { formatClock } from '@mt/utils';
import { cn } from '@/components/ui/cn';
import { ImageMessage } from '@/components/media/image-message';
import { VoiceMessage } from '@/components/voice-messages/voice-message';

const DELETED_TEXT = 'This message was deleted';

export function MessageBubble({
  message,
  own,
  replyTarget,
  onReply,
  onEdit,
  onDelete,
  onRetry,
}: {
  message: MessageForUser;
  own: boolean;
  replyTarget?: string | null;
  onReply: (messageId: string) => void;
  onEdit: (message: MessageForUser) => void;
  onDelete: (messageId: string) => void;
  onRetry: (message: MessageForUser) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const deleted = message.deleted;
  const canEdit = own && !deleted && message.type === 'text' && withinEditWindow(message.createdAt);

  return (
    <div
      className={cn('group flex w-full px-3', own ? 'justify-end' : 'justify-start')}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <div className="relative max-w-[85%]">
        {message.replyTo ? (
          <div className="mb-1 rounded-lg border-l-2 border-brand bg-black/5 px-2 py-1 text-[11px] text-ink-muted">
            {message.replyTo.preview || 'Message'}
          </div>
        ) : null}
        <div
          className={cn(
            'rounded-bubble px-3 py-2 text-sm shadow-sm',
            own ? 'rounded-tr-sm bg-brand-soft text-ink' : 'rounded-tl-sm bg-surface-raised text-ink',
            deleted && 'italic text-ink-faint',
            replyTarget === message.id && 'ring-2 ring-brand',
          )}
        >
          {deleted ? (
            <p>{DELETED_TEXT}</p>
          ) : message.media ? (
            <div className="space-y-1">
              {message.media.kind === 'image' ? (
                <ImageMessage media={message.media} own={own} onOpenViewOnce={() => undefined} />
              ) : (
                <VoiceMessage media={message.media} />
              )}
              {message.text ? <p className="whitespace-pre-wrap break-words">{message.text}</p> : null}
            </div>
          ) : message.type === 'call' ? (
            <p className="flex items-center gap-2 text-ink-muted">
              <Phone className="h-4 w-4" />
              {message.text ?? 'Audio call'}
            </p>
          ) : (
            <p className="whitespace-pre-wrap break-words">{message.text}</p>
          )}
          <span className="mt-1 flex items-center justify-end gap-1 text-[10px] text-ink-faint">
            {message.edited ? <span className="italic">edited</span> : null}
            <span className="tabular-nums">{formatClock(message.createdAt)}</span>
            {own ? <DeliveryTicks message={message} onRetry={onRetry} /> : null}
          </span>
        </div>

        {menuOpen ? (
          <div
            className="absolute right-0 top-full z-20 mt-1 w-36 overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <MenuItem icon={Pencil} label="Edit" disabled={!canEdit} onClick={() => { setMenuOpen(false); onEdit(message); }} />
            <MenuItem
              icon={Trash2}
              label="Delete"
              danger
              onClick={() => {
                setMenuOpen(false);
                onDelete(message.id);
              }}
            />
            <button type="button" onClick={() => setMenuOpen(false)} className="w-full px-3 py-2 text-left text-xs text-ink-faint">
              <X className="mr-1 inline h-3 w-3" />
              Close
            </button>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => onReply(message.id)}
          aria-label="Reply to message"
          className="absolute -left-8 top-1 hidden rounded-full p-1 text-ink-faint hover:bg-surface-sunken group-hover:block"
        >
          ↩
        </button>
      </div>
    </div>
  );
}

function DeliveryTicks({ message, onRetry }: { message: MessageForUser; onRetry: (message: MessageForUser) => void }) {
  switch (message.deliveryState) {
    case 'sending':
      return <Clock className="h-3 w-3" aria-label="Sending" />;
    case 'failed':
      return (
        <button type="button" onClick={() => onRetry(message)} className="text-danger underline-offset-2 hover:underline">
          Failed · Retry
        </button>
      );
    case 'read':
      return <CheckCheck className="h-3 w-3 text-brand" aria-label="Read" />;
    case 'delivered':
      return <CheckCheck className="h-3 w-3" aria-label="Delivered" />;
    default:
      return <Check className="h-3 w-3" aria-label="Sent" />;
  }
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-2 text-left text-xs disabled:opacity-40',
        danger ? 'text-danger hover:bg-danger/10' : 'text-ink hover:bg-surface-raised',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/** Mirrors the server rule so the menu does not offer an edit that will fail. */
function withinEditWindow(createdAt: string): boolean {
  return Date.now() - new Date(createdAt).getTime() <= 2 * 60 * 1000;
}
