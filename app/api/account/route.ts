/**
 * The account owner's profile and sidebar layout.
 *
 * GET /api/account  — { success, profile: { displayName, email, about }, sidebar: { sections,
 *                       collapsedGroups }, routingName, createdAt, updatedAt }
 * PUT /api/account  — change any of profile.displayName / email / about and sidebar.sections /
 *                       collapsedGroups; answers with the same body as GET
 *
 * The scaffolding sync reads GET to render every agent's user-profile.md, so the limits here are the
 * sync's limits (lib/account-profile.ts). Saving a new display name also stamps it on the owner's
 * participant records, in one write through the channel store.
 *
 * Same access as the other settings routes: an API token, localhost or the WebGate tunnel.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { validateAccountPatch } from '@/lib/account-profile';
import { AccountStoreError, readAccount, toAccountResponse, updateAccount } from '@/lib/account-store';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { applyDisplayNameToHumans } from '@/lib/human-identity';

export const dynamic = 'force-dynamic';

function storeFailure(error: unknown): NextResponse {
  if (error instanceof AccountStoreError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  console.error('[Account] unexpected error:', error);
  return NextResponse.json({ success: false, error: 'The account could not be read or saved.' }, { status: 500 });
}

export const GET = tracked('/api/account', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    return NextResponse.json(toAccountResponse(await readAccount()));
  } catch (error) {
    return storeFailure(error);
  }
});

export const PUT = tracked('/api/account', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'The request body is not valid JSON.' }, { status: 400 });
  }

  const checked = validateAccountPatch(body);
  if (!checked.ok) {
    return NextResponse.json(
      { success: false, error: checked.errors.map(e => e.message).join(' '), errors: checked.errors },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await updateAccount(checked.value);
  } catch (error) {
    return storeFailure(error);
  }

  // A name in the request is applied to the owner's participant records even when it equals the stored
  // one, so a save that failed half-way last time repairs itself. It is one write, and none when every
  // record already has the name.
  let humanRecordsUpdated = 0;
  if (checked.value.profile?.displayName !== undefined) {
    const displayName = result.account.profile.displayName;
    try {
      humanRecordsUpdated = await mutateChannels('account:display-name', async data => {
        const changed = applyDisplayNameToHumans(data, displayName);
        if (changed > 0) await saveChannels(data);
        return changed;
      });
    } catch (error) {
      console.error('[Account] display name saved, but the participant records were not updated:', error);
      return NextResponse.json(
        { success: false, profileSaved: true, error: 'Your name was saved, but the channels could not be updated. Save again to retry.' },
        { status: 500 },
      );
    }
  }

  if (result.changedFields.length > 0) {
    console.info(`[Account] updated: ${result.changedFields.join(', ')}${humanRecordsUpdated ? ` (${humanRecordsUpdated} participant records)` : ''}`);
  }
  return NextResponse.json({ ...toAccountResponse(result.account), humanRecordsUpdated });
});
