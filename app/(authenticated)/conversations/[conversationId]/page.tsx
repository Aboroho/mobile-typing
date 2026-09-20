'use client';

import { use, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ChatScreen } from '@/components/messages/chat-screen';
import { useHideChat } from '@/hooks/use-hide-chat';

export default function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = use(params);
  const router = useRouter();
  const navigateHome = useCallback(() => router.replace('/'), [router]);
  // Hiding revokes the access session and returns to the typing game.
  const hide = useHideChat({ onHidden: navigateHome });
  return <ChatScreen conversationId={conversationId} onBack={() => router.push('/conversations')} onHide={hide} />;
}
