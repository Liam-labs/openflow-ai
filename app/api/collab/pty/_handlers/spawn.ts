/**
 * PTY session handlers: spawn, message, close, detach.
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  CollabMessage,
} from '@/lib/types';
import {
  spawnCollabPtySession,
  sendToPty,
  closePtySession,
  detachPtySession,
  getPtySession,
} from '@/lib/collab-pty';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { appendMessage } from '@/lib/collab-message-io';
import {
  readChannelsData,
  type PtyActionRequest,
  type PtyActionResponse,
} from '../_pty-shared';

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

export async function handleSpawn(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'channelId is required',
    }, { status: 400 });
  }

  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === body.channelId);

  if (!channel) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'Channel not found',
    }, { status: 404 });
  }

  const agentName = body.agentName || 'PTY Agent';

  const agentSessionId = `pty-agent-${Date.now()}`;
  const agentWorkDir = path.join('/tmp', 'collab-agents', agentSessionId);
  await fs.mkdir(agentWorkDir, { recursive: true });

  const { session, participant } = await spawnCollabPtySession({
    channelId: body.channelId,
    channelName: channel.name,
    participantName: agentName,
    workingDirectory: agentWorkDir,
    onData: async () => {},
    onEnd: async () => {},
    onError: async (error: Error) => {
      console.error(`[PTY API] Session error:`, error);
    },
    onStatusChange: async () => {},
  });

  const systemPrompt = body.systemPrompt || `You are "${agentName}", a collaborative AI agent in the "${channel.name}" channel.

CRITICAL: To send messages that others can see, write JSON to a temp file and curl it:

Step 1 - Write your message to a file:
\`\`\`bash
echo '{"action":"message","channelId":"${body.channelId}","participantId":"${participant.id}","content":"YOUR MESSAGE HERE"}' > /tmp/msg.json
\`\`\`

Step 2 - Send it:
\`\`\`bash
curl -s -X POST http://localhost:3000/api/collab -H "Content-Type: application/json" -d @/tmp/msg.json
\`\`\`

Replace YOUR MESSAGE HERE with your actual response text.

When you see messages like "[Someone]: Hello", respond using the two-step approach above.

Introduce yourself now using this method.`;

  setTimeout(() => {
    sendToPty(session.id, systemPrompt);
  }, 3000);

  const spawnChannelId = body.channelId;
  const ptyJoinMessage: CollabMessage = {
    id: randomUUID(),
    channelId: spawnChannelId,
    from: {
      id: 'system',
      type: 'user',
      name: 'System',
      source: 'DevFlow',
      joinedAt: now,
      lastSeen: now,
    },
    content: `${participant.name} (PTY Agent) joined the channel`,
    timestamp: now,
  };

  await mutateChannels('pty-spawn-agent:add-participant', async channelData => {
    const targetChannel = channelData.channels.find(c => c.id === spawnChannelId);
    if (targetChannel) {
      targetChannel.participants.push(participant);
      targetChannel.lastActivity = now;
      await saveChannels(channelData);
    }
  });

  await appendMessage(spawnChannelId, ptyJoinMessage);

  return NextResponse.json<PtyActionResponse>({
    success: true,
    session,
    participant,
  });
}

// ---------------------------------------------------------------------------
// message
// ---------------------------------------------------------------------------

export async function handlePtyMessage(
  body: PtyActionRequest
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.sessionId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'sessionId is required',
    }, { status: 400 });
  }

  if (!body.content) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'content is required',
    }, { status: 400 });
  }

  const session = getPtySession(body.sessionId);
  if (!session) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'PTY session not found',
    }, { status: 404 });
  }

  const sent = sendToPty(body.sessionId, body.content);

  if (!sent) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'Failed to send to PTY',
    }, { status: 500 });
  }

  return NextResponse.json<PtyActionResponse>({
    success: true,
    session,
  });
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

export async function handleClose(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.sessionId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'sessionId is required',
    }, { status: 400 });
  }

  const session = getPtySession(body.sessionId);
  if (!session) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'PTY session not found',
    }, { status: 404 });
  }

  await mutateChannels('pty-leave:remove-participant', async channelsData => {
    const channel = channelsData.channels.find(c => c.id === session.channelId);
    if (channel) {
      channel.participants = channel.participants.filter(
        p => p.id !== session.participantId
      );

      const leaveMessage: CollabMessage = {
        id: randomUUID(),
        channelId: session.channelId,
        from: {
          id: 'system',
          type: 'user',
          name: 'System',
          source: 'DevFlow',
          joinedAt: now,
          lastSeen: now,
        },
        content: `PTY Agent left the channel`,
        timestamp: now,
      };
      channel.messages.push(leaveMessage);

      await saveChannels(channelsData);
    }
  });

  await closePtySession(body.sessionId);

  return NextResponse.json<PtyActionResponse>({ success: true });
}

// ---------------------------------------------------------------------------
// detach
// ---------------------------------------------------------------------------

export async function handleDetach(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.sessionId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'sessionId is required',
    }, { status: 400 });
  }

  const session = getPtySession(body.sessionId);
  if (!session) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'PTY session not found',
    }, { status: 404 });
  }

  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === session.channelId);
  if (!channel) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'Channel not found',
    }, { status: 404 });
  }

  const messages = channel.messages.map(m => ({
    from: { name: m.from.name },
    content: m.content,
    timestamp: m.timestamp,
  }));

  const result = await detachPtySession(body.sessionId, messages);

  if (!result.success) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: result.error,
    }, { status: 500 });
  }

  await mutateChannels('pty-detach:remove-participant', async freshData => {
    const freshChannel = freshData.channels.find(c => c.id === session.channelId);
    if (freshChannel) {
      freshChannel.participants = freshChannel.participants.filter(
        p => p.id !== session.participantId
      );

      const detachMessage: CollabMessage = {
        id: randomUUID(),
        channelId: session.channelId,
        from: {
          id: 'system',
          type: 'user',
          name: 'System',
          source: 'DevFlow',
          joinedAt: now,
          lastSeen: now,
        },
        content: `PTY Agent detached to terminal. Continue with:\n\`\`\`\n${result.command}\n\`\`\``,
        timestamp: now,
      };
      freshChannel.messages.push(detachMessage);

      await saveChannels(freshData);
    }
  });

  return NextResponse.json<PtyActionResponse>({
    success: true,
    contextFile: result.contextFile,
    command: result.command,
  });
}
