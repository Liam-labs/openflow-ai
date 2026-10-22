/**
 * /api/scaffolding/snooze — manage drift-alarm snoozes per agent (or fleet).
 *
 * Mirrors the `sprints.reminderSnooze` API shape so callers familiar with
 * one find the other intuitive.
 *
 *   GET  /api/scaffolding/snooze              — list active (non-expired)
 *                                                snoozes; returns []
 *
 *   POST /api/scaffolding/snooze
 *        body: { agentId?, until, reason }
 *        Sets a snooze. `agentId` omitted (or '__fleet__') = fleet-wide.
 *        `until` accepts ISO timestamp OR `+Nh / +Nm` shorthand for
 *        relative durations (e.g. '+6h').
 *
 *   DELETE /api/scaffolding/snooze?agentId=NAME
 *        Clear a snooze.
 *
 * Auth: requireAuthOrLocal('write') for POST/DELETE, 'read' for GET.
 *
 * Side-effect: the drift-alarm cron auto-snoozes alerted agents for 4h
 * after each fire. Use this API to extend a snooze manually or to clear
 * the auto-snooze early.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import {
  FLEET_SNOOZE_KEY,
  clearSnooze,
  listActiveSnoozes,
  setSnooze,
} from '@/lib/scaffolding-snooze';
import { parseJsonBody, parseQueryParams, refinements, z } from '@/lib/api-validation';

export const dynamic = 'force-dynamic';

function bad(error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status: 400 });
}
function notFound(error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status: 404 });
}
function serverError(error: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ success: false, error, ...(extra ?? {}) }, { status: 500 });
}

/** Parse `until` field — accepts ISO timestamp or `+Nh` / `+Nm` shorthand. */
function parseUntil(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const rel = trimmed.match(/^\+(\d+)([smhd])$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const mul = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return new Date(Date.now() + n * mul).toISOString();
  }
  const ts = Date.parse(trimmed);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

export const GET = tracked('/api/scaffolding/snooze', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  try {
    const snoozes = await listActiveSnoozes();
    return NextResponse.json({
      success: true,
      count: snoozes.length,
      snoozes,
    });
  } catch (err) {
    return serverError('Internal error', { detail: (err as Error).message });
  }
});

/**
 * Sprint Q1 T2 — Reynolds, 2026-05-27. Schemas live next to the route they
 * own (Decision 4 in docs/spec-q1-api-input-validation.md). Closes:
 *   - snooze POST type-confusion → 500 (crit, agentId/until non-string)
 *   - snooze accepts past timestamps (med)
 *   - snooze accepts control chars in agentId (med)
 *   - snooze accepts 5000-char agentId, no length cap (med)
 *   - snooze 64KB reason field accepted (med)
 *   - 'until required' error message conflates missing/wrong-type (low UX)
 *
 * The `until` field uses a transform that runs parseUntil() inline so the
 * schema enforces "either ISO timestamp OR +Nh/Nm/Nd shorthand AND resolves
 * to a future moment". Schema failure → 400 INVALID_FIELD with the issue
 * path and original raw value in the message.
 */
const SnoozeBodySchema = z.object({
  agentId: z.string()
    .max(200, 'agentId must be 200 characters or fewer')
    .refine(refinements.noControlChars, 'agentId must not contain control characters')
    .optional(),
  until: z.string()
    .min(1, 'until is required — ISO timestamp or `+Nh` / `+Nm` shorthand')
    .max(64, 'until must be 64 characters or fewer')
    .transform((raw, ctx) => {
      const resolved = parseUntil(raw);
      if (!resolved) {
        ctx.addIssue({
          code: 'custom',
          message: `until parse failed — '${raw}' is not a valid ISO timestamp or +Ns/m/h/d shorthand`,
        });
        return z.NEVER;
      }
      return resolved;
    })
    .refine(refinements.notInPast, 'until must resolve to a future timestamp'),
  reason: z.string().max(2000, 'reason must be 2000 characters or fewer').optional(),
  setBy: z.string()
    .max(200, 'setBy must be 200 characters or fewer')
    .refine(refinements.noControlChars, 'setBy must not contain control characters')
    .optional(),
});

const SnoozeDeleteQuerySchema = z.object({
  agentId: z.string()
    .max(200, 'agentId must be 200 characters or fewer')
    .refine(refinements.noControlChars, 'agentId must not contain control characters')
    .optional(),
});

export const POST = tracked('/api/scaffolding/snooze', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  const parsed = await parseJsonBody(request, SnoozeBodySchema, { label: 'snooze body' });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const agentKey = (body.agentId ?? '').trim() || FLEET_SNOOZE_KEY;
  const reason = (body.reason ?? '').trim();
  const setBy = (body.setBy ?? '').trim() || 'api';

  try {
    const entry = await setSnooze(agentKey, body.until, reason || '(no reason)', setBy);
    return NextResponse.json({ success: true, snooze: entry });
  } catch (err) {
    return serverError('Internal error', { detail: (err as Error).message });
  }
});

export const DELETE = tracked('/api/scaffolding/snooze', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  const parsed = parseQueryParams(request, SnoozeDeleteQuerySchema, { label: 'snooze delete query' });
  if (!parsed.ok) return parsed.response;
  const agentKey = (parsed.data.agentId ?? '').trim() || FLEET_SNOOZE_KEY;

  try {
    const existed = await clearSnooze(agentKey);
    if (!existed) return notFound(`No active snooze for '${agentKey}'`);
    return NextResponse.json({ success: true, cleared: agentKey });
  } catch (err) {
    return serverError('Internal error', { detail: (err as Error).message });
  }
});
