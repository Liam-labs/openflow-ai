import { NextRequest, NextResponse } from 'next/server';

import { requireAuthOrLocal } from '@/lib/api-auth';
import { getProjectById } from '@/lib/config';
import {
  deliveryEvidenceStore,
  DeliveryEvidenceStoreError,
} from '@/lib/delivery-evidence/store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const projectId = request.nextUrl.searchParams.get('project');
  const expectedVersion = request.nextUrl.searchParams.get('version') ?? undefined;
  if (!projectId) {
    return NextResponse.json({ error: 'project is required' }, { status: 400 });
  }

  const project = await getProjectById(projectId);
  if (!project?.path) {
    return NextResponse.json({ error: 'Registered project not found' }, { status: 404 });
  }

  try {
    const resolved = await deliveryEvidenceStore.loadVerificationProfile({
      projectId,
      projectPath: project.path,
      expectedVersion,
    });
    return NextResponse.json(resolved);
  } catch (error) {
    const status = error instanceof DeliveryEvidenceStoreError ? error.statusCode : 500;
    return NextResponse.json(
      { error: status < 500 ? 'Verification profile request rejected' : 'Verification profile unavailable' },
      { status },
    );
  }
}
