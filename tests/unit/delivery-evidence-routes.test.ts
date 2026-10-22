import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const storeMocks = vi.hoisted(() => ({
  writeReceipt: vi.fn(),
  readReceipt: vi.fn(),
  findReceiptById: vi.fn(),
  loadVerificationProfile: vi.fn(),
}));

const runnerMocks = vi.hoisted(() => ({
  executeDeliveryEvidenceRunner: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/delivery-evidence/store', () => ({
  deliveryEvidenceStore: storeMocks,
  DeliveryEvidenceStoreError: class DeliveryEvidenceStoreError extends Error {},
}));

vi.mock('@/lib/delivery-evidence/runner', () => ({
  executeDeliveryEvidenceRunner: runnerMocks.executeDeliveryEvidenceRunner,
  DeliveryEvidenceRunnerError: class DeliveryEvidenceRunnerError extends Error {},
}));

vi.mock('@/lib/config', () => ({
  getProjectById: configMocks.getProjectById,
}));

import { requireAuthOrLocal } from '@/lib/api-auth';
import { GET as getProfile } from '@/app/api/delivery-evidence/profile/route';
import { GET as getReceipt, POST as postReceipt } from '@/app/api/delivery-evidence/receipt/route';
import { POST as executeRunner } from '@/app/api/delivery-evidence/runner/execute/route';
import { POST as runVisualReview } from '@/app/api/delivery-evidence/visual-review/run/route';

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Delivery Evidence API authentication', () => {
  beforeEach(() => {
    vi.mocked(requireAuthOrLocal).mockReset();
    vi.mocked(requireAuthOrLocal).mockResolvedValue(null);
    Object.values(storeMocks).forEach((mock) => mock.mockReset());
    runnerMocks.executeDeliveryEvidenceRunner.mockReset();
    configMocks.getProjectById.mockReset();
  });

  it('protects receipt reads with read scope and writes with write scope', async () => {
    storeMocks.readReceipt.mockResolvedValue({ id: 'receipt-1' });
    storeMocks.writeReceipt.mockResolvedValue({ id: 'receipt-1' });

    const readRequest = new NextRequest(
      'http://localhost:3000/api/delivery-evidence/receipt?projectId=devflow&id=receipt-1',
    );
    await getReceipt(readRequest);
    expect(requireAuthOrLocal).toHaveBeenCalledWith(readRequest, 'read');

    const writeRequest = jsonRequest(
      'http://localhost:3000/api/delivery-evidence/receipt',
      { id: 'receipt-1' },
    );
    await postReceipt(writeRequest);
    expect(requireAuthOrLocal).toHaveBeenCalledWith(writeRequest, 'write');
  });

  it('protects profile reads with read scope', async () => {
    configMocks.getProjectById.mockResolvedValue({ id: 'devflow', path: '/home/user/DevFlow' });
    storeMocks.loadVerificationProfile.mockResolvedValue({
      profile: { profile: { id: 'devflow-local', version: '1.0.0' } },
      fingerprint: 'a'.repeat(64),
      policyFloorVersion: 'delivery-evidence-floor/v1',
    });
    const request = new NextRequest(
      'http://localhost:3000/api/delivery-evidence/profile?project=devflow',
    );

    await getProfile(request);
    expect(requireAuthOrLocal).toHaveBeenCalledWith(request, 'read');
  });

  it('protects runner and visual-review execution with write scope', async () => {
    runnerMocks.executeDeliveryEvidenceRunner.mockResolvedValue({ success: true });

    const runnerRequest = jsonRequest(
      'http://localhost:3000/api/delivery-evidence/runner/execute',
      { descriptorId: 'playwright.visual-review', descriptorVersion: '1.0.0', input: {} },
    );
    await executeRunner(runnerRequest);
    expect(requireAuthOrLocal).toHaveBeenCalledWith(runnerRequest, 'write');

    const visualRequest = jsonRequest(
      'http://localhost:3000/api/delivery-evidence/visual-review/run',
      {},
    );
    await runVisualReview(visualRequest);
    expect(requireAuthOrLocal).toHaveBeenCalledWith(visualRequest, 'write');
  });

  it('returns auth denial before reading a request body', async () => {
    vi.mocked(requireAuthOrLocal).mockResolvedValue(
      NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    );
    const request = new NextRequest(
      'http://example.invalid/api/delivery-evidence/visual-review/run',
      { method: 'POST', body: 'not-json' },
    );

    const response = await runVisualReview(request);
    expect(response.status).toBe(401);
    expect(runnerMocks.executeDeliveryEvidenceRunner).not.toHaveBeenCalled();
  });
});
