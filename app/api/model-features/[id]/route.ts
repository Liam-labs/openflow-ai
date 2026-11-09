/**
 * PUT /api/model-features/<id>   { enabled: boolean, model: { provider, id } | null, mode?: string, returnTo?: string }
 * Switch a feature on or off and choose its model. The server refuses a switch-on it should not allow, and changes nothing then:
 *   409 FEATURE_NOT_READY  the feature's owner has not yet checked what it sends
 *   409 KEY_MISSING        the chosen provider has no key: answer carries { provider, linkUrl } for the "link this provider" button
 * Switching OFF always works.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { featureById, providerById } from '@/lib/model-features/registry';
import { saveChoice, choiceFor, type FeatureChoice } from '@/lib/model-features/store';
import { keyConfigured } from '@/lib/model-features/resolve';

export const dynamic = 'force-dynamic';

/** Only a path on this site: no scheme, no host, no protocol-relative address. */
function safeReturnTo(value: unknown): string | null {
  return typeof value === 'string' && /^\/(?![\/\\])[\w\-./?=&%#:]{0,300}$/.test(value) ? value : null;
}

function linkUrl(provider: string, featureId: string, returnTo: string | null): string {
  const q = new URLSearchParams({ provider, resume: featureId });
  if (returnTo) q.set('returnTo', returnTo);
  // The Systems page picks its section from the URL hash (#systems/<section>), so the query comes first and the hash last.
  return `/operations?${q.toString()}#systems/connections`;
}

const bad = (error: string, code: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, code, ...extra }, { status });

export const PUT = tracked('/api/model-features/[id]', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  const { id } = await context.params;
  const feature = featureById(id);
  if (!feature) return bad('No such feature.', 'NOT_FOUND', 404);
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bad('Send a JSON object.', 'BAD_REQUEST');
    body = parsed as Record<string, unknown>;
  } catch {
    return bad('Send a JSON object.', 'BAD_REQUEST');
  }
  if (typeof body.enabled !== 'boolean') return bad('enabled must be true or false.', 'BAD_REQUEST');

  const m = body.model as { provider?: unknown; id?: unknown } | null | undefined;
  let model: FeatureChoice['model'] = null;
  if (m) {
    if (typeof m.provider !== 'string' || typeof m.id !== 'string' || !providerById(m.provider) || !m.id.trim() || m.id.length > 200) {
      return bad('model needs a known provider and a model id.', 'BAD_MODEL');
    }
    model = { provider: m.provider, id: m.id.trim() };
  }
  let mode: string | undefined;
  if (body.mode !== undefined) {
    if (typeof body.mode !== 'string' || !(feature.modes ?? []).some((x) => x.id === body.mode)) return bad('That mode does not exist for this feature.', 'BAD_MODE');
    mode = body.mode;
  }

  if (body.enabled) {
    if (!feature.ready) return bad('This feature cannot be switched on yet: what it sends has not been checked.', 'FEATURE_NOT_READY', 409);
    if (!model) return bad('Choose a model first.', 'NO_MODEL', 409);
    if (!keyConfigured(model.provider)) {
      return bad(`This feature needs an API key for ${providerById(model.provider)!.label}.`, 'KEY_MISSING', 409, {
        provider: model.provider,
        linkUrl: linkUrl(model.provider, id, safeReturnTo(body.returnTo)),
      });
    }
  }
  const before = await choiceFor(id);
  const saved = await saveChoice(id, { enabled: body.enabled, model: model ?? (body.enabled ? null : before.model), ...(mode ?? before.mode ? { mode: mode ?? before.mode } : {}) });
  return NextResponse.json({ id, ...saved });
});
