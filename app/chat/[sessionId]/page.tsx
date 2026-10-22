import { ChatPopoutClient } from '@/components/ChatPopoutClient';
import { PRODUCT_NAME } from '@/lib/brand';

interface ChatPopoutPageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function ChatPopoutPage({ params }: ChatPopoutPageProps) {
  const { sessionId } = await params;

  return <ChatPopoutClient sessionId={decodeURIComponent(sessionId)} />;
}

export const metadata = {
  title: `Claude Chat - ${PRODUCT_NAME}`,
  description: 'Claude Code chat session',
};
