/**
 * /api/setup/key-store: "Where should OpenFlow keep your keys?"
 *
 * GET  { choice, active: { kind, encrypted }, options }  what is chosen, what the app really uses, and the options to show.
 * POST { store }  save the choice. Only an option that is available can be saved.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { resolveSecretStore } from '@/lib/secret-store';
import { KEY_STORE_OPTIONS, isAvailableChoice, readKeyStoreChoice, saveKeyStoreChoice } from '@/lib/key-store-choice';

export const dynamic = 'force-dynamic';

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function activeStore(): { kind: string; encrypted: boolean } {
  try {
    const kind = resolveSecretStore().kind;
    return { kind, encrypted: kind === 'file' };
  } catch {
    return { kind: 'unknown', encrypted: false };
  }
}

export const GET = tracked('/api/setup/key-store', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  return json({ success: true, choice: await readKeyStoreChoice(), active: activeStore(), options: KEY_STORE_OPTIONS });
});

export const POST = tracked('/api/setup/key-store', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  let body: { store?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ success: false, error: 'Send JSON.' }, 400);
  }
  if (!isAvailableChoice(body.store)) return json({ success: false, error: 'That choice is not available yet.' }, 400);
  await saveKeyStoreChoice(body.store);
  return json({ success: true, choice: body.store });
});
