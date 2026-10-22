import { tracked } from '@/lib/api-tracking';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
/**
 * GET /api/bridges/whatsapp/qr
 *
 * SSE proxy: forwards the bridge's /auth/qr event stream to the DevFlow frontend.
 * Events: qr (base64 QR string), connected (phone info), error (reason)
 *
 * If bridge is unreachable, sends a single error event and closes.
 */

const BRIDGE_PORT = 8301;
const BRIDGE_URL = `http://localhost:${BRIDGE_PORT}`;

// Max time to wait for QR pairing (3 minutes)
const QR_TIMEOUT_MS = 3 * 60 * 1000;

export const GET = tracked('/api/bridges/whatsapp/qr', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Abort after QR_TIMEOUT_MS
      const abort = new AbortController();
      const timeout = setTimeout(() => {
        send('error', { reason: 'QR_TIMEOUT', message: 'Pairing window expired. Try pairing code instead.' });
        abort.abort();
        controller.close();
      }, QR_TIMEOUT_MS);

      try {
        const res = await fetch(`${BRIDGE_URL}/auth/qr`, {
          signal: abort.signal,
          headers: { Accept: 'text/event-stream' },
        });

        if (!res.ok || !res.body) {
          send('error', { reason: 'BRIDGE_UNAVAILABLE', message: 'Bridge is not running or not reachable.' });
          controller.close();
          clearTimeout(timeout);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Pass raw SSE chunks through unchanged
          controller.enqueue(value);

          // Check if we received a 'connected' event — can close after that
          const chunk = decoder.decode(value, { stream: true });
          if (chunk.includes('event: connected')) {
            clearTimeout(timeout);
            controller.close();
            return;
          }
        }
      } catch (error: unknown) {
        if ((error as { name?: string })?.name !== 'AbortError') {
          send('error', { reason: 'PROXY_ERROR', message: String(error) });
        }
      } finally {
        clearTimeout(timeout);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
