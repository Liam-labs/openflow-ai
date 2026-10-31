/**
 * "Did a second device open it, and was it turned away?" for the Tailscale wizard. Every page request goes through /api/auth/gate
 * (asked by middleware); a request that came through Tailscale Serve carries the tailnet address of the device in X-Forwarded-For
 * (and usually the Tailscale-User-Login header). We remember the last few with the gate's answer, in memory (they matter for
 * minutes, and a restart forgetting them is fine). Names and addresses only.
 *
 * This is the only honest proof that the sign-in holds: a request from this computer's own tailnet address counts as this computer.
 */

export interface Visit { at: number; device: string; user: string | null; /** the gate let this request see the pages */ allowed: boolean }

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

export function noteTailnetVisit(headers: { get(name: string): string | null }, allowed: boolean, now = Date.now()): void {
  const user = headers.get('tailscale-user-login');
  const chain = (headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const device = chain[chain.length - 1];
  if (!user && !device) return;
  if (!device || !isTailnetAddress(device)) return;
  const visits = store();
  visits.push({ at: now, device, user: user ? user.slice(0, 120) : null, allowed });
  if (visits.length > MAX) visits.splice(0, visits.length - MAX);
}

/** Visits in the last `withinMs` from a device that is not one of `ownAddresses` (the wizard's own test comes from this computer). */
export function recentOtherDeviceVisits(ownAddresses: string[], withinMs = 10 * 60 * 1000, now = Date.now()): Visit[] {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  return store().filter((v) => now - v.at <= withinMs && !own.has(v.device.toLowerCase()));
}

export function clearVisitsForTests(): void { store().length = 0; }
