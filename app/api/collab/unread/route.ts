import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import type { CollabChannelsData, CollabParticipant, CollabMessage } from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { readChannelMessages } from '@/lib/collab-message-io';
import { tracked } from '@/lib/api-tracking';

const DATA_PATH = DataPaths.collabChannels;

const DEFAULT_CHANNELS_DATA: CollabChannelsData = {
  channels: [],
  lastUpdated: new Date().toISOString(),
};

interface UnreadInfo {
  channelId: string;
  channelName: string;
  unreadCount: number;
  lastMessageFrom: string;
  lastMessagePreview: string;
  lastMessageTime: string;
}

interface UnreadResponse {
  participantId: string;
  totalUnread: number;
  channels: UnreadInfo[];
  timestamp: string;
}

function countUnread(messages: CollabMessage[], participant: CollabParticipant): number {
  const lastRead = participant.lastRead || participant.joinedAt;
  const lastReadTime = new Date(lastRead);

  return messages.filter(m => {
    if (m.from.id === participant.id) return false;
    if (m.from.id === 'system') return false;
    return new Date(m.timestamp) > lastReadTime;
  }).length;
}

/**
 * GET /api/collab/unread
 * Get unread message counts for a participant across all channels they're in
 *
 * Query params:
 * - participantId: The participant to check unreads for
 *
 * Returns summary for Claude Code hooks to display notifications
 */
export const GET = tracked('/api/collab/unread', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const { searchParams } = request.nextUrl;
    const participantId = searchParams.get('participantId');

    if (!participantId) {
      return NextResponse.json({
        error: 'participantId is required',
      }, { status: 400 });
    }

    const data = await readJsonFile<CollabChannelsData>(DATA_PATH, DEFAULT_CHANNELS_DATA);
    const unreads: UnreadInfo[] = [];

    // Check each channel this participant is in
    for (const channel of data.channels) {
      const participant = channel.participants.find(p => p.id === participantId);
      if (!participant) continue;

      // Read messages from per-channel file
      const msgData = await readChannelMessages(channel.id);
      const unreadCount = countUnread(msgData.messages, participant);
      if (unreadCount === 0) continue;

      // Get last unread message for preview
      const lastRead = participant.lastRead || participant.joinedAt;
      const lastReadTime = new Date(lastRead);
      const unreadMessages = msgData.messages.filter(m =>
        m.from.id !== participant.id &&
        m.from.id !== 'system' &&
        new Date(m.timestamp) > lastReadTime
      );

      const lastMessage = unreadMessages[unreadMessages.length - 1];

      unreads.push({
        channelId: channel.id,
        channelName: channel.name,
        unreadCount,
        lastMessageFrom: lastMessage?.from.name || 'Unknown',
        lastMessagePreview: lastMessage?.content.slice(0, 100) || '',
        lastMessageTime: lastMessage?.timestamp || '',
      });
    }

    const totalUnread = unreads.reduce((sum, u) => sum + u.unreadCount, 0);

    return NextResponse.json<UnreadResponse>({
      participantId,
      totalUnread,
      channels: unreads,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in GET /api/collab/unread:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
});
