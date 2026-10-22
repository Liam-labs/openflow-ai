import { NextRequest, NextResponse } from 'next/server';
import { readSilentMessages } from '@/lib/collab-message-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const GET = tracked('/api/collab/silent-messages', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  const { searchParams } = request.nextUrl;
  const channelId = searchParams.get('channelId');

  if (!channelId) {
    return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
  }

  try {
    const data = await readSilentMessages(channelId);
    return NextResponse.json({ messages: data.messages });
  } catch (error) {
    console.error('[silent-messages] Failed to read silent messages:', error);
    return NextResponse.json({ error: 'Failed to read silent messages' }, { status: 500 });
  }
});
