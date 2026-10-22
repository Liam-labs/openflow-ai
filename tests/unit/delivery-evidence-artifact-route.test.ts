import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const storeMocks = vi.hoisted(() => ({
  readArtifact: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/delivery-evidence/store', () => ({
  deliveryEvidenceStore: storeMocks,
  DeliveryEvidenceStoreError: class DeliveryEvidenceStoreError extends Error {
    constructor(message: string, public readonly code: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));

import { requireAuthOrLocal } from '@/lib/api-auth';
import { deliveryEvidenceStore, DeliveryEvidenceStoreError } from '@/lib/delivery-evidence/store';
import { GET as getArtifact } from '@/app/api/delivery-evidence/artifact/route';

function artifactRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/delivery-evidence/artifact${query}`);
}

describe('GET /api/delivery-evidence/artifact', () => {
  beforeEach(() => {
    vi.mocked(requireAuthOrLocal).mockReset();
    vi.mocked(requireAuthOrLocal).mockResolvedValue(null);
    storeMocks.readArtifact.mockReset();
  });

  it('requires read scope', async () => {
    storeMocks.readArtifact.mockResolvedValue({
      data: Buffer.from('png-bytes'),
      sha256: 'abc',
      byteSize: 9,
    });
    const request = artifactRequest('?projectId=devflow&receiptId=receipt-1&file=shot.png');
    await getArtifact(request);
    expect(requireAuthOrLocal).toHaveBeenCalledWith(request, 'read');
  });

  it('returns auth denial before touching the store', async () => {
    const { NextResponse } = await import('next/server');
    vi.mocked(requireAuthOrLocal).mockResolvedValue(
      NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    );
    const request = artifactRequest('?projectId=devflow&receiptId=receipt-1&file=shot.png');
    const response = await getArtifact(request);
    expect(response.status).toBe(401);
    expect(storeMocks.readArtifact).not.toHaveBeenCalled();
  });

  it('rejects a request missing required query params', async () => {
    const response = await getArtifact(artifactRequest('?projectId=devflow&receiptId=receipt-1'));
    expect(response.status).toBe(400);
    expect(storeMocks.readArtifact).not.toHaveBeenCalled();
  });

  it('serves the artifact bytes with a content type derived from the extension', async () => {
    storeMocks.readArtifact.mockResolvedValue({
      data: Buffer.from('png-bytes'),
      sha256: 'abc',
      byteSize: 9,
    });
    const response = await getArtifact(
      artifactRequest('?projectId=devflow&receiptId=receipt-1&file=shot.png'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(storeMocks.readArtifact).toHaveBeenCalledWith({
      projectId: 'devflow',
      receiptId: 'receipt-1',
      fileName: 'shot.png',
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.toString()).toBe('png-bytes');
  });

  it('serves json artifacts with an application/json content type', async () => {
    storeMocks.readArtifact.mockResolvedValue({
      data: Buffer.from('{"ok":true}'),
      sha256: 'abc',
      byteSize: 11,
    });
    const response = await getArtifact(
      artifactRequest('?projectId=devflow&receiptId=receipt-1&file=console.json'),
    );
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('maps a store not-found error to 404 without leaking internals', async () => {
    storeMocks.readArtifact.mockRejectedValue(
      new DeliveryEvidenceStoreError('Artifact not found', 'DELIVERY_EVIDENCE_ARTIFACT_NOT_FOUND', 404),
    );
    const response = await getArtifact(
      artifactRequest('?projectId=devflow&receiptId=receipt-1&file=missing.png'),
    );
    expect(response.status).toBe(404);
  });

  it('maps an unexpected error to 500', async () => {
    storeMocks.readArtifact.mockRejectedValue(new Error('disk on fire'));
    const response = await getArtifact(
      artifactRequest('?projectId=devflow&receiptId=receipt-1&file=shot.png'),
    );
    expect(response.status).toBe(500);
  });
});
