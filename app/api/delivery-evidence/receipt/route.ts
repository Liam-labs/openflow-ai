import { NextRequest, NextResponse } from 'next/server';

import { requireAuthOrLocal } from '@/lib/api-auth';
import {
  deliveryEvidenceStore,
  DeliveryEvidenceStoreError,
} from '@/lib/delivery-evidence/store';

export const dynamic = 'force-dynamic';

function storeErrorResponse(error: unknown): NextResponse {
  const status = error instanceof DeliveryEvidenceStoreError ? error.statusCode : 500;
  return NextResponse.json(
    { error: status < 500 ? 'Receipt request rejected' : 'Receipt storage unavailable' },
    { status },
  );
}

export async function GET(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const projectId = request.nextUrl.searchParams.get('projectId');
  const receiptId = request.nextUrl.searchParams.get('id');
  if (!receiptId) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  try {
    const receipt = projectId
      ? await deliveryEvidenceStore.readReceipt(projectId, receiptId)
      : await deliveryEvidenceStore.findReceiptById(receiptId);
    return NextResponse.json(receipt);
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }

  try {
    const receipt = await deliveryEvidenceStore.writeReceipt(body);
    return NextResponse.json(receipt, { status: 201 });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
