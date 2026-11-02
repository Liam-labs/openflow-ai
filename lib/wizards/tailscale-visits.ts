/**
 * "Did a second device open it, and was it turned away?" for the Tailscale wizard. Every page request goes through /api/auth/gate
 * (asked by middleware); a request that came through Tailscale Serve carries the tailnet address of the device in X-Forwarded-For
 * (and usually the Tailscale-User-Login header). We remember the last few with the gate's answer, in memory (they matter for
 * minutes, and a restart forgetting them is fine). Names and addresses only.
 *
 * This is the only honest proof that the sign-in holds: a request from this computer's own tailnet address counts as this computer.
 */

import { emitWizardChanged } from './events';

export interface Visit { at: number; device: string; user: string | null; /** the gate let this request see the pages */ allowed: boolean; authenticated?: boolean }

const MAX = 20;

function store(): Visit[] {
  const g = globalThis as { __devflowTailnetVisits?: Visit[] };
  return (g.__devflowTailnetVisits ??= []);
}

/** A tailnet address: 100.64.0.0/10 or the fd7a:115c:a1e0::/48 range. */
export function isTailnetAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(ip);
}

export function noteTailnetVisit(headers: { get(name: string): string | null }, allowed: boolean, now = Date.now(), authenticated = false): void {
  const user = headers.get('tailscale-user-login');
  const chain = (headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Middleware appends its kernel-stamped loopback proxy peer. The preceding
  // final non-loopback hop remains the device, not any client-supplied first hop.
  while (chain.length > 1 && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(chain[chain.length - 1])) chain.pop();
  const device = chain[chain.length - 1];
  if (!user && !device) return;
  if (!device || !isTailnetAddress(device)) return;
  const visits = store();
  const last = visits[visits.length - 1];
  visits.push({ at: now, device, user: user ? user.slice(0, 120) : null, allowed, authenticated });
  if (visits.length > MAX) visits.splice(0, visits.length - MAX);
  // Tell the open wizard once per change: a new device, or the same device whose answer changed, or one quiet for over 30 s. Every page
  // request comes through here, so repeats from the same device are not events. No user name travels with the event.
  const repeat = last && last.device === device && last.allowed === allowed && !!last.authenticated === authenticated && now - last.at < 30_000;
  if (!repeat) emitWizardChanged('tailscale');
}

/** Visits in the last `withinMs` from a device that is not one of `ownAddresses` (the wizard's own test comes from this computer). */
export function recentOtherDeviceVisits(ownAddresses: string[], withinMs = 10 * 60 * 1000, now = Date.now()): Visit[] {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  return store().filter((v) => now - v.at <= withinMs && !own.has(v.device.toLowerCase()));
}

export function clearVisitsForTests(): void { store().length = 0; }
