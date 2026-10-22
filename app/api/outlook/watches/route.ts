/**
 * /api/outlook/watches — REST wrapper around the action handlers in
 * app/api/agent/actions/outlook-watches.ts.
 *
 * The canonical interface for agents is `/api/agent` with actions
 * `outlook.watch.create / list / update / delete`. These are Graph push-event
 * routing filters despite the legacy "watch" name. This route exists for
 * conventional REST callers (curl, scripts, the management panel) and applies
 * `requireAuthOrLocal` per the security directive.
 *
 * Method mapping:
 *   GET                       → outlookWatches.list
 *   POST                      → outlookWatches.create
 *   PATCH /api/outlook/watches?watchId=…  → outlookWatches.update
 *   DELETE /api/outlook/watches?watchId=… → outlookWatches.remove
 *
 * `requireAuthOrLocal` accepts either a Bearer token or a request from
 * localhost (mirrors the rest of DevFlow's gated routes).
 */

import { NextRequest, NextResponse } from 'next/server';

import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import {
  create as createWatch,
  list as listWatches,
  update as updateWatch,
  remove as deleteWatch,
  ValidationError,
} from '@/app/api/agent/actions/outlook-watches';
import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';

export const dynamic = 'force-dynamic';

// requireAuthOrLocal already validates a token when one is present, but the
// action handlers don't read the auth context. We synthesise a minimal one so
// the handler signatures stay uniform with /api/agent.
function stubAuth(): AgentAuthContext {
  return {
    tokenId: 'rest:outlook-watches',
    tokenName: '/api/outlook/watches',
    scope: 'admin',
    createdBy: 'rest-route',
  };
}

function parseSearch(url: string): Record<string, string> {
  const u = new URL(url);
  const out: Record<string, string> = {};
  u.searchParams.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

async function readJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function handleValidationError(err: unknown): NextResponse {
  if (err instanceof ValidationError) {
    return NextResponse.json(
      { success: false, error: err.message, code: err.code },
      { status: err.statusCode }
    );
  }
  const message = err instanceof Error ? err.message : 'Internal error';
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

// ----- GET (list) -----

export const GET = tracked('/api/outlook/watches', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  const params = parseSearch(request.url);
  const body: AgentApiRequest = { action: 'outlook.watch.list', ...params } as AgentApiRequest;
  if (params.includeDisabled === 'true') body.includeDisabled = true;

  try {
    const data = await listWatches(body, stubAuth());
    return NextResponse.json({ success: true, ...data });
  } catch (err) {
    return handleValidationError(err);
  }
});

// ----- POST (create) -----

export const POST = tracked('/api/outlook/watches', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  const body = await readJsonBody(request);
  const req: AgentApiRequest = { action: 'outlook.watch.create', ...body } as AgentApiRequest;

  try {
    const data = await createWatch(req, stubAuth());
    return NextResponse.json({ success: true, ...data }, { status: 201 });
  } catch (err) {
    return handleValidationError(err);
  }
});

// ----- PATCH (update) -----

export const PATCH = tracked('/api/outlook/watches', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  const body = await readJsonBody(request);
  const params = parseSearch(request.url);
  const req: AgentApiRequest = {
    action: 'outlook.watch.update',
    watchId: typeof body.watchId === 'string' ? body.watchId : params.watchId,
    ...body,
  } as AgentApiRequest;

  try {
    const data = await updateWatch(req, stubAuth());
    return NextResponse.json({ success: true, ...data });
  } catch (err) {
    return handleValidationError(err);
  }
});

// ----- DELETE -----

export const DELETE = tracked('/api/outlook/watches', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  const body = await readJsonBody(request);
  const params = parseSearch(request.url);
  const req: AgentApiRequest = {
    action: 'outlook.watch.delete',
    watchId: typeof body.watchId === 'string' ? body.watchId : params.watchId,
    ownerParticipantId:
      typeof body.ownerParticipantId === 'string'
        ? body.ownerParticipantId
        : params.ownerParticipantId,
  } as AgentApiRequest;

  try {
    const data = await deleteWatch(req, stubAuth());
    return NextResponse.json({ success: true, ...data });
  } catch (err) {
    return handleValidationError(err);
  }
});
