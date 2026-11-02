/**
 * /api/wizards/cloudflare: the WebGate wizard (lib/wizards/cloudflare.ts).
 *
 * GET   state: password set, token saved (never the token), what was made, whether cloudflared is installed and running.
 * POST  { action: 'save-token', token }                  check the scoped token, keep it only if it passes
 *       { action: 'enable', zoneId, subdomain, emails }  publish the dashboard behind Cloudflare Access
 *       { action: 'prove' }                              a request with no sign-in to the public address must reach Access's login
 *       { action: 'disable' }                            remove what the wizard made
 *       { action: 'forget-token' }                       delete the saved token (after switching off)
 *
 * Owner password session (same-origin writes), local owner, or an admin API token.
 */
import { NextRequest, NextResponse } from 'next/server';
import { emitWizardChanged } from '@/lib/wizards/events';
import { requireWizardAccess } from '@/lib/wizards/auth';
import { CloudflareApi } from '@/lib/wizards/cloudflare-api';
import { disableWebgate, enableWebgate, proveWebgate, realIo } from '@/lib/wizards/cloudflare';
import { forgetToken, readApiToken, saveToken, wizardState } from '@/lib/wizards/cloudflare-service';
import { realRunner } from '@/lib/wizards/cloudflared-runner';

export const dynamic = 'force-dynamic';

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: NextRequest) {
  const denied = await requireWizardAccess(request);
  if (denied) return denied;
  return json({ success: true, ...(await wizardState()) });
}

export async function POST(request: NextRequest) {
  const denied = await requireWizardAccess(request);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ success: false, error: 'Send JSON.' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ success: false, error: 'Send a JSON object.' }, 400);
  const io = realIo(realRunner);
  const reply = async (status: number, extra: Record<string, unknown>) => {
    const state = await wizardState(io);
    emitWizardChanged('cloudflare');
    return json({ success: status < 400, ...extra, ...state }, status);
  };

  if (body.action === 'save-token') {
    const result = await saveToken(typeof body.token === 'string' ? body.token : '', io);
    return reply(result.ok ? 200 : 422, { problems: result.problems, notes: result.notes, zones: result.zones, details: result.details ?? [] });
  }
  if (body.action === 'forget-token') {
    const result = await forgetToken(io);
    return reply(result.ok ? 200 : 409, result.ok ? {} : { error: result.error });
  }

  const token = await readApiToken();
  if (!token) return json({ success: false, error: 'Add the Cloudflare token first.' }, 409);
  const api = new CloudflareApi(token);
  const rec = await io.readRecord();

  if (body.action === 'enable') {
    if (!rec.known) return json({ success: false, error: 'Check the token first.' }, 409);
    const result = await enableWebgate(api, {
      zoneId: String(body.zoneId ?? ''), subdomain: String(body.subdomain ?? ''), emails: body.emails, accountId: rec.known.accountId, zones: rec.known.zones,
    }, io);
    return reply(result.ok ? 200 : 409, result.ok ? { url: result.url } : { error: result.error, fix: result.fix });
  }
  if (body.action === 'prove') {
    if (rec.stage !== 'live' || !rec.hostname) return json({ success: false, error: 'Switch the address on first.' }, 409);
    const proof = await proveWebgate(rec.hostname, io);
    if (proof.exposed) await disableWebgate(api, io);
    return reply(200, { ...proof, takenDown: proof.exposed });
  }
  if (body.action === 'disable') {
    const result = await disableWebgate(api, io);
    return reply(result.ok ? 200 : 409, result.ok ? { note: result.note } : { error: result.error });
  }
  return json({ success: false, error: 'Unknown action.' }, 400);
}
