/**
 * Tests for S1.2 — `'supabase-backup'` is now a valid log source.
 *
 * The backup script POSTs failure events to /api/logs with source='supabase-backup'.
 * Before: the endpoint rejected unknown sources with 400. After: the new source
 * passes validation and writes to the unified log.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth so we bypass real token validation
vi.mock('@/lib/api-auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/api-auth');
  return {
    ...actual,
    validateApiToken: vi.fn().mockResolvedValue({
      valid: true,
      token: { id: 't1', name: 'Test', scope: 'admin', createdBy: 'test' },
    }),
  };
});

// Mock logEvent so we don't touch the filesystem
const logEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/log-writer', () => ({
  logEvent: (...args: unknown[]) => logEventMock(...args),
}));

vi.mock('@/lib/api-tracking', () => ({
  tracked: (_path: string, handler: Function) => handler,
  withTiming: (_path: string, handler: Function) => handler,
}));

async function postLogs(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const { POST } = await import('@/app/api/logs/route');
  const req = new Request('http://localhost/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await (POST as unknown as (r: Request) => Promise<Response>)(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('S1.2 — supabase-backup log source', () => {
  beforeEach(() => {
    vi.resetModules();
    logEventMock.mockClear();
  });

  it("accepts source='supabase-backup' on POST /api/logs", async () => {
    const { status, json } = await postLogs({
      source: 'supabase-backup',
      severity: 'high',
      title: 'Supabase backup failed: Test Stack',
      metadata: {
        action: 'supabase-backup.test',
        slug: 'test',
        instance: 'Test Stack',
        exitCode: 42,
      },
    });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(logEventMock).toHaveBeenCalledOnce();
    expect(logEventMock).toHaveBeenCalledWith(
      'supabase-backup',
      'high',
      'Supabase backup failed: Test Stack',
      expect.objectContaining({
        action: 'supabase-backup.test',
        slug: 'test',
        exitCode: 42,
      }),
      undefined,
    );
  });

  it("accepts severity='medium' for port-check skip events", async () => {
    const { status } = await postLogs({
      source: 'supabase-backup',
      severity: 'medium',
      title: 'Supabase backup skipped: Test — port down',
      metadata: { action: 'supabase-backup.test', slug: 'test', instance: 'Test' },
    });
    expect(status).toBe(200);
  });

  it('still rejects unknown sources', async () => {
    const { status, json } = await postLogs({
      source: 'bogus-source',
      severity: 'high',
      title: 'should fail',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('Invalid source');
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it("preserves existing sources (sanity: 'service' still valid)", async () => {
    const { status } = await postLogs({
      source: 'service',
      severity: 'info',
      title: 'generic service event',
    });
    expect(status).toBe(200);
  });

  it('rejects missing title even with valid source', async () => {
    const { status, json } = await postLogs({
      source: 'supabase-backup',
      severity: 'high',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('title');
  });
});
