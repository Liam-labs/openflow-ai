import { NextRequest, NextResponse } from 'next/server';

import { requireAuthOrLocal } from '@/lib/api-auth';
import {
  deliveryEvidenceStore,
  DeliveryEvidenceStoreError,
} from '@/lib/delivery-evidence/store';

export const dynamic = 'force-dynamic';

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  json: 'application/json',
  txt: 'text/plain',
};

function contentTypeForFile(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export async function GET(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const projectId = request.nextUrl.searchParams.get('projectId');
  const receiptId = request.nextUrl.searchParams.get('receiptId');
  const file = request.nextUrl.searchParams.get('file');
  if (!projectId || !receiptId || !file) {
    return NextResponse.json(
      { error: 'projectId, receiptId, and file are required' },
      { status: 400 },
    );
  }

  try {
    const artifact = await deliveryEvidenceStore.readArtifact({
      projectId,
      receiptId,
      fileName: file,
    });
    return new NextResponse(new Uint8Array(artifact.data), {
      status: 200,
      headers: {
        'Content-Type': contentTypeForFile(file),
        'Content-Length': String(artifact.byteSize),
        // Artifacts are immutable once written (store.writeArtifact uses an
        // exclusive create), so the same URL always resolves to the same bytes.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    const status = error instanceof DeliveryEvidenceStoreError ? error.statusCode : 500;
    return NextResponse.json(
      { error: status < 500 ? 'Artifact request rejected' : 'Artifact storage unavailable' },
      { status },
    );
  }
}
