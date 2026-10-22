/**
 * /api/collab/delivery-status — Message delivery tracking
 *
 * Written to by collab-claude.py after inject_message() succeeds or fails.
 *
 * GET  /api/collab/delivery-status?messageId=<id>
 *   Response: { events: DeliveryEvent[] }
 *
 * GET  /api/collab/delivery-status?stats=1[&window=24]
 *   Response: DeliveryStats — rolling N-hour failure rate + breakdown
 *
 * POST /api/collab/delivery-status
 *   Body: { messageId, status: "delivered"|"timeout"|"delivery_failure", ... }
 *   Response: { success: true }
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { withFileLock } from '@/lib/data-io';
import { tracked } from '@/lib/api-tracking';
import { eventBus } from '@/lib/event-bus';
import {
  type DeliveryEvent,
  type DeliveryStatus,
  computeDeliveryStats,
  getTelemetryStorePath,
} from '@/lib/delivery-telemetry';

export const dynamic = 'force-dynamic';

const MAX_ENTRIES = 1000;

async function readStore(): Promise<DeliveryEvent[]> {
  try {
    const raw = await fs.readFile(getTelemetryStorePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeStore(events: DeliveryEvent[]): Promise<void> {
  const storePath = getTelemetryStorePath();
  const tmp = `${storePath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(events, null, 2), 'utf-8');
  await fs.rename(tmp, storePath);
}

export const GET = tracked('/api/collab/delivery-status', async (req: NextRequest) => {
  const authDenied = await requireAuthOrLocal(req, 'read');
  if (authDenied) return authDenied;

  const statsParam = req.nextUrl.searchParams.get('stats');
  if (statsParam) {
    const windowHours = parseInt(req.nextUrl.searchParams.get('window') ?? '24', 10) || 24;
    const events = await readStore();
    const stats = computeDeliveryStats(events, { windowHours });
    return NextResponse.json(stats);
  }

  const messageId = req.nextUrl.searchParams.get('messageId');
  if (!messageId) {
    return NextResponse.json({ error: 'messageId or stats required' }, { status: 400 });
  }
  const events = await readStore();
  const filtered = events.filter(e => e.messageId === messageId);
  return NextResponse.json({ events: filtered });
});

const VALID_STATUSES: DeliveryStatus[] = ['delivered', 'timeout', 'delivery_failure'];

export const POST = tracked('/api/collab/delivery-status', async (req: NextRequest) => {
  const authDenied = await requireAuthOrLocal(req, 'write');
  if (authDenied) return authDenied;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { messageId, status } = body as { messageId?: string; status?: string };
  if (!messageId || !status) {
    return NextResponse.json({ error: 'messageId and status required' }, { status: 400 });
  }
  if (!VALID_STATUSES.includes(status as DeliveryStatus)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      { status: 400 }
    );
  }

  const event: DeliveryEvent = {
    messageId,
    status: status as DeliveryStatus,
    timestamp: (body.timestamp as string) || new Date().toISOString(),
  };
  if (body.participantId) event.participantId = body.participantId as string;
  if (body.agentName) event.agentName = body.agentName as string;
  if (body.channelId) event.channelId = body.channelId as string;
  if (body.elapsedMs !== undefined) event.elapsedMs = body.elapsedMs as number;
  event.receivedAt = new Date().toISOString();
  if (body.verifiedVia === 'jsonl_ingestion') event.verifiedVia = body.verifiedVia;
  if (typeof body.verifyElapsedMs === 'number') event.verifyElapsedMs = body.verifyElapsedMs;
  if (body.failureReason) event.failureReason = body.failureReason as string;
  if (body.wrapperPid !== undefined) event.wrapperPid = body.wrapperPid as number;
  if (body.lastOutputTimeDeltaMs !== undefined) event.lastOutputTimeDeltaMs = body.lastOutputTimeDeltaMs as number;
  if (body.isProcessingAtInject !== undefined) event.isProcessingAtInject = body.isProcessingAtInject as boolean;

  await withFileLock(getTelemetryStorePath(), async () => {
    const events = await readStore();
    events.push(event);
    const trimmed = events.length > MAX_ENTRIES ? events.slice(events.length - MAX_ENTRIES) : events;
    await writeStore(trimmed);
  });

  if (status === 'delivery_failure') {
    eventBus.emitEvent('collab:delivery_failure', event);
  }

  return NextResponse.json({ success: true });
});
