/**
 * GET /api/auth/session
 *
 * Whether a password is set and whether THIS request is signed in or on the machine itself. Only booleans about the caller's own
 * request; the login page uses it to decide what to show. Open on purpose.
 * ownerCanSetPassword: no password exists yet and this is the tailnet owner on the Serve address, so /login offers the set-password form.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCloudflaredRequest, isLocalRequest } from '@/lib/api-auth';
import { hasPassword, requestHasSession } from '@/lib/dashboard-auth';
import { mayOwnerSetFirstPassword } from '@/lib/tailnet-owner';

export async function GET(request: NextRequest) {
  const [passwordSet, signedIn, ownerCanSetPassword] = await Promise.all([hasPassword(), requestHasSession(request), mayOwnerSetFirstPassword(request)]);
  return NextResponse.json(
    { passwordSet, signedIn, onThisMachine: isLocalRequest(request), viaTunnel: isCloudflaredRequest(request), ownerCanSetPassword },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
