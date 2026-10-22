/**
 * API Route Tracking Wrapper
 *
 * Wraps Next.js route handlers to automatically track response status codes
 * via the error-rate-tracker. Lightweight — no async overhead, just a
 * trackResponse() call after the handler returns.
 *
 * Usage:
 *   import { tracked } from '@/lib/api-tracking';
 *   export const GET = tracked('/api/example', async (request) => { ... });
 *
 *   // With slow-route logging (>500ms):
 *   export const GET = withTiming('/api/example', tracked('/api/example', async (request) => { ... }));
 */

import { NextRequest, NextResponse } from 'next/server';
import { trackResponse } from './error-rate-tracker';
import { logEvent } from './log-writer';

const SLOW_ROUTE_THRESHOLD_MS = 500;

/**
 * Wrap a route handler with automatic response tracking.
 * Captures status code from the response and feeds it to error-rate-tracker.
 * Generic over request and context types to accommodate all Next.js route handler signatures.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tracked<H extends (request: any, context?: any) => Promise<NextResponse | Response>>(
  route: string,
  handler: H
): H {
  const wrapped = async (request: NextRequest | Request, context?: unknown) => {
    try {
      const response = await handler(request, context);
      trackResponse(route, response.status);
      return response;
    } catch (error) {
      trackResponse(route, 500);
      throw error;
    }
  };
  return wrapped as unknown as H;
}

/**
 * Wrap a route handler with response-time logging.
 * Logs a 'medium' severity event for any response that exceeds SLOW_ROUTE_THRESHOLD_MS.
 * Composes with tracked(): withTiming('/api/x', tracked('/api/x', handler))
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withTiming<H extends (request: any, context?: any) => Promise<NextResponse | Response>>(
  route: string,
  handler: H
): H {
  const wrapped = async (request: NextRequest | Request, context?: unknown) => {
    const start = Date.now();
    try {
      const response = await handler(request, context);
      const durationMs = Date.now() - start;
      if (durationMs > SLOW_ROUTE_THRESHOLD_MS) {
        void logEvent('api', 'medium', `Slow route: ${route} (${durationMs}ms)`, { route, durationMs });
      }
      return response;
    } catch (error) {
      const durationMs = Date.now() - start;
      if (durationMs > SLOW_ROUTE_THRESHOLD_MS) {
        void logEvent('api', 'medium', `Slow route error: ${route} (${durationMs}ms)`, { route, durationMs });
      }
      throw error;
    }
  };
  return wrapped as unknown as H;
}
