/**
 * SSE Event Stream Endpoint
 *
 * GET /api/events - Server-Sent Events stream for real-time push updates.
 * Replaces frontend polling for PM2 status, health checks, collab messages, etc.
 *
 * Query Parameters:
 *   ?types=pm2,health,collab  - Filter by event domains (comma-separated)
 *                                Default: all events
 *   ?channelId=abc-123        - Filter collab events to specific channel
 *
 * Headers:
 *   Last-Event-ID: 42         - Resume from event ID (reconnection support)
 *
 * Event Format (SSE):
 *   id: 42
 *   event: pm2:status
 *   data: {"processes":[...]}
 *
 * GET /api/events?status=true - Returns JSON status (not SSE stream)
 */

import { NextRequest } from 'next/server';
import { eventBus, SSEEvent, EVENT_DOMAINS, SSEEventType } from '@/lib/event-bus';
import { requireAuthOrLocal, getClientIp, isLocalRequest } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { getChannelById } from '@/lib/collab-message-io';
import { sseConnectionShouldReceiveMessage } from '@/lib/collab-delivery';
import { formatCrossChannelMessageForHumans } from '@/lib/hidden-messages';
import type { CollabMessage } from '@/lib/types';

export const dynamic = 'force-dynamic';

const HEARTBEAT_INTERVAL_MS = 10_000; // 10s keepalive ping — detects dead connections faster
const STALE_CLIENT_TIMEOUT_MS = 60_000; // Cull clients with no successful write in 60s
const STALE_CLIENT_CHECK_MS = 30_000;   // Check for stale clients every 30s
const MAX_PER_IP_SSE = 10;              // Per-IP concurrent SSE connection cap

// Per-IP connection tracking — prevents single-origin resource exhaustion
const ipConnections = new Map<string, number>();

export const GET = tracked('/api/events', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const { searchParams } = request.nextUrl;

  // Status endpoint: GET /api/events?status=true
  if (searchParams.get('status') === 'true') {
    return Response.json({
      connected: eventBus.getClientCount(),
      maxConnections: 250,
      bufferSize: eventBus.getBufferSize(),
      maxBufferSize: eventBus.getMaxBufferSize(),
      totalEvents: eventBus.getEventCounter(),
      domains: Object.keys(EVENT_DOMAINS),
      timestamp: new Date().toISOString(),
    });
  }

  // SSE connection limit — prevent resource exhaustion.
  // Raised 50→250: the agent fleet (up to ~40 wrapper processes) each holds one
  // SSE stream, plus dashboard browser tabs. 50 was sized for browser tabs only
  // and starved the fleet. SSE connections are cheap (held response + 10s
  // heartbeat); 250 gives comfortable headroom over fleet + tabs + growth.
  const MAX_SSE_CLIENTS = 250;
  if (eventBus.getClientCount() >= MAX_SSE_CLIENTS) {
    return Response.json(
      { error: `Too many SSE connections (max ${MAX_SSE_CLIENTS})` },
      { status: 429 }
    );
  }

  // Per-IP connection cap — prevent single-origin exhaustion.
  // EXEMPT local/loopback requests: the entire agent fleet (40+ processes) shares
  // one machine IP, so this cap — designed to stop a single EXTERNAL origin from
  // exhausting connections — wrongly throttled trusted internal agents to 10,
  // forcing 30+ agents onto slow polling and causing the 429 storm on mass
  // restart. The global MAX_SSE_CLIENTS cap above remains the backstop for local.
  const clientIp = getClientIp(request);
  if (!isLocalRequest(request)) {
    const currentIpCount = ipConnections.get(clientIp) ?? 0;
    if (currentIpCount >= MAX_PER_IP_SSE) {
      return Response.json(
        { error: `Too many SSE connections from this IP (max ${MAX_PER_IP_SSE})` },
        { status: 429 }
      );
    }
  }

  // Parse event type filter
  const typesParam = searchParams.get('types');
  const channelId = searchParams.get('channelId');
  const participantId = searchParams.get('participantId');

  // Channel membership check — if a channelId filter is requested, verify the
  // participant is a member of that channel before allowing the subscription.
  // 2026-05-18: missing participantId no longer hard-errors — the frontend
  // briefly subscribes during mount before resolving its identity, generating
  // ~3.7k 400s/hr that polluted the API error rate. Treat as
  // "unauthenticated, channel filter dropped" instead.
  //
  // 2026-05-18 (P0 cross-channel-leak fix): previously when participantId was
  // missing we set channelFilter=null, which made shouldSend's
  // `if (channelFilter && ...)` guard short-circuit to false, allowing EVERY
  // collab event from EVERY channel to flow into the unauthenticated stream.
  // Symptom: an agent's Plex-channel message appeared in the owner's AcmeMedia
  // stream attributed to an agent. Fix: keep channelFilter set to the requested
  // channelId AND gate collab events behind canReceiveCollab=true (only true
  // after participantId resolves and membership is verified). Stream stays open
  // for non-collab events (pm2, health) so the mount-time pre-subscribe still
  // works without 400-ing or leaking cross-channel collab events.
  let channelFilter: string | null = channelId;
  let canReceiveCollab = false;
  // True only for agent-wrapper connections (participant type !== 'user'). Agent
  // SSE streams honor recipients[] (the targeted-message gate below); human /
  // browser connections never do, so the channel UI keeps rendering every
  // message in real time.
  let isAgentConnection = false;
  if (channelId) {
    if (!participantId) {
      // No participantId yet — keep stream open but block collab events
      // until reconnect with resolved identity.
      canReceiveCollab = false;
    } else {
      const channel = await getChannelById(channelId);
      if (!channel) {
        return Response.json({ error: 'Channel not found' }, { status: 404 });
      }
      const member = channel.participants.find(p => p.id === participantId);
      if (!member) {
        return Response.json(
          { error: 'Participant is not a member of this channel' },
          { status: 403 }
        );
      }
      canReceiveCollab = true;
      isAgentConnection = member.type !== 'user';
    }
  } else {
    // No channel filter requested — allow collab events through the global
    // subscription path (the type filter still applies if set).
    canReceiveCollab = true;
  }

  let allowedTypes: Set<SSEEventType> | null = null;

  if (typesParam) {
    const domains = typesParam.split(',').map(s => s.trim());
    const types: SSEEventType[] = [];
    for (const domain of domains) {
      if (domain in EVENT_DOMAINS) {
        types.push(...EVENT_DOMAINS[domain]);
      }
    }
    if (types.length > 0) {
      allowedTypes = new Set(types);
    }
  }

  // Check for Last-Event-ID (reconnection)
  const lastEventId = request.headers.get('Last-Event-ID');

  const encoder = new TextEncoder();
  let isClosed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  let lastWriteTime = Date.now(); // Updated on every successful safeEnqueue

  // Cleanup function — called on disconnect via request.signal OR ReadableStream.cancel()
  let cleanupCalled = false;
  function cleanup() {
    if (cleanupCalled) return;
    cleanupCalled = true;
    isClosed = true;
    eventBus.removeListener('sse-event', onEvent);
    eventBus.removeClient();
    const count = ipConnections.get(clientIp);
    if (count !== undefined) {
      if (count <= 1) ipConnections.delete(clientIp);
      else ipConnections.set(clientIp, count - 1);
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (staleCheckTimer) {
      clearInterval(staleCheckTimer);
      staleCheckTimer = null;
    }
  }

  // Wire request.signal — fires immediately when client disconnects (more reliable than cancel())
  request.signal.addEventListener('abort', cleanup, { once: true });

  function onEvent(event: SSEEvent) {
    if (shouldSend(event)) {
      safeEnqueue(encoder.encode(formatSSE(event)));
    }
  }

  function formatSSE(event: SSEEvent): string {
    let data = event.data;
    // Browser EventStreamContext connects without a channel filter; scoped
    // human connections are also known from membership. Agent wrappers always
    // connect with channelId + participantId and must retain the full envelope.
    if (event.type === 'collab:message' && !isAgentConnection) {
      const eventData = event.data as Record<string, unknown>;
      const message = eventData.message as CollabMessage | undefined;
      if (message) {
        data = {
          ...eventData,
          message: formatCrossChannelMessageForHumans(message),
        };
      }
    }
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function shouldSend(event: SSEEvent): boolean {
    if (allowedTypes && !allowedTypes.has(event.type)) return false;
    // Collab events require an identified, verified channel subscription.
    // canReceiveCollab is false during the brief mount-time window where the
    // frontend has a channelId in the URL but hasn't resolved participantId yet
    // — emitting collab events in that state caused the 2026-05-18 cross-channel
    // leak.
    if (event.type.startsWith('collab:')) {
      if (!canReceiveCollab) return false;
      if (channelFilter) {
        const eventData = event.data as Record<string, unknown>;
        if (eventData.channelId && eventData.channelId !== channelFilter) return false;
      }
      // Honor recipients[] on the SSE leg for agent connections so a targeted
      // message reaches only its recipients — mirrors deliverMessage's inbox/PTY
      // filtering. Without this, eventBus fanned every targeted message (e.g. a
      // hidden Ask-owner answer with recipients=[asker]) to every agent's SSE
      // stream, which the wrapper then injected. Humans and broadcasts are
      // unaffected.
      if (event.type === 'collab:message') {
        const message = (event.data as Record<string, unknown>).message as
          | { recipients?: string[] | null }
          | undefined;
        if (!sseConnectionShouldReceiveMessage(message?.recipients, participantId, isAgentConnection)) {
          return false;
        }
      }
    }
    return true;
  }

  function safeEnqueue(data: Uint8Array): boolean {
    if (isClosed) return false;
    try {
      controller.enqueue(data);
      lastWriteTime = Date.now(); // Track last successful write for stale culling
      return true;
    } catch {
      cleanup();
      return false;
    }
  }

  // controller must be accessible to the hoisted functions above
  let controller!: ReadableStreamDefaultController<Uint8Array>;

  const readable = new ReadableStream({
    start(ctrl) {
      // If abort fired before stream started, bail immediately
      if (cleanupCalled) return;
      controller = ctrl;
      eventBus.addClient();
      ipConnections.set(clientIp, (ipConnections.get(clientIp) ?? 0) + 1);

      // Replay missed events on reconnection
      if (lastEventId) {
        const missed = eventBus.getEventsSince(lastEventId);
        for (const event of missed) {
          if (shouldSend(event)) {
            if (!safeEnqueue(encoder.encode(formatSSE(event)))) return;
          }
        }
      }

      eventBus.on('sse-event', onEvent);

      // Heartbeat — keeps connection alive and detects dead streams
      heartbeatTimer = setInterval(() => {
        safeEnqueue(encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`));
      }, HEARTBEAT_INTERVAL_MS);

      // Stale client cull — disconnect clients that haven't received a write in 60s.
      // Heartbeats fire every 10s, so 60s = 6 consecutive missed heartbeats (zombie connection).
      staleCheckTimer = setInterval(() => {
        if (!isClosed && Date.now() - lastWriteTime > STALE_CLIENT_TIMEOUT_MS) {
          cleanup();
        }
      }, STALE_CLIENT_CHECK_MS);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering if behind reverse proxy
    },
  });
});
