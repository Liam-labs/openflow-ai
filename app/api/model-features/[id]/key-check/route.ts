/**
 * GET /api/model-features/<id>/key-check?provider=X  ->  { configured, provider, secretName }
 * Only reads whether a secret exists. It never returns the key and never calls the provider (a live test is a separate button).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { featureById, providerById } from '@/lib/model-features/registry';
import { keyConfigured } from '@/lib/model-features/resolve';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/model-features/[id]/key-check', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  const { id } = await context.params;
  if (!featureById(id)) return NextResponse.json({ error: 'No such feature.', code: 'NOT_FOUND' }, { status: 404 });
  const provider = providerById(request.nextUrl.searchParams.get('provider') || '');
  if (!provider) return NextResponse.json({ error: 'Unknown provider.', code: 'BAD_PROVIDER' }, { status: 400 });
  return NextResponse.json({ configured: keyConfigured(provider.id), provider: provider.id, secretName: provider.secretName });
});
