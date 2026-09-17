'use client';

import { useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import type { UserSearchResult } from '@mt/types';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { useChatStore } from '@/stores/chat-store';

export function NewConversationDialog({
  open,
  onClose,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  onOpened: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const searchUsers = useChatStore((state) => state.searchUsers);
  const createConversation = useChatStore((state) => state.createConversation);

  return (
    <Dialog open={open} onClose={onClose} title="New conversation" description="Search for people to message.">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-ink-faint" />
        <Input
          value={query}
          onChange={async (event) => {
            const value = event.target.value;
            setQuery(value);
            setResults(value.trim() ? await searchUsers(value) : []);
          }}
          placeholder="Name"
          className="pl-9"
          data-secret-ignore="true"
          autoFocus
        />
      </div>
      <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto">
        {results.map((user) => (
          <li key={user.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 px-1 py-2 text-left hover:bg-surface-raised"
              onClick={async () => {
                const id = user.conversationId ?? (await createConversation(user.id));
                if (id) {
                  onOpened(id);
                  onClose();
                }
              }}
            >
              <Avatar name={user.name} src={user.photoUrl} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{user.name}</span>
                <span className="block text-xs text-ink-faint">
                  {user.hasConversation ? 'Existing conversation' : 'Start a new conversation'}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {query.trim() && results.length === 0 ? (
        <EmptyState icon={UserPlus} title="No matches" description="Try a different name." />
      ) : null}
    </Dialog>
  );
}
