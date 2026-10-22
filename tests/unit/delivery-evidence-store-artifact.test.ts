import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDeliveryEvidenceStore, DeliveryEvidenceStoreError } from '@/lib/delivery-evidence/store';

describe('deliveryEvidenceStore.readArtifact', () => {
  let rootDir: string;
  let store: ReturnType<typeof createDeliveryEvidenceStore>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-evidence-artifact-'));
    store = createDeliveryEvidenceStore({ rootDir });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('reads back exactly what writeArtifact persisted', async () => {
    const written = await store.writeArtifact({
      projectId: 'devflow',
      receiptId: 'receipt-1',
      artifactId: 'screenshot-abc',
      extension: 'png',
      data: Buffer.from('fake-png-bytes'),
    });

    const read = await store.readArtifact({
      projectId: 'devflow',
      receiptId: 'receipt-1',
      fileName: 'screenshot-abc.png',
    });

    expect(read.data.toString()).toBe('fake-png-bytes');
    expect(read.sha256).toBe(written.sha256);
    expect(read.byteSize).toBe(written.byteSize);
  });

  it('throws DELIVERY_EVIDENCE_ARTIFACT_NOT_FOUND for a missing artifact', async () => {
    await expect(
      store.readArtifact({ projectId: 'devflow', receiptId: 'receipt-1', fileName: 'missing.png' }),
    ).rejects.toMatchObject({ code: 'DELIVERY_EVIDENCE_ARTIFACT_NOT_FOUND', statusCode: 404 });
  });

  it('rejects a fileName that attempts path traversal', async () => {
    await expect(
      store.readArtifact({
        projectId: 'devflow',
        receiptId: 'receipt-1',
        fileName: '../../../../etc/passwd',
      }),
    ).rejects.toBeInstanceOf(DeliveryEvidenceStoreError);
  });

  it('rejects a projectId that attempts path traversal', async () => {
    await expect(
      store.readArtifact({
        projectId: '../outside',
        receiptId: 'receipt-1',
        fileName: 'shot.png',
      }),
    ).rejects.toMatchObject({ code: 'DELIVERY_EVIDENCE_INVALID_STORAGE_ID' });
  });
});
