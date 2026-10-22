/**
 * GET /api/agent-stream?agent=<name>
 *
 * Live Server-Sent Events stream for every supported agent runtime. Resolves
 * the channel-scoped roster entry to its runtime-owned session file, normalizes
 * native records to the drawer contract, backfills the last 50 lines, then
 * polls the file for appended bytes.
 *
 * Event types (named via `event: <name>`):
 *   - `meta`      once on connect: { agent, path, resolvedVia }
 *   - `message`   each jsonl line, parsed if possible, raw otherwise
 *   - `heartbeat` every 15s: { ts }
 *   - `rotated`   when the underlying file path changes: { newPath }
 *   - `error`     unrecoverable failure: { message }
 *
 * Consumers (Phase 2 drawer — Daniel) subscribe via EventSource. Raw
 * assistant/user entries with `message.content[]` blocks are passed through
 * so the UI can render thinking / tool_use / tool_result blocks directly.
 */

import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { findAgentByName } from '@/lib/agent-jsonl-resolver';
import {
  normalizeAgentStreamLine,
  resolveAgentStreamSource,
} from '@/lib/agent-stream-runtime';
import { chooseAgentStreamSource } from '@/lib/agent-stream-source';
import { StreamHostOfflineError } from '@/lib/agent-stream-fs';
import {
  createSingleFlightPoll,
  readBackfill,
  readDelta,
} from '@/lib/agent-stream-tail';
import {
  MAX_CONCURRENT_STREAMS,
  getActiveStreams,
  incrementActiveStreams,
  decrementActiveStreams,
} from '@/lib/agent-stream-state';

export const dynamic = 'force-dynamic';

const BACKFILL_LINES = 50;
const POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 15_000;
const ROTATION_CHECK_EVERY_N_POLLS = 10; // every 5s at 500ms poll

function formatSSE(event: string, data: unknown, id?: number): string {
  const idLine = id !== undefined ? `id: ${id}\n` : '';
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const GET = tracked('/api/agent-stream', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const { searchParams } = request.nextUrl;
  const agentName = searchParams.get('agent');
  if (!agentName || agentName.trim().length === 0) {
    return Response.json(
      { error: "query parameter 'agent' is required" },
      { status: 400 },
    );
  }

  if (getActiveStreams() >= MAX_CONCURRENT_STREAMS) {
    return Response.json(
      { error: `Too many active streams (max ${MAX_CONCURRENT_STREAMS})` },
      { status: 429 },
    );
  }

  const channelId = searchParams.get('channelId') ?? undefined;
  const agent = await findAgentByName(agentName.trim(), channelId ? { channelId } : undefined);
  if (!agent) {
    return Response.json(
      { error: `agent '${agentName}' not found in any channel roster` },
      { status: 404 },
    );
  }

  // ---- Resolve runtime-owned data source ----
  let chosen;
  try {
    chosen = await chooseAgentStreamSource(agent);
  } catch (error) {
    if (error instanceof StreamHostOfflineError) {
      return Response.json({ error: `${error.message}, so its session cannot be read right now` }, { status: 503 });
    }
    throw error;
  }
  const resolved = chosen?.resolved;
  if (!chosen || !resolved) {
    return Response.json(
      {
        error:
          `agent '${agentName}' has no active ${agent.agentType ?? 'claude'} ` +
          'session owned by its working directory',
      },
      { status: 404 },
    );
  }
  const { path: filePath, runtime, resolvedVia } = resolved;
  const fsx = chosen.fsx;
  let hostOfflineReported = false;

  // ---- SSE streaming loop (shared) ----
  const encoder = new TextEncoder();
  let currentPath = filePath;
  let offset = 0;
  let leftover = '';
  let eventId = 0;
  let pollCycles = 0;
  let isClosed = false;
  let cleanupCalled = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let controller!: ReadableStreamDefaultController<Uint8Array>;

  function cleanup() {
    if (cleanupCalled) return;
    cleanupCalled = true;
    isClosed = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    decrementActiveStreams();
  }

  function safeEnqueue(chunk: Uint8Array): boolean {
    if (isClosed) return false;
    try {
      controller.enqueue(chunk);
      return true;
    } catch {
      cleanup();
      return false;
    }
  }

  function enqueueLine(line: string): void {
    const normalized = normalizeAgentStreamLine(runtime, line);
    for (const item of normalized) {
      if (isClosed) return;
      safeEnqueue(
        encoder.encode(formatSSE('message', item, ++eventId)),
      );
    }
  }

  request.signal.addEventListener('abort', cleanup, { once: true });

  const readable = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      if (cleanupCalled) return;
      controller = ctrl;
      incrementActiveStreams();

      safeEnqueue(
        encoder.encode(
          formatSSE('meta', {
            agent: agentName,
            path: currentPath,
            runtime,
            resolvedVia,
          }),
        ),
      );

      const backfill = await readBackfill(currentPath, BACKFILL_LINES, fsx);
      offset = backfill.offset;
      for (const line of backfill.lines) {
        if (isClosed) return;
        enqueueLine(line);
      }

      const pollOnce = createSingleFlightPoll(async () => {
        if (isClosed) return;
        pollCycles++;
        try {
          if (pollCycles % ROTATION_CHECK_EVERY_N_POLLS === 0) {
            const r = await resolveAgentStreamSource(agent, { fsx });
            if (r && r.path !== currentPath) {
              safeEnqueue(
                encoder.encode(
                  formatSSE('rotated', {
                    newPath: r.path,
                    runtime: r.runtime,
                    resolvedVia: r.resolvedVia,
                  }),
                ),
              );
              currentPath = r.path;
              offset = 0;
              leftover = '';
            }
          }

          const delta = await readDelta(currentPath, offset, leftover, fsx);
          hostOfflineReported = false;
          offset = delta.offset;
          leftover = delta.leftover;
          for (const line of delta.lines) {
            if (isClosed) return;
            enqueueLine(line);
          }
        } catch (err) {
          if (err instanceof StreamHostOfflineError) {
            // The agent host is briefly unreachable: say so once and keep polling instead of repeating it every 500 ms.
            if (!hostOfflineReported) {
              hostOfflineReported = true;
              safeEnqueue(encoder.encode(formatSSE('error', { message: `${err.message}; retrying` })));
            }
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          safeEnqueue(encoder.encode(formatSSE('error', { message })));
        }
      });
      pollTimer = setInterval(() => {
        void pollOnce();
      }, POLL_INTERVAL_MS);

      heartbeatTimer = setInterval(() => {
        safeEnqueue(
          encoder.encode(
            formatSSE('heartbeat', { ts: new Date().toISOString() }),
          ),
        );
      }, HEARTBEAT_INTERVAL_MS);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
