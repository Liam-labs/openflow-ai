/**
 * /api/wizards/memory: the memory wizard (lib/wizards/memory.ts).
 *
 * GET   what this computer has (Docker, Python, free memory and disk), the plan, and what the wizard has set up.
 * POST  { action: 'enable', model? }       Qdrant in Docker (this computer only) + the Python packages
 *       { action: 'prove' }                the database refuses other addresses, then a real search finds the right memory
 *       { action: 'add-agent-access' }     give agents qdrant-store / qdrant-find
 *       { action: 'skip' }                 not now: nothing installed, nothing complains
 *       { action: 'disable', deleteData? } remove what the wizard started; memories are kept unless deleteData
 *
 * Only this machine or an admin token.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { requireTokenOrLocal } from '@/lib/api-auth';
import { addAgentAccess, disableMemory, enableMemory, gatherFacts, planMemory, proveMemory, realDeps, skipMemory, MODELS, type Deps, type ModelId } from '@/lib/wizards/memory';

export const dynamic = 'force-dynamic';

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function state(d: Deps) {
  const [facts, record] = await Promise.all([gatherFacts(d), d.readRecord()]);
  return { facts, plan: planMemory(facts), record: { enabled: record.enabled, skipped: !!record.skipped, stage: record.stage ?? 'none', adopted: !!record.adopted, model: record.model ?? null, mcp: !!record.mcp }, models: MODELS };
}

export async function GET(request: NextRequest) {
  const denied = await requireTokenOrLocal(request, 'admin');
  if (denied) return denied;
  return json({ success: true, ...(await state(await realDeps())) });
}

export async function POST(request: NextRequest) {
  const denied = await requireTokenOrLocal(request, 'admin');
  if (denied) return denied;
  let body: { action?: unknown; model?: unknown; deleteData?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ success: false, error: 'Send JSON.' }, 400);
  }
  const d = await realDeps();
  const reply = async (status: number, extra: Record<string, unknown>) => json({ success: status < 400, ...extra, ...(await state(d)) }, status);

  if (body.action === 'enable') {
    const model = body.model === 'light' || body.model === 'better' ? (body.model as ModelId) : undefined;
    const r = await enableMemory(d, model);
    return reply(r.ok ? 200 : 409, r.ok ? { model: r.model, adopted: r.adopted } : { error: r.error, fix: r.fix });
  }
  if (body.action === 'prove') {
    const r = await proveMemory(d, `proof-${randomBytes(6).toString('hex')}`);
    return reply(200, { ok: r.ok, exposed: r.exposed, steps: r.steps });
  }
  if (body.action === 'add-agent-access') {
    const r = await addAgentAccess(d);
    return reply(r.ok ? 200 : 409, r.ok ? { message: r.message } : { error: r.error });
  }
  if (body.action === 'skip') {
    const r = await skipMemory(d);
    return reply(r.ok ? 200 : 409, r.ok ? {} : { error: r.error });
  }
  if (body.action === 'disable') {
    const r = await disableMemory(d, { deleteData: body.deleteData === true });
    return reply(r.ok ? 200 : 409, r.ok ? { note: r.note } : { error: r.error });
  }
  return json({ success: false, error: 'Unknown action.' }, 400);
}
