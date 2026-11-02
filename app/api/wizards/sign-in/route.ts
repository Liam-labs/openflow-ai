/**
 * /api/wizards/sign-in: the sign-in wizard (lib/wizards/sign-in.ts).
 *
 * GET   what is set today and what reaches the dashboard from other computers.
 * POST  { action: 'set', password }    choose the password (ends every signed-in browser)
 *       { action: 'prove', password }  sign in through the real routes with it and check the refusals
 *       { action: 'undo' }             forget the password (refused while other computers can reach the dashboard)
 *
 * Only this machine or an admin token: a browser signed in from elsewhere cannot change or remove the password.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireTokenOrLocal } from '@/lib/api-auth';
import { setPassword } from '@/lib/dashboard-auth';
import { proveSignIn, removePassword, signInCheck } from '@/lib/wizards/sign-in';

export const dynamic = 'force-dynamic';

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: NextRequest) {
  const denied = await requireTokenOrLocal(request, 'admin');
  if (denied) return denied;
  return json({ success: true, ...(await signInCheck()) });
}

export async function POST(request: NextRequest) {
  const denied = await requireTokenOrLocal(request, 'admin');
  if (denied) return denied;

  let body: { action?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ success: false, error: 'Send JSON.' }, 400);
  }
  const password = typeof body.password === 'string' ? body.password : '';

  if (body.action === 'set') {
    const result = await setPassword(password);
    return result.ok ? json({ success: true }) : json({ success: false, error: result.error }, 400);
  }

  if (body.action === 'prove') {
    if (!password) return json({ success: false, error: 'Enter the password to test it.' }, 400);
    // Always this server's own address: the Host of the request must not decide where the password is sent.
    const port = process.env.PORT || 3000;
    const origin = `http://127.0.0.1:${port}`;
    const result = await proveSignIn(password, origin, (path, init) => fetch(`${origin}${path}`, { ...init, cache: 'no-store' }));
    return json({ success: true, ...result });
  }

  if (body.action === 'undo') {
    const result = await removePassword();
    return result.ok ? json({ success: true }) : json({ success: false, error: result.reason }, 409);
  }

  return json({ success: false, error: 'Unknown action.' }, 400);
}
