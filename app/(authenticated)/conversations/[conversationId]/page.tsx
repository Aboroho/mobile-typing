'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { ChatScreen } from '@/components/messages/chat-screen';

export default function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = use(params);
  const router = useRouter();
  return <ChatScreen conversationId={conversationId} onBack={() => router.push('/conversations')} />;
}
