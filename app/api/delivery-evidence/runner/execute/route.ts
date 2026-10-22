import { NextRequest, NextResponse } from 'next/server';

import { requireAuthOrLocal } from '@/lib/api-auth';
import {
  DeliveryEvidenceRunnerError,
  executeDeliveryEvidenceRunner,
} from '@/lib/delivery-evidence/runner';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid runner request' }, { status: 400 });
  }
  const requestBody = body as Record<string, unknown>;
  if (
    typeof requestBody.descriptorId !== 'string'
    || typeof requestBody.descriptorVersion !== 'string'
    || !Object.hasOwn(requestBody, 'input')
  ) {
    return NextResponse.json({ error: 'Invalid runner request' }, { status: 400 });
  }

  try {
    const result = await executeDeliveryEvidenceRunner({
      descriptorId: requestBody.descriptorId,
      descriptorVersion: requestBody.descriptorVersion,
      input: requestBody.input,
    });
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof DeliveryEvidenceRunnerError ? error.statusCode : 500;
    return NextResponse.json(
      { error: status < 500 ? 'Runner request rejected' : 'Runner execution failed' },
      { status },
    );
  }
}
