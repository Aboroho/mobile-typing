'use client';

import { useState } from 'react';
import { formatClock } from '@mt/utils';
import type { AdminUserRow, MessageForAdmin } from '@mt/types';
import type { AdminConversationResponse } from '@mt/api-client';
import { api } from '@/lib/client/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUiStore } from '@/stores/ui-store';
import { errorMessage } from '@/stores/access-store';

/**
 * Conversation inspection. Every open writes an audit entry server side, which
 * is the point of this panel: administrative reads are never silent.
 */
export default function AdminConversationsPage() {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [participantA, setParticipantA] = useState('');
  const [participantB, setParticipantB] = useState('');
  const [conversation, setConversation] = useState<AdminConversationResponse | null>(null);
  const [messages, setMessages] = useState<MessageForAdmin[]>([]);
  const [query, setQuery] = useState('');

  const loadUsers = async (q: string) => {
    const result = await api.admin.users({ q: q || undefined, limit: 25 });
    setUsers(result.items);
  };

  const inspect = async () => {
    try {
      const result = await api.admin.inspectConversation(participantA, participantB);
      setConversation(result);
      if (result.conversationId) {
        const page = await api.admin.messages(result.conversationId, { limit: 50 });
        setMessages(page.items);
      } else {
        setMessages([]);
      }
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  };

  const search = async () => {
    if (!conversation?.conversationId) return;
    const page = await api.admin.messages(conversation.conversationId, { q: query || undefined, limit: 50 });
    setMessages(page.items);
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold">Inspect a conversation</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Participant A</Label>
            <Input
              list="admin-users"
              value={participantA}
              onChange={(event) => {
                setParticipantA(event.target.value);
                void loadUsers(event.target.value);
              }}
              placeholder="User id"
              data-secret-ignore="true"
            />
          </div>
          <div>
            <Label>Participant B</Label>
            <Input
              list="admin-users"
              value={participantB}
              onChange={(event) => {
                setParticipantB(event.target.value);
                void loadUsers(event.target.value);
              }}
              placeholder="User id"
              data-secret-ignore="true"
            />
          </div>
        </div>
        <datalist id="admin-users">
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name} ({user.email})
            </option>
          ))}
        </datalist>
        <Button className="mt-3" onClick={() => void inspect()} disabled={!participantA || !participantB}>
          Inspect
        </Button>
      </section>

      {conversation ? (
        <section className="rounded-2xl border border-line bg-surface p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">
              {conversation.exists ? 'Messages' : 'No conversation exists between these users'}
            </h2>
            <Badge>{conversation.messageCount} total</Badge>
            {conversation.participants.map((participant) => (
              <Badge key={participant.id} tone="brand">
                {participant.name}
              </Badge>
            ))}
          </div>

          {conversation.exists ? (
            <>
              <div className="mb-3 flex gap-2">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search message text"
                  data-secret-ignore="true"
                />
                <Button variant="secondary" onClick={() => void search()}>
                  Search
                </Button>
              </div>
              <ul className="max-h-[32rem] space-y-2 overflow-y-auto">
                {messages.map((message) => (
                  <li
                    key={message.id}
                    className={`rounded-xl border px-3 py-2 text-sm ${
                      message.deleted ? 'border-danger/40 bg-danger/5' : 'border-line bg-surface-raised'
                    }`}
                  >
                    <div className="flex items-center gap-2 text-[11px] text-ink-faint">
                      <span className="font-medium text-ink-muted">{message.sender?.name ?? message.senderId}</span>
                      <span>{formatClock(message.createdAt)}</span>
                      <Badge>{message.type}</Badge>
                      {message.deleted ? <Badge tone="danger">deleted</Badge> : null}
                      {message.edited ? <Badge tone="warning">edited {message.editHistory.length}×</Badge> : null}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words">
                      {message.deleted
                        ? `[hidden] ${message.metadata?.originalText ?? message.text ?? 'content removed'}`
                        : message.text ?? (message.media ? `(${message.media.kind})` : '')}
                    </p>
                    {message.deletedAt ? (
                      <p className="mt-1 text-[11px] text-ink-faint">
                        deleted {formatClock(message.deletedAt)} by {message.deletedBy}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] text-ink-faint">
                Every inspection is recorded in the audit log with your account and IP address.
              </p>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
