/**
 * API Response Tracker — Lightweight wrapper for error rate tracking.
 *
 * Tracks HTTP response status codes for the error-rate-tracker module.
 * Does NOT log individual requests to the event log — that's handled by
 * emitApiEvent() in action handlers (event-driven, mutation-only).
 *
 * Usage:
 *   export const POST = withApiTracking(async (request) => { ... });
 */

import { NextRequest, NextResponse } from 'next/server';
import { trackResponse } from './error-rate-tracker';

type RouteHandler = (request: NextRequest, ctx?: unknown) => Promise<Response | NextResponse>;

/**
 * Wrap a Next.js route handler with error rate tracking.
 * No event log writes — just in-memory status tracking for /api/logs/error-rates.
 */
export function withApiLogging(handler: RouteHandler): RouteHandler {
  return async (request: NextRequest, ctx?: unknown): Promise<Response | NextResponse> => {
    const pathname = request.nextUrl.pathname;

    try {
      const response = await handler(request, ctx);
      trackResponse(pathname, response.status);
      return response;
    } catch (err) {
      trackResponse(pathname, 500);
      throw err;
    }
  };
}
