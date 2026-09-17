'use client';

import { useRouter } from 'next/navigation';
import { ConversationList } from '@/components/conversations/conversation-list';

export default function ConversationsPage() {
  const router = useRouter();
  return <ConversationList onOpen={(conversationId) => router.push(`/conversations/${conversationId}`)} />;
}
