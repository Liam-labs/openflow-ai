/**
 * Sprint Q1 Task 1 — Reynolds, 2026-05-27.
 *
 * Exercises lib/api-validation.ts against the failure modes catalogued in
 * docs/qa-summary-2026-05-25.md Pattern A (critical 500 → 400 conversion).
 * Each `it` block names a QA-log finding so future drift is easy to trace.
 */

import { describe, it, expect } from 'vitest';
import { parseJsonBody, parseQueryParams, refinements, z } from '@/lib/api-validation';

function makePost(body: string | undefined): Request {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) init.body = body;
  return new Request('http://localhost/x', init);
}

function makeGet(query: string): Request {
  return new Request(`http://localhost/x${query ? '?' + query : ''}`, { method: 'GET' });
}

const NameOnlySchema = z.object({
  agentId: z.string().min(1),
});

describe('parseJsonBody — happy path', () => {
  it('returns ok:true with typed data for a valid body', async () => {
    const req = makePost(JSON.stringify({ agentId: 'Architect' }));
    const res = await parseJsonBody(req, NameOnlySchema);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.agentId).toBe('Architect');
  });

  it('treats empty body as {} (so all-optional schemas pass)', async () => {
    const AllOptional = z.object({ x: z.string().optional() });
    const req = makePost(undefined);
    const res = await parseJsonBody(req, AllOptional);
    expect(res.ok).toBe(true);
  });
});

describe('parseJsonBody — closes QA-log 500s', () => {
  it('drift-alarm null JSON body → 400 (was 500, drift-alarm crit)', async () => {
    const req = makePost('null');
    const res = await parseJsonBody(req, NameOnlySchema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it("drift-alarm 'not-json' body → 400 (was silently 200/empty defaults)", async () => {
    const req = makePost('not-json');
    const res = await parseJsonBody(req, NameOnlySchema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it('snooze agentId=42 (number) → 400 (was 500 .trim crash)', async () => {
    const req = makePost(JSON.stringify({ agentId: 42 }));
    const res = await parseJsonBody(req, NameOnlySchema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it('snooze agentId=[...] (array) → 400 (was 500 .trim crash)', async () => {
    const req = makePost(JSON.stringify({ agentId: ['a', 'b'] }));
    const res = await parseJsonBody(req, NameOnlySchema);
    expect(res.ok).toBe(false);
  });

  it('snooze agentId={...} (object) → 400 (was 500 .trim crash)', async () => {
    const req = makePost(JSON.stringify({ agentId: { a: 1 } }));
    const res = await parseJsonBody(req, NameOnlySchema);
    expect(res.ok).toBe(false);
  });

  it('truncated JSON → 400 (was 500 generic parse error)', async () => {
    const req = makePost('{"agentId":"Sam');
    const res = await parseJsonBody(req, NameOnlySchema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });
});

describe('parseJsonBody — error envelope shape', () => {
  it("returns INVALID_FIELD code in body.code", async () => {
    const req = makePost(JSON.stringify({ agentId: 42 }));
    const res = await parseJsonBody(req, NameOnlySchema);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const body = await res.response.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe('INVALID_FIELD');
      expect(body.error).toMatch(/Invalid request/);
      expect(body.data?.issues).toBeDefined();
      expect(Array.isArray(body.data.issues)).toBe(true);
      expect(body.data.issues[0].path).toEqual(['agentId']);
    }
  });

  it('includes requestId when passed in context', async () => {
    const req = makePost('null');
    const res = await parseJsonBody(req, NameOnlySchema, { requestId: 'req-abc' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const body = await res.response.json();
      expect(body.requestId).toBe('req-abc');
    }
  });

  it('uses context.label in the error message', async () => {
    const req = makePost('null');
    const res = await parseJsonBody(req, NameOnlySchema, { label: 'snooze body' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const body = await res.response.json();
      expect(body.error).toMatch(/snooze body/);
    }
  });
});

describe('parseQueryParams', () => {
  it('returns ok:true for a valid query', () => {
    const req = makeGet('agentId=Carter');
    const res = parseQueryParams(req, NameOnlySchema);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.agentId).toBe('Carter');
  });

  it('returns ok:false when required param missing', () => {
    const req = makeGet('');
    const res = parseQueryParams(req, NameOnlySchema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it('coerces strings to numbers via z.coerce', () => {
    const NumSchema = z.object({ limit: z.coerce.number().int().min(1) });
    const req = makeGet('limit=10');
    const res = parseQueryParams(req, NumSchema);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.limit).toBe(10);
  });
});

describe('refinements — closes path-traversal / null-byte / control-char QAs', () => {
  it('noNullByte rejects strings with NUL', () => {
    expect(refinements.noNullByte('abc')).toBe(true);
    expect(refinements.noNullByte('abc\x00def')).toBe(false);
  });

  it('noControlChars rejects newlines + tabs (snooze med)', () => {
    expect(refinements.noControlChars('agent name')).toBe(true);
    expect(refinements.noControlChars('line1\nline2')).toBe(false);
    expect(refinements.noControlChars('tab\there')).toBe(false);
  });

  it('safePathSegment rejects .. / \\ \\x00', () => {
    expect(refinements.safePathSegment('agent-1')).toBe(true);
    expect(refinements.safePathSegment('../etc/passwd')).toBe(false);
    expect(refinements.safePathSegment('a/b')).toBe(false);
    expect(refinements.safePathSegment('a\\b')).toBe(false);
    expect(refinements.safePathSegment('a\x00b')).toBe(false);
  });

  it('notInPast rejects past timestamps + invalid dates (snooze med)', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(refinements.notInPast(future)).toBe(true);
    expect(refinements.notInPast(past)).toBe(false);
    expect(refinements.notInPast('not a date')).toBe(false);
  });
});

describe('integration — full schema with refinements', () => {
  const SnoozeBodySchema = z.object({
    agentId: z.string()
      .min(1)
      .max(200)
      .refine(refinements.noControlChars, 'agentId must not contain control characters'),
    until: z.string()
      .min(1)
      .refine(refinements.notInPast, 'until must be a future timestamp'),
    reason: z.string().max(2000).optional(),
  });

  it('accepts a valid snooze body', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const req = makePost(JSON.stringify({ agentId: 'Architect', until: future, reason: 'maintenance' }));
    const res = await parseJsonBody(req, SnoozeBodySchema);
    expect(res.ok).toBe(true);
  });

  it('rejects newline-laden agentId', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const req = makePost(JSON.stringify({ agentId: 'line1\nline2', until: future }));
    const res = await parseJsonBody(req, SnoozeBodySchema);
    expect(res.ok).toBe(false);
  });

  it('rejects past until', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const req = makePost(JSON.stringify({ agentId: 'Sam', until: past }));
    const res = await parseJsonBody(req, SnoozeBodySchema);
    expect(res.ok).toBe(false);
  });

  it('rejects 5000-char agentId (over .max(200))', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const req = makePost(JSON.stringify({ agentId: 'X'.repeat(5000), until: future }));
    const res = await parseJsonBody(req, SnoozeBodySchema);
    expect(res.ok).toBe(false);
  });
});
