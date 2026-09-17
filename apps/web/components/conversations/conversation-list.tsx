'use client';

import { useEffect, useState } from 'react';
import { MessageSquarePlus, MessagesSquare, Settings } from 'lucide-react';
import Link from 'next/link';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ConversationRow } from './conversation-row';
import { NewConversationDialog } from './new-conversation-sheet';

export function ConversationList({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const conversations = useChatStore((state) => state.conversations);
  const loading = useChatStore((state) => state.loadingConversations);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const hideConversation = useChatStore((state) => state.hideConversation);
  const user = useAuthStore((state) => state.user);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface/95 px-4 py-3 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold leading-tight">Chats</h1>
          <p className="text-xs text-ink-muted">{user?.name ?? 'Signed in'}</p>
        </div>
        <div className="flex items-center gap-1">
          <Link href="/settings" aria-label="Settings" className="rounded-full p-2 text-ink-muted hover:bg-surface-raised">
            <Settings className="h-5 w-5" />
          </Link>
          <Button size="icon" aria-label="New conversation" onClick={() => setSearchOpen(true)}>
            <MessageSquarePlus className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {loading && conversations.length === 0 ? (
        <ul className="divide-y divide-line">
          {[0, 1, 2, 3].map((index) => (
            <li key={index} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {!loading && conversations.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="No conversations yet"
          description="Start a private one-to-one chat with someone you know."
          action={
            <Button className="mt-2" onClick={() => setSearchOpen(true)}>
              <MessageSquarePlus className="h-4 w-4" />
              New conversation
            </Button>
          }
        />
      ) : null}

      <ul className="divide-y divide-line">
        {conversations.map((conversation) => (
          <ConversationRow
            key={conversation.conversation.id}
            conversation={conversation}
            onSelect={() => onOpen(conversation.conversation.id)}
            onHide={() => void hideConversation(conversation.conversation.id)}
          />
        ))}
      </ul>

      <NewConversationDialog open={searchOpen} onClose={() => setSearchOpen(false)} onOpened={onOpen} />
    </div>
  );
}
