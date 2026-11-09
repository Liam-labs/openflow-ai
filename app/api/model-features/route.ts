/**
 * GET /api/model-features
 * Every model feature with the person's choice, the recommendation, what it sends, and which providers have a key.
 * It never returns a key. Switching a feature on or off is PUT /api/model-features/<id>.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { FEATURES, PROVIDERS } from '@/lib/model-features/registry';
import { readSettings, OFF } from '@/lib/model-features/store';
import { keyConfigured } from '@/lib/model-features/resolve';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/model-features', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  try {
    const settings = await readSettings();
    const providers = PROVIDERS.map((p) => ({ id: p.id, label: p.label, local: p.secretName === null, linked: keyConfigured(p.id) }));
    const features = FEATURES.map((f) => {
      const choice = settings[f.id] ?? OFF;
      return {
        id: f.id,
        name: f.name,
        ready: f.ready,
        enabled: f.ready && choice.enabled,
        active: choice.model,
        mode: choice.mode ?? null,
        modes: f.modes ?? null,
        recommended: f.recommended,
        dataSent: f.dataSent,
        keyConfigured: choice.model ? keyConfigured(choice.model.provider) : null,
      };
    });
    return NextResponse.json({ features, providers });
  } catch {
    return NextResponse.json({ error: 'The model feature settings could not be read.', code: 'INTERNAL' }, { status: 500 });
  }
});
