import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  Message,
  MessageThread,
  MessagesResponse,
  MessageActionRequest,
  MessageActionResponse,
  MessagesData,
  ClaudeSession,
  SessionsData,
} from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import { tracked } from '@/lib/api-tracking';
import { validateBodySize } from '@/lib/fetch-utils';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

const MESSAGES_PATH = DataPaths.messages;
const SESSIONS_PATH = DataPaths.sessions;
const INBOX_FILENAME = '.claude/session-inbox.json';

const DEFAULT_MESSAGES_DATA: MessagesData = {
  messages: [],
  threads: [],
  lastUpdated: new Date().toISOString(),
};

// Read messages data from file
async function readMessagesData(): Promise<MessagesData> {
  return readJsonFile<MessagesData>(MESSAGES_PATH, DEFAULT_MESSAGES_DATA);
}

// Write messages data to file
async function writeMessagesData(data: MessagesData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await writeJsonFile(MESSAGES_PATH, data);
}

// Get all registered sessions
async function getSessions(): Promise<ClaudeSession[]> {
  const defaultSessions: SessionsData = {
    sessions: [],
    config: { pollInterval: 5000, staleThreshold: 30, autoDiscovery: true },
    lastUpdated: new Date().toISOString(),
  };
  const data = await readJsonFile<SessionsData>(SESSIONS_PATH, defaultSessions);
  return data.sessions || [];
}

// Write message to session's inbox file
async function writeToInbox(session: ClaudeSession, message: Message): Promise<void> {
  const inboxPath = path.join(session.projectPath, INBOX_FILENAME);

  try {
    // Ensure .claude directory exists
    const claudeDir = path.dirname(inboxPath);
    await fs.mkdir(claudeDir, { recursive: true });

    // Read existing inbox or create new one
    let inbox: { sessionId: string; messages: Message[]; lastUpdated: string };
    try {
      const data = await fs.readFile(inboxPath, 'utf-8');
      inbox = JSON.parse(data);
    } catch {
      inbox = {
        sessionId: session.sessionId,
        messages: [],
        lastUpdated: new Date().toISOString()
      };
    }

    // Add new message
    inbox.messages.push(message);
    inbox.lastUpdated = new Date().toISOString();

    // Keep only last 50 messages
    if (inbox.messages.length > 50) {
      inbox.messages = inbox.messages.slice(-50);
    }

    await fs.writeFile(inboxPath, JSON.stringify(inbox, null, 2));
  } catch (error) {
    console.error(`Failed to write to inbox for session ${session.sessionId}:`, error);
  }
}

// Get or create thread
function getOrCreateThread(
  threads: MessageThread[],
  participants: string[],
  subject?: string
): MessageThread {
  // Look for existing thread with same participants
  const sortedParticipants = [...participants].sort();
  const existingThread = threads.find(t => {
    const sortedExisting = [...t.participants].sort();
    return sortedExisting.length === sortedParticipants.length &&
      sortedExisting.every((p, i) => p === sortedParticipants[i]);
  });

  if (existingThread) {
    return existingThread;
  }

  // Create new thread
  const newThread: MessageThread = {
    id: randomUUID(),
    participants: sortedParticipants,
    subject,
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    messageCount: 0
  };

  threads.push(newThread);
  return newThread;
}

export const GET = tracked('/api/claude/messages', async (request: Request) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const since = searchParams.get('since');
    const unreadOnly = searchParams.get('unread') === 'true';

    const messagesData = await readMessagesData();
    let messages = messagesData.messages;

    // Filter by recipient
    if (sessionId) {
      messages = messages.filter(m =>
        m.to === sessionId || m.to === 'all' || m.from === sessionId
      );
    }

    // Filter by timestamp
    if (since) {
      const sinceTime = new Date(since).getTime();
      messages = messages.filter(m => new Date(m.timestamp).getTime() > sinceTime);
    }

    // Filter by status
    if (unreadOnly) {
      messages = messages.filter(m => m.status === 'pending' || m.status === 'delivered');
    }

    // Sort by timestamp descending
    messages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Get relevant threads
    let threads = messagesData.threads;
    if (sessionId) {
      threads = threads.filter(t => t.participants.includes(sessionId));
    }

    return NextResponse.json<MessagesResponse>({
      messages: messages.slice(0, 100), // Limit to 100 messages
      threads,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    return NextResponse.json<MessagesResponse>({
      messages: [],
      threads: [],
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Failed to fetch messages'
    });
  }
});

export const POST = tracked('/api/claude/messages', async (request: Request) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'write');
  if (denied) return denied;

  const sizeError = validateBodySize(request);
  if (sizeError) return sizeError;
  try {
    const body: MessageActionRequest = await request.json();

    if (!body.from) {
      return NextResponse.json<MessageActionResponse>({
        success: false,
        error: 'from (session ID) is required'
      }, { status: 400 });
    }

    const messagesData = await readMessagesData();
    const sessions = await getSessions();
    const now = new Date().toISOString();

    if (body.action === 'send') {
      if (!body.to) {
        return NextResponse.json<MessageActionResponse>({
          success: false,
          error: 'to (recipient session ID) is required'
        }, { status: 400 });
      }

      if (!body.content) {
        return NextResponse.json<MessageActionResponse>({
          success: false,
          error: 'content is required'
        }, { status: 400 });
      }

      // Find recipient session
      const recipientSession = sessions.find(s => s.sessionId === body.to);

      // Get or create thread
      const thread = body.threadId
        ? messagesData.threads.find(t => t.id === body.threadId) || getOrCreateThread(messagesData.threads, [body.from, body.to])
        : getOrCreateThread(messagesData.threads, [body.from, body.to]);

      const message: Message = {
        id: randomUUID(),
        type: body.type || 'chat',
        from: body.from,
        to: body.to,
        content: body.content,
        timestamp: now,
        status: recipientSession ? 'delivered' : 'pending',
        threadId: thread.id,
        metadata: body.metadata
      };

      messagesData.messages.push(message);

      // Update thread
      thread.lastMessageAt = now;
      thread.messageCount++;

      await writeMessagesData(messagesData);

      // Write to recipient's inbox file if session exists
      if (recipientSession) {
        await writeToInbox(recipientSession, message);
      }

      return NextResponse.json<MessageActionResponse>({
        success: true,
        messageId: message.id
      });
    }

    if (body.action === 'broadcast') {
      if (!body.content) {
        return NextResponse.json<MessageActionResponse>({
          success: false,
          error: 'content is required'
        }, { status: 400 });
      }

      const message: Message = {
        id: randomUUID(),
        type: 'broadcast',
        from: body.from,
        to: 'all',
        content: body.content,
        timestamp: now,
        status: 'delivered',
        metadata: body.metadata
      };

      messagesData.messages.push(message);
      await writeMessagesData(messagesData);

      // Write to all session inbox files
      for (const session of sessions) {
        if (session.sessionId !== body.from) {
          await writeToInbox(session, message);
        }
      }

      return NextResponse.json<MessageActionResponse>({
        success: true,
        messageId: message.id
      });
    }

    if (body.action === 'respond') {
      if (!body.messageId) {
        return NextResponse.json<MessageActionResponse>({
          success: false,
          error: 'messageId is required for respond action'
        }, { status: 400 });
      }

      // Find original message
      const originalMessage = messagesData.messages.find(m => m.id === body.messageId);
      if (!originalMessage) {
        return NextResponse.json<MessageActionResponse>({
          success: false,
          error: 'Original message not found'
        }, { status: 404 });
      }

      // Create response message
      const recipientSession = sessions.find(s => s.sessionId === originalMessage.from);

      const responseMessage: Message = {
        id: randomUUID(),
        type: 'response',
        from: body.from,
        to: originalMessage.from,
        content: body.content || '',
        timestamp: now,
        status: recipientSession ? 'delivered' : 'pending',
        replyTo: body.messageId,
        threadId: originalMessage.threadId,
        metadata: body.metadata
      };

      messagesData.messages.push(responseMessage);

      // Update original message status
      originalMessage.status = 'responded';

      // Update thread if exists
      if (originalMessage.threadId) {
        const thread = messagesData.threads.find(t => t.id === originalMessage.threadId);
        if (thread) {
          thread.lastMessageAt = now;
          thread.messageCount++;
        }
      }

      await writeMessagesData(messagesData);

      // Write to original sender's inbox
      if (recipientSession) {
        await writeToInbox(recipientSession, responseMessage);
      }

      return NextResponse.json<MessageActionResponse>({
        success: true,
        messageId: responseMessage.id
      });
    }

    if (body.action === 'markRead') {
      if (!body.messageId) {
        return NextResponse.json<MessageActionResponse>({
          success: false,
          error: 'messageId is required for markRead action'
        }, { status: 400 });
      }

      const message = messagesData.messages.find(m => m.id === body.messageId);
      if (!message) {
        return NextResponse.json<MessageActionResponse>({
          success: false,
          error: 'Message not found'
        }, { status: 404 });
      }

      message.status = 'read';
      await writeMessagesData(messagesData);

      return NextResponse.json<MessageActionResponse>({
        success: true
      });
    }

    return NextResponse.json<MessageActionResponse>({
      success: false,
      error: `Unknown action: ${body.action}`
    }, { status: 400 });
  } catch (error) {
    console.error('Error executing message action:', error);
    return NextResponse.json<MessageActionResponse>({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to execute action'
    }, { status: 500 });
  }
});
