/**
 * The address of the computer on the other end of the connection, written by the server itself.
 *
 * Next.js copies the caller's own `X-Forwarded-For` header through unchanged and only fills it in when the caller sent none, so
 * that header can never prove where a request came from: anybody on the network can write "X-Forwarded-For: 127.0.0.1".
 * What cannot be faked is the connection. This module adds two headers to every incoming request before Next.js sees it, after
 * deleting any copy the caller sent:
 *   x-openflow-peer          the socket's remote address (what the operating system reports)
 *   x-openflow-http-version  "1.0" or "1.1": a plain reverse proxy (nginx by default) talks HTTP/1.0 to the app, a browser or a
 *                            script does not, so a "local" caller speaking 1.0 is a proxy in front of us, not the owner
 * lib/api-auth.ts trusts "this machine" only when the peer is this machine (or an opted-in tailnet peer).
 *
 * Installed once from instrumentation.ts. If it cannot be installed, the caller turns local trust off for the whole process.
 */
import http from 'http';
import https from 'https';

export const PEER_HEADER = 'x-openflow-peer';
export const HTTP_VERSION_HEADER = 'x-openflow-http-version';
const ACTIVE = Symbol.for('openflow.peerStampActive');
const PATCHED = Symbol.for('openflow.peerStampPatched');

type Emitter = { emit: (event: string | symbol, ...args: unknown[]) => boolean } & { [PATCHED]?: boolean };
type IncomingLike = { headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string }; httpVersion?: string };

/** Write the two headers onto one incoming request. Exported for tests. */
export function stampRequest(req: IncomingLike): void {
  if (!req || !req.headers) return;
  req.headers[PEER_HEADER] = req.socket?.remoteAddress || '';
  req.headers[HTTP_VERSION_HEADER] = req.httpVersion || '';
}

function patch(proto: Emitter): void {
  if (proto[PATCHED]) return;
  const original = proto.emit;
  proto.emit = function patchedEmit(this: unknown, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'request' || event === 'upgrade') stampRequest(args[0] as IncomingLike);
    return original.call(this, event, ...args);
  };
  proto[PATCHED] = true;
}

/** Start stamping every request of every http and https server in this process. */
export function installPeerStamp(): void {
  patch(http.Server.prototype as unknown as Emitter);
  patch(https.Server.prototype as unknown as Emitter);
  (globalThis as Record<symbol, unknown>)[ACTIVE] = true;
}

/** True once installPeerStamp has run in this process (Next.js loads modules once per bundle, so the flag lives on globalThis). */
export function peerStampActive(): boolean {
  return (globalThis as Record<symbol, unknown>)[ACTIVE] === true;
}

/** Test helper: forget that stamping is on. */
export function resetPeerStampForTests(): void {
  delete (globalThis as Record<symbol, unknown>)[ACTIVE];
}
