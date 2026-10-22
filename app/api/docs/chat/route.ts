/**
 * Docs Chat API Route
 * Spawns real Claude Code CLI sessions that use the MAX subscription.
 * No API credits are consumed - uses local Claude installation.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  getSession,
  deleteSession,
  sendMessage,
  getSessionCount,
} from '@/lib/claude-session';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

interface StartRequest {
  action: 'start';
  documentTitle: string;
  documentContent: string;
}

interface MessageRequest {
  action: 'message';
  sessionId: string;
  content: string;
  imageData?: string; // Base64 data URL
}

interface StopRequest {
  action: 'stop';
  sessionId: string;
}

interface StatusRequest {
  action: 'status';
}

type ChatRequest = StartRequest | MessageRequest | StopRequest | StatusRequest;

export const POST = tracked('/api/docs/chat', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body: ChatRequest = await request.json();

    // Start a new session
    if (body.action === 'start') {
      const { documentTitle, documentContent } = body as StartRequest;

      if (!documentTitle || !documentContent) {
        return NextResponse.json(
          { error: 'documentTitle and documentContent are required' },
          { status: 400 }
        );
      }

      const session = createSession(documentTitle, documentContent);

      return NextResponse.json({
        success: true,
        sessionId: session.id,
        message: 'Session created',
      });
    }

    // Send a message and stream response
    if (body.action === 'message') {
      const { sessionId, content, imageData } = body as MessageRequest;

      if (!sessionId || (!content && !imageData)) {
        return NextResponse.json(
          { error: 'sessionId and content (or imageData) are required' },
          { status: 400 }
        );
      }

      const session = getSession(sessionId);
      if (!session) {
        return NextResponse.json(
          { error: 'Session not found' },
          { status: 404 }
        );
      }

      // Create a streaming response with proper cleanup handling
      const encoder = new TextEncoder();
      let isClosed = false;
      let emitter: ReturnType<typeof sendMessage>;

      const readable = new ReadableStream({
        start(controller) {
          emitter = sendMessage(sessionId, content || 'Please analyze this image.', imageData);

          const safeEnqueue = (data: Uint8Array) => {
            if (!isClosed) {
              try {
                controller.enqueue(data);
              } catch {
                // Controller already closed (client disconnected)
                isClosed = true;
                emitter?.removeAllListeners();
              }
            }
          };

          const safeClose = () => {
            if (!isClosed) {
              isClosed = true;
              try {
                controller.close();
              } catch {
                // Already closed
              }
            }
          };

          emitter.on('data', (chunk: string) => {
            const data = JSON.stringify({ type: 'text', content: chunk });
            safeEnqueue(encoder.encode(`data: ${data}\n\n`));
          });

          emitter.on('end', () => {
            safeEnqueue(encoder.encode('data: [DONE]\n\n'));
            safeClose();
          });

          emitter.on('error', (err: Error) => {
            const errorData = JSON.stringify({
              type: 'error',
              message: err.message,
            });
            safeEnqueue(encoder.encode(`data: ${errorData}\n\n`));
            safeClose();
          });
        },
        cancel() {
          // Called when client disconnects
          isClosed = true;
          emitter?.removeAllListeners();
        },
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    // Stop a session
    if (body.action === 'stop') {
      const { sessionId } = body as StopRequest;

      if (!sessionId) {
        return NextResponse.json(
          { error: 'sessionId is required' },
          { status: 400 }
        );
      }

      const deleted = deleteSession(sessionId);

      return NextResponse.json({
        success: deleted,
        message: deleted ? 'Session stopped' : 'Session not found',
      });
    }

    // Get status
    if (body.action === 'status') {
      return NextResponse.json({
        success: true,
        activeSessions: getSessionCount(),
      });
    }

    return NextResponse.json(
      { error: 'Invalid action' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Chat API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Request failed' },
      { status: 500 }
    );
  }
});

// GET for checking API status
export const GET = tracked('/api/docs/chat', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  return NextResponse.json({
    status: 'ok',
    activeSessions: getSessionCount(),
    type: 'claude-code',
    description: 'Uses local Claude Code CLI (MAX subscription)',
  });
});
