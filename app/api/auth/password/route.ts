/**
 * POST /api/auth/password  { newPassword }
 *
 * Set or replace the owner password. Only from this machine or with an admin token: a signed-in browser elsewhere cannot change
 * it, so a stolen session cannot lock the owner out. Changing it ends every session.
 * One more door, for the FIRST password only: the tailnet owner arriving through Tailscale Serve on the real tailnet address
 * (lib/tailnet-owner.ts), so a password manager saves it against that site. Once a password exists it is closed again.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireTokenOrLocal } from '@/lib/api-auth';
import { setFirstPassword, setPassword } from '@/lib/dashboard-auth';
import { mayOwnerSetFirstPassword } from '@/lib/tailnet-owner';

export async function POST(request: NextRequest) {
  const denied = await requireTokenOrLocal(request, 'admin');
  const firstOnly = !!denied;      // let in by the first-password door, not by a token or this machine
  if (denied && !(await mayOwnerSetFirstPassword(request))) return denied;

  let newPassword: unknown;
  try {
    newPassword = ((await request.json()) as { newPassword?: unknown }).newPassword;
  } catch {
    return NextResponse.json({ error: 'Send the new password as JSON.' }, { status: 400 });
  }
  const text = typeof newPassword === 'string' ? newPassword : '';
  const result = firstOnly ? await setFirstPassword(text) : await setPassword(text);      // the first-password door saves only if still none, under one lock
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 'taken' in result && result.taken ? 409 : 400 });
  return NextResponse.json({ ok: true });
}
