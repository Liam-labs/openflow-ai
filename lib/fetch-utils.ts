import { NextResponse } from 'next/server';

/**
 * validateBodySize — checks Content-Length header before body parsing.
 * Apply to high-risk POST endpoints to reject oversized payloads early.
 *
 * Returns a 413 NextResponse if the payload exceeds maxBytes, or null if OK.
 * Note: relies on Content-Length header; use as a defence-in-depth guard.
 *
 * @param request  - Incoming NextRequest or Request
 * @param maxBytes - Size limit in bytes (default: 1_000_000 = 1MB)
 */
export function validateBodySize(
  request: Request,
  maxBytes = 1_000_000
): NextResponse | null {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxBytes) {
      return NextResponse.json(
        { success: false, error: `Request body too large (max ${maxBytes} bytes)` },
        { status: 413 }
      );
    }
  }
  return null;
}

/**
 * fetchWithTimeout — wraps fetch() with a configurable AbortSignal timeout.
 *
 * Use for external HTTP calls (non-localhost) to prevent indefinitely hanging requests.
 * Internal localhost calls do not need this guard.
 *
 * @param url      - Fetch URL (string, URL, or Request)
 * @param options  - Standard RequestInit options
 * @param timeoutMs - Timeout in milliseconds (default: 10_000)
 */
export async function fetchWithTimeout(
  url: string | URL | Request,
  options: RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}
