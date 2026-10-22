/** Runtime-facing durable collab delivery ledger. */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import {
  DeliveryLedgerConflictError,
  claimDelivery,
  getDeliveryRecords,
  recoverIngestedDelivery,
  renewDelivery,
  requeueDelivery,
  releaseDelivery,
  settleTimedOutDelivery,
  transitionDelivery,
} from '@/lib/collab-delivery-ledger';
import { resolveCurrentDeliveryOwnerId } from '@/lib/collab-delivery-owner';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import type { CollabChannelsData } from '@/lib/types';

export const dynamic = 'force-dynamic';

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
    throw new TypeError(`${key} must be a non-empty string of at most 500 characters`);
  }
  return value;
}

async function assertCurrentOwner(
  channelId: string,
  participantId: string,
  ownerId: string,
): Promise<void> {
  const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, {
    channels: [],
    lastUpdated: new Date(0).toISOString(),
  });
  const currentOwnerId = resolveCurrentDeliveryOwnerId(data, channelId, participantId);
  if (!currentOwnerId || currentOwnerId !== ownerId) {
    throw new DeliveryLedgerConflictError('Delivery owner is not the participant current wrapper');
  }
}

async function resolveMutationScope(body: Record<string, unknown>): Promise<{
  channelId: string;
  participantId: string;
  recordId: string;
}> {
  const recordId = requiredString(body, 'recordId');
  if (typeof body.channelId === 'string' && typeof body.participantId === 'string') {
    return { channelId: body.channelId, participantId: body.participantId, recordId };
  }
  // Rolling-deploy compatibility: older wrappers do not send scope fields on
  // mutation. Resolve them from the server-owned record, then apply the same
  // current-wrapper fence. Never trust a client-supplied partial tuple.
  const [record] = await getDeliveryRecords({ recordId, includeHandled: true });
  if (!record) throw new DeliveryLedgerConflictError('Delivery record not found');
  return { channelId: record.channelId, participantId: record.participantId, recordId };
}

export const GET = tracked('/api/collab/deliveries', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const records = await getDeliveryRecords({
    channelId: request.nextUrl.searchParams.get('channelId') || undefined,
    participantId: request.nextUrl.searchParams.get('participantId') || undefined,
    messageId: request.nextUrl.searchParams.get('messageId') || undefined,
    includeHandled: request.nextUrl.searchParams.get('includeHandled') === '1',
  });
  return NextResponse.json({ records });
});

export const POST = tracked('/api/collab/deliveries', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const action = requiredString(body, 'action');
    if (action === 'claim') {
      const channelId = requiredString(body, 'channelId');
      const participantId = requiredString(body, 'participantId');
      const ownerId = requiredString(body, 'ownerId');
      await assertCurrentOwner(channelId, participantId, ownerId);
      const requestedLeaseMs = typeof body.leaseMs === 'number' ? body.leaseMs : undefined;
      const leaseMs = requestedLeaseMs === undefined
        ? undefined
        : Math.min(Math.max(Math.floor(requestedLeaseMs), 5_000), 120_000);
      const record = await claimDelivery({
        channelId,
        participantId,
        ownerId,
        messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
        leaseMs,
      });
      return NextResponse.json({ record });
    }

    if (action === 'recover') {
      const channelId = requiredString(body, 'channelId');
      const participantId = requiredString(body, 'participantId');
      const ownerId = requiredString(body, 'ownerId');
      await assertCurrentOwner(channelId, participantId, ownerId);
      const record = await recoverIngestedDelivery({
        channelId,
        participantId,
        ownerId,
        leaseMs: 30_000,
      });
      return NextResponse.json({ record });
    }

    if (action === 'renew') {
      const channelId = requiredString(body, 'channelId');
      const participantId = requiredString(body, 'participantId');
      const ownerId = requiredString(body, 'ownerId');
      await assertCurrentOwner(channelId, participantId, ownerId);
      const record = await renewDelivery({
        channelId,
        participantId,
        recordId: requiredString(body, 'recordId'),
        leaseId: requiredString(body, 'leaseId'),
        ownerId,
        leaseMs: 30_000,
      });
      return NextResponse.json({ record });
    }

    if (action === 'transition') {
      const { channelId, participantId, recordId } = await resolveMutationScope(body);
      const ownerId = requiredString(body, 'ownerId');
      await assertCurrentOwner(channelId, participantId, ownerId);
      const state = requiredString(body, 'state');
      if (state !== 'submitted' && state !== 'ingested' && state !== 'handled') {
        return NextResponse.json({ error: 'state must be submitted, ingested, or handled' }, { status: 400 });
      }
      const record = await transitionDelivery({
        channelId,
        participantId,
        recordId,
        leaseId: requiredString(body, 'leaseId'),
        ownerId,
        state,
        transcriptPath: typeof body.transcriptPath === 'string' ? body.transcriptPath : undefined,
        transcriptByte: typeof body.transcriptByte === 'number' ? body.transcriptByte : undefined,
      });
      return NextResponse.json({ record });
    }

    if (action === 'release' || action === 'requeue' || action === 'settle' || action === 'deadletter') {
      const { channelId, participantId, recordId } = await resolveMutationScope(body);
      const ownerId = requiredString(body, 'ownerId');
      await assertCurrentOwner(channelId, participantId, ownerId);
      const reason = requiredString(body, 'reason');
      const input = {
        channelId,
        participantId,
        recordId,
        leaseId: requiredString(body, 'leaseId'),
        ownerId,
        reason,
      };
      // Ambiguous accepted submits must neither replay nor report success.
      // The ledger implementation moves them into visible dead-letter state.
      if (action === 'settle' || action === 'deadletter' || reason === 'jsonl_ingestion_timeout') {
        const record = await settleTimedOutDelivery({ ...input, reason });
        return NextResponse.json({ record });
      }
      const record = action === 'release'
        ? await releaseDelivery(input)
        : await requeueDelivery(input);
      return NextResponse.json({ record });
    }

    return NextResponse.json({ error: 'Unknown delivery action' }, { status: 400 });
  } catch (error) {
    if (error instanceof TypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DeliveryLedgerConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error('[CollabDeliveries] Request failed:', error);
    return NextResponse.json({ error: 'Delivery ledger operation failed' }, { status: 500 });
  }
});
