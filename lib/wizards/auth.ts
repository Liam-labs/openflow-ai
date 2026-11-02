import type { NextRequest } from 'next/server';
import { requireTokenOrLocal } from '@/lib/api-auth';
import { requestHasSession } from '@/lib/dashboard-auth';

/** Wizard administration accepts the owner password session, with same-origin writes.
 * Keep the stricter global guard unchanged: tunnel headers alone confer no authority.
 */
export async function requireWizardAccess(request: NextRequest) {
  if (await requestHasSession(request)) return null;
  return requireTokenOrLocal(request, 'admin');
}
