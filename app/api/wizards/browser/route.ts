/**
 * /api/wizards/browser: the browser-use wizard (lib/wizards/browser-use.ts).
 *
 * GET   whether a browser was found, whether the wizard's browser is running, and whether a window can be shown for signing in.
 * POST  { action: 'start' }                start the dedicated browser (control port on this computer only)
 *       { action: 'prove' }                check the port is closed to everything else, open a test page and photograph it
 *       { action: 'open', url }            open a site in the browser's window so you can sign in
 *       { action: 'add-agent-access' }     add the Playwright MCP server that attaches to this browser
 *       { action: 'stop', deleteProfile? } stop it and remove agent access; the saved sign-ins stay unless deleteProfile
 *
 * Only this machine or an admin token: the browser's control port is full control of every site it is signed in to.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { requireTokenOrLocal } from '@/lib/api-auth';
import { addAgentAccess, displayAvailable, openUrlProblem, proveBrowser, realDeps, startBrowser, stopBrowser, type Deps } from '@/lib/wizards/browser-use';

export const dynamic = 'force-dynamic';

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function state(d: Deps) {
  const record = await d.readRecord();
  const bin = await d.binary();
  const running = record.enabled ? await d.isRunning(record) : false;
  return {
    record: { enabled: record.enabled, port: record.port ?? null, headless: !!record.headless, mcp: !!record.mcp, profileDir: record.profileDir ? 'saved' : null },
    running,
    browser: bin ? { kind: bin.kind } : null,
    windowPossible: displayAvailable(d.platform, d.env),
  };
}

export async function GET(request: NextRequest) {
  const denied = await requireTokenOrLocal(request, 'admin');
  if (denied) return denied;
  return json({ success: true, ...(await state(await realDeps())) });
}

export async function POST(request: NextRequest) {
  const denied = await requireTokenOrLocal(request, 'admin');
  if (denied) return denied;
  let body: { action?: unknown; url?: unknown; deleteProfile?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ success: false, error: 'Send JSON.' }, 400);
  }
  const d = await realDeps();
  const reply = async (status: number, extra: Record<string, unknown>) => json({ success: status < 400, ...extra, ...(await state(d)) }, status);

  if (body.action === 'start') {
    const r = await startBrowser(d);
    return reply(r.ok ? 200 : 409, r.ok ? { port: r.port, headless: r.headless } : { error: r.error, fix: r.fix });
  }
  if (body.action === 'prove') {
    const r = await proveBrowser(d, `proof-${randomBytes(6).toString('hex')}`);
    return reply(200, { ok: r.ok, exposed: r.exposed, steps: r.steps });
  }
  if (body.action === 'open') {
    const problem = openUrlProblem(body.url);
    if (problem) return json({ success: false, error: problem }, 400);
    const rec = await d.readRecord();
    if (!rec.enabled || !rec.port || !(await d.isRunning(rec))) return json({ success: false, error: 'Start the browser first.' }, 409);
    const ok = await d.openUrl(rec.port, String(body.url).trim());
    return reply(ok ? 200 : 502, ok ? {} : { error: 'The browser did not open it.' });
  }
  if (body.action === 'add-agent-access') {
    const r = await addAgentAccess(d);
    return reply(r.ok ? 200 : 409, r.ok ? { message: r.message } : { error: r.error });
  }
  if (body.action === 'stop') {
    const r = await stopBrowser(d, { deleteProfile: body.deleteProfile === true });
    return reply(r.ok ? 200 : 409, r.ok ? { note: r.note } : { error: r.error });
  }
  return json({ success: false, error: 'Unknown action.' }, 400);
}
