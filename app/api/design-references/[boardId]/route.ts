/** Read-only correlation surface for the reference-discovery execution gate. */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { getDesignReferenceAuthorization } from '@/lib/design-references/store';

export const dynamic = 'force-dynamic';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ boardId: string }> },
) {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  const { boardId } = await params;
  const channelId = request.nextUrl.searchParams.get('channelId') ?? '';
  const revisionText = request.nextUrl.searchParams.get('revision') ?? '';
  const boardFingerprint = request.nextUrl.searchParams.get('fingerprint') ?? '';
  const revision = Number(revisionText);
  if (!ID_RE.test(boardId) || !ID_RE.test(channelId) || !Number.isSafeInteger(revision) || revision < 1
    || !SHA256_RE.test(boardFingerprint)) {
    return NextResponse.json(
      { error: 'boardId, channelId, positive revision, and fingerprint are required' },
      { status: 400 },
    );
  }

  const authorization = await getDesignReferenceAuthorization(boardId, {
    channelId,
    revision,
    boardFingerprint,
  });
  if (!authorization) return NextResponse.json({ error: 'Design reference board not found' }, { status: 404 });
  return NextResponse.json(authorization, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
