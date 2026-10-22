import { NextRequest, NextResponse } from 'next/server';

import { requireAuthOrLocal } from '@/lib/api-auth';
import { visualReviewRunDescriptor } from '@/lib/delivery-evidence/descriptors';
import {
  DeliveryEvidenceRunnerError,
  executeDeliveryEvidenceRunner,
} from '@/lib/delivery-evidence/runner';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }

  try {
    const result = await executeDeliveryEvidenceRunner({
      descriptorId: visualReviewRunDescriptor.id,
      descriptorVersion: visualReviewRunDescriptor.version,
      input,
    });
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof DeliveryEvidenceRunnerError ? error.statusCode : 500;
    return NextResponse.json(
      { error: status < 500 ? 'Visual Review request rejected' : 'Visual Review execution failed' },
      { status },
    );
  }
}
