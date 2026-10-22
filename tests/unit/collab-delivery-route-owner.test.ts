import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ledgerMocks = vi.hoisted(() => ({
  transitionDelivery: vi.fn(),
  releaseDelivery: vi.fn(),
  requeueDelivery: vi.fn(),
  settleTimedOutDelivery: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_path: string, handler: unknown) => handler }));
vi.mock('@/lib/data-io', () => ({
  readJsonFile: vi.fn().mockResolvedValue({
    channels: [{
      id: 'channel-1',
      participants: [{ id: 'roster-agent', type: 'codex' }],
      roster: { agents: [{
        participantId: 'roster-agent',
        status: 'running',
        wrapperPid: 222,
      }] },
    }],
    lastUpdated: '2026-08-04T00:00:00.000Z',
  }),
}));
vi.mock('@/lib/collab-delivery-ledger', () => {
  class DeliveryLedgerConflictError extends Error {}
  return {
    DeliveryLedgerConflictError,
    claimDelivery: vi.fn(),
    getDeliveryRecords: vi.fn(),
    recoverIngestedDelivery: vi.fn(),
    renewDelivery: vi.fn(),
    ...ledgerMocks,
  };
});

import { POST } from '@/app/api/collab/deliveries/route';

function request(action: string): NextRequest {
  return new NextRequest('http://localhost/api/collab/deliveries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action,
      channelId: 'channel-1',
      participantId: 'roster-agent',
      ownerId: 'codex:roster-agent:111',
      recordId: 'record-1',
      leaseId: 'lease-1',
      reason: 'test',
      state: 'submitted',
    }),
  });
}

describe('delivery mutation current-owner fencing', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['transition', 'release', 'requeue', 'settle', 'deadletter'])(
    'rejects superseded wrapper action %s before ledger mutation',
    async (action) => {
      const response = await POST(request(action));
      expect(response.status).toBe(409);
      expect(ledgerMocks.transitionDelivery).not.toHaveBeenCalled();
      expect(ledgerMocks.releaseDelivery).not.toHaveBeenCalled();
      expect(ledgerMocks.requeueDelivery).not.toHaveBeenCalled();
      expect(ledgerMocks.settleTimedOutDelivery).not.toHaveBeenCalled();
    },
  );
});
