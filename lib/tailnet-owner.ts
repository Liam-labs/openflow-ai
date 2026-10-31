/**
 * Is this request the tailnet owner, arriving through Tailscale Serve? Used only to let the owner set the FIRST sign-in password
 * from the real tailnet address (https://<machine>.<tailnet>.ts.net) instead of localhost, so a password manager saves it against
 * the right site. It grants nothing else: see app/api/auth/password/route.ts and app/api/auth/session/route.ts.
 *
 * Why the Tailscale-User-Login header can be trusted here: Serve sets it from the tailnet's own identity of the caller, but any
 * program that can reach port 3000 can also write that header. So the header counts only when ALL of these hold:
 *   - the server's own stamp is running (lib/peer-stamp.ts), so the next check is about the real connection;
 *   - the connection comes from this machine (Serve connects from 127.0.0.1; the stamp is the socket address, never a header);
 *   - the address Serve reports for the caller (last X-Forwarded-For entry) is a tailnet address, and it is not a Funnel request;
 *   - the login is on the owner list.
 * A request from any other address (including the desktop over tailscale0) fails the connection check whatever it writes.
 *
 * Owner list: env DEVFLOW_OWNER_LOGINS (comma separated), else "ownerLogins" in .AppData/dashboard-auth.json, else nobody.
 */
import type { NextRequest } from 'next/server';
import { DataPaths } from './data-paths';
import { readJsonFileStrict } from './data-io';
import { PEER_HEADER, peerStampActive } from './peer-stamp';
import { isTailnetAddress } from './wizards/tailscale-visits';
import { hasPassword, sameOriginForWrites } from './dashboard-auth';

export const DEFAULT_OWNER_LOGINS: string[] = [];

type HeaderReader = { get(name: string): string | null };

function normalise(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase()).filter(Boolean) : [];
}

/** The owner logins in force: environment, then the dashboard-auth file, then the default. */
export async function ownerLogins(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const fromEnv = normalise((env.DEVFLOW_OWNER_LOGINS || '').split(','));
  if (fromEnv.length) return fromEnv;
  try {
    const stored = normalise((await readJsonFileStrict<{ ownerLogins?: unknown }>(DataPaths.dashboardAuth, {})).ownerLogins);
    if (stored.length) return stored;
  } catch {
    // an unreadable file keeps the default: it can only ever name fewer people than the file did, never more
  }
  return DEFAULT_OWNER_LOGINS;
}

export function isLoopbackAddress(ip: string): boolean {
  return ip === '::1' || ip === '127.0.0.1' || /^(?:::ffff:)?127(\.\d{1,3}){3}$/i.test(ip);
}

/** Pure decision on the headers. `stampActive` is whether the server writes the real connection address into PEER_HEADER. */
export function isTailnetOwnerHeaders(headers: HeaderReader, owners: string[], stampActive: boolean): boolean {
  if (!stampActive) return false;
  const peer = (headers.get(PEER_HEADER) || '').trim();
  if (!peer || !isLoopbackAddress(peer)) return false;
  if (headers.get('tailscale-funnel-request') !== null) return false;
  const login = (headers.get('tailscale-user-login') || '').trim().toLowerCase();
  if (!login || !owners.includes(login)) return false;
  const chain = (headers.get('x-forwarded-for') || '').split(',').map((e) => e.trim()).filter(Boolean);
  return chain.length > 0 && isTailnetAddress(chain[chain.length - 1]);
}

/** The request arrived through Tailscale Serve from a device of the tailnet owner, from our own page (not a page on another site). */
export async function isTailnetOwnerRequest(request: NextRequest): Promise<boolean> {
  const ownPage = sameOriginForWrites(request.method, {
    host: request.headers.get('host') || request.nextUrl?.host || null,
    origin: request.headers.get('origin'),
    secFetchSite: request.headers.get('sec-fetch-site'),
  });
  if (!ownPage) return false;
  return isTailnetOwnerHeaders(request.headers, await ownerLogins(), peerStampActive());
}

/** May this request set the first password? Only while no password exists, and only for the tailnet owner. */
export async function mayOwnerSetFirstPassword(request: NextRequest): Promise<boolean> {
  if (!(await isTailnetOwnerRequest(request))) return false;
  return !(await hasPassword());
}
