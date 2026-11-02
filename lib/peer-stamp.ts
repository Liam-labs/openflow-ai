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
 *   x-openflow-peer-uid      on Linux, the Linux user that owns the CLIENT end of the connection when that end is on this machine
 *                            (read from /proc/net/tcp and tcp6, where the kernel lists every socket with its owner), else empty.
 *                            Server agents run as their own user (devflow-agent): from this machine is not the owner unless the
 *                            caller is the user DevFlow runs as (task 82b8d491, 30 Oct 2026)
 * lib/api-auth.ts trusts "this machine" only when the peer is this machine (or an opted-in tailnet peer).
 *
 * Installed once from instrumentation.ts. If it cannot be installed, the caller turns local trust off for the whole process.
 */
import { readFileSync } from 'fs';
import http from 'http';
import https from 'https';

export const PEER_HEADER = 'x-openflow-peer';
export const HTTP_VERSION_HEADER = 'x-openflow-http-version';
export const PEER_UID_HEADER = 'x-openflow-peer-uid';
const ACTIVE = Symbol.for('openflow.peerStampActive');
const PATCHED = Symbol.for('openflow.peerStampPatched');

type Emitter = { emit: (event: string | symbol, ...args: unknown[]) => boolean } & { [PATCHED]?: boolean };
type SocketLike = { remoteAddress?: string; remotePort?: number; localAddress?: string; localPort?: number };
type IncomingLike = { headers?: Record<string, string | string[] | undefined>; socket?: SocketLike; httpVersion?: string };

/**
 * An address as 16 bytes (IPv4 as IPv4-mapped IPv6), as text "b0.b1....b15", so the kernel's form and Node's form compare equal.
 * From /proc/net/tcp (8 hex digits) or tcp6 (32): each 32-bit word is in host (little-endian) byte order. '' when malformed.
 */
export function procAddressKey(hex: string): string {
  if (!/^(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{32})$/.test(hex)) return '';
  const bytes: number[] = [];
  for (let w = 0; w < hex.length; w += 8) for (const i of [6, 4, 2, 0]) bytes.push(parseInt(hex.slice(w + i, w + i + 2), 16));
  return (bytes.length === 4 ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...bytes] : bytes).join('.');
}

/** The same key for an address as Node reports it ("127.0.0.1", "::1", "::ffff:127.0.0.1", "fe80::1"). '' when malformed. */
export function socketAddressKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip);
  if (v4) {
    const b = v4.slice(1).map(Number);
    return b.every(x => x <= 255) ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...b].join('.') : '';
  }
  const bare = ip.split('%')[0].toLowerCase();
  if (!/^[0-9a-f:]+$/.test(bare) || (bare.match(/::/g) || []).length > 1) return '';
  const [head, tail] = bare.includes('::') ? bare.split('::') : [bare, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? 0 : 8 - h.length - t.length;
  if (fill < 0) return '';
  const groups = [...h, ...Array(fill).fill('0'), ...t];
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return '';
  return groups.flatMap(g => { const n = parseInt(g, 16); return [n >> 8, n & 0xff]; }).join('.');
}

/**
 * The owner (uid) of the client socket of one connection, from the kernel's socket tables, or '' when the client is not on this machine
 * (or the tables cannot be read). The client socket is the line whose local end is the caller's address and port and whose remote end is ours.
 */
export function findClientUid(tables: string[], socket: SocketLike): string {
  const { remoteAddress, remotePort, localAddress, localPort } = socket;
  if (!remoteAddress || !localAddress || !remotePort || !localPort) return '';
  const client = socketAddressKey(remoteAddress);
  const server = socketAddressKey(localAddress);
  if (!client || !server) return '';
  for (const table of tables) {
    for (const line of table.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 8 || !/^\d+:$/.test(f[0])) continue;
      const [la, lp] = f[1].split(':');
      const [ra, rp] = f[2].split(':');
      if (parseInt(lp, 16) !== remotePort || parseInt(rp, 16) !== localPort) continue;
      if (procAddressKey(la) !== client || procAddressKey(ra) !== server) continue;
      if (/^\d+$/.test(f[7])) return f[7];
    }
  }
  return '';
}

const PROC_TABLES = ['/proc/net/tcp', '/proc/net/tcp6'];
const uidOfSocket = new WeakMap<object, string>();

/** The client socket's owner, read once per connection (a keep-alive connection carries many requests). Linux only: elsewhere ''. */
function clientUid(socket: SocketLike | undefined): string {
  if (!socket || process.platform !== 'linux') return '';
  const known = uidOfSocket.get(socket);
  if (known !== undefined) return known;
  const tables: string[] = [];
  for (const file of PROC_TABLES) {
    try { tables.push(readFileSync(file, 'latin1')); } catch { /* no IPv6 table on this kernel */ }
  }
  const uid = findClientUid(tables, socket);
  uidOfSocket.set(socket, uid);
  return uid;
}

/** Write the three headers onto one incoming request. Exported for tests. */
export function stampRequest(req: IncomingLike, lookupUid: (socket: SocketLike | undefined) => string = clientUid): void {
  if (!req || !req.headers) return;
  req.headers[PEER_HEADER] = req.socket?.remoteAddress || '';
  req.headers[HTTP_VERSION_HEADER] = req.httpVersion || '';
  let uid = '';
  try { uid = lookupUid(req.socket); } catch { uid = ''; }
  req.headers[PEER_UID_HEADER] = uid;
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
