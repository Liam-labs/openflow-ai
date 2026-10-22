/**
 * Tests for local Supabase backup support in GET/POST /api/supabase/backups
 *
 * Bug: existing route crashes for local instances ("Invalid project ref").
 * Fix: detect instance.type === 'local', use supabase CLI for dump, list files for history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock dependencies
vi.mock('@/lib/supabase-instance-store', () => ({
  supabaseInstanceStore: {
    getInstance: vi.fn(),
  },
}));

vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/api-tracking', () => ({
  tracked: (_path: string, handler: Function) => handler,
}));

vi.mock('@/lib/fetch-utils', () => ({
  fetchWithTimeout: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { execFile } from 'child_process';
import { readdir, stat, unlink } from 'fs/promises';
import type { SupabaseInstance } from '@/lib/supabase-types';

function mockRequest(url: string, method = 'GET', body?: unknown): Request {
  const init: RequestInit = { method };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return new Request(url, init);
}

const LOCAL_INSTANCE: SupabaseInstance = {
  id: 'local-1',
  name: 'Local Dev',
  type: 'local',
  connection: {
    url: 'http://localhost:54321',
    anonKeyEnvVar: 'SUPABASE_ANON_KEY',
    serviceRoleKeyEnvVar: 'SUPABASE_SECRET_KEY',
    dbConnectionStringEnvVar: 'SUPABASE_LOCAL_DB_URL',
  },
  linkedProjects: [],
  status: 'online',
  lastCheckedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('GET /api/supabase/backups (local instance)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    process.env.SUPABASE_ACCESS_TOKEN = 'test-token';
  });

  it('returns backup list for local instance without calling Management API', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);
    vi.mocked(readdir).mockResolvedValue([
      'Local-Dev-2026-04-08T10-00-00.sql',
      'Local-Dev-2026-04-07T10-00-00.sql',
    ] as any);
    vi.mocked(stat).mockResolvedValue({
      size: 1048576,
      mtime: new Date('2026-04-08T10:00:00Z'),
    } as any);

    const { GET } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest('http://localhost:3000/api/supabase/backups?instanceId=local-1');
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.instanceType).toBe('local');
    expect(body.pitr_enabled).toBe(false);
    expect(Array.isArray(body.backups)).toBe(true);
    expect(body.backups.length).toBe(2);
  });

  it('returns empty backup list when no dumps exist', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);
    vi.mocked(readdir).mockResolvedValue([] as any);

    const { GET } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest('http://localhost:3000/api/supabase/backups?instanceId=local-1');
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.backups).toEqual([]);
  });

  it('backup entry has expected shape', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);
    vi.mocked(readdir).mockResolvedValue(['Local-Dev-2026-04-08T10-00-00.sql'] as any);
    vi.mocked(stat).mockResolvedValue({
      size: 2097152,
      mtime: new Date('2026-04-08T10:00:00Z'),
    } as any);

    const { GET } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest('http://localhost:3000/api/supabase/backups?instanceId=local-1');
    const res = await GET(req as any);
    const body = await res.json();
    const backup = body.backups[0];

    expect(backup).toHaveProperty('filename');
    expect(backup).toHaveProperty('sizeMb');
    expect(backup).toHaveProperty('createdAt');
    expect(typeof backup.sizeMb).toBe('number');
  });
});

describe('GET /api/supabase/backups — case-insensitive slug matching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    process.env.SUPABASE_ACCESS_TOKEN = 'test-token';
  });

  it('matches backup files created with a lowercase slug when instance name has mixed case', async () => {
    // Instance name 'BnG-CRM' → sanitizeName → 'BnG-CRM'
    // Files created by cron with lowercase prefix 'bng-crm'
    // Old code: 'bng-crm-daily-...sql'.startsWith('BnG-CRM') → false (bug)
    // New code: case-insensitive → true (fix)
    const mixedCaseInstance: SupabaseInstance = {
      ...LOCAL_INSTANCE,
      id: 'bng-crm-1',
      name: 'BnG-CRM',
    };
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(mixedCaseInstance);
    vi.mocked(readdir).mockResolvedValue([
      'bng-crm-daily-2026-04-09.sql',
      'other-project-daily-2026-04-09.sql', // should NOT be included
    ] as any);
    vi.mocked(stat).mockResolvedValue({
      size: 1048576,
      mtime: new Date('2026-04-09T00:00:00Z'),
    } as any);

    const { GET } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest('http://localhost:3000/api/supabase/backups?instanceId=bng-crm-1');
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.backups.length).toBe(1);
    expect(body.backups[0].filename).toBe('bng-crm-daily-2026-04-09.sql');
  });

  it('does not cross-contaminate backups from a different instance with a similar prefix', async () => {
    // 'seo' instance must not pick up 'seoengine-local-...' files
    const seoInstance: SupabaseInstance = {
      ...LOCAL_INSTANCE,
      id: 'seo-1',
      name: 'SEO',
    };
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(seoInstance);
    vi.mocked(readdir).mockResolvedValue([
      'seo-daily-2026-04-09.sql',
      'seoengine-local-daily-2026-04-09.sql', // different project, must NOT match 'seo' prefix
    ] as any);
    vi.mocked(stat).mockResolvedValue({
      size: 512000,
      mtime: new Date('2026-04-09T00:00:00Z'),
    } as any);

    const { GET } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest('http://localhost:3000/api/supabase/backups?instanceId=seo-1');
    const res = await GET(req as any);
    const body = await res.json();

    // Only seo-daily should match, not seoengine-local
    expect(body.backups.length).toBe(1);
    expect(body.backups[0].filename).toBe('seo-daily-2026-04-09.sql');
  });
});

describe('POST /api/supabase/backups (local dump)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    process.env.SUPABASE_ACCESS_TOKEN = 'test-token';
  });

  it('retires the legacy schema-only local dump action without invoking the CLI', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, 'Dumped schema', '');
      return {} as any;
    });

    const { POST } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest(
      'http://localhost:3000/api/supabase/backups',
      'POST',
      { instanceId: 'local-1', action: 'dump' }
    );
    const res = await POST(req as any);
    expect(res.status).toBe(410);

    const body = await res.json();
    expect(body.deprecated).toBe(true);
    expect(body.replacement).toBe('custom-format scheduler backups');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns error for unknown action on local instance', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);

    const { POST } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest(
      'http://localhost:3000/api/supabase/backups',
      'POST',
      { instanceId: 'local-1', action: 'pitr' }
    );
    const res = await POST(req as any);
    // PITR not available for local
    expect(res.status).toBe(400);
  });

  it('returns the retirement response even when the legacy CLI would fail', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(new Error('supabase not found'), '', 'error');
      return {} as any;
    });

    const { POST } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest(
      'http://localhost:3000/api/supabase/backups',
      'POST',
      { instanceId: 'local-1', action: 'dump' }
    );
    const res = await POST(req as any);
    expect(res.status).toBe(410);
    expect(execFile).not.toHaveBeenCalled();
  });
});

// ─── DELETE action ─────────────────────────────────────────────────────────

describe('POST /api/supabase/backups (local delete)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    process.env.SUPABASE_ACCESS_TOKEN = 'test-token';
  });

  it('deletes valid backup files and returns deleted count', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);
    vi.mocked(unlink).mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest(
      'http://localhost:3000/api/supabase/backups',
      'POST',
      {
        instanceId: 'local-1',
        action: 'delete',
        filenames: ['local-dev-2026-04-08.sql', 'local-dev-2026-04-07.sql'],
      }
    );
    const res = await POST(req as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(2);
    expect(unlink).toHaveBeenCalledTimes(2);
  });

  it('rejects filenames with path traversal (../)', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);

    const { POST } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest(
      'http://localhost:3000/api/supabase/backups',
      'POST',
      {
        instanceId: 'local-1',
        action: 'delete',
        filenames: ['../secrets.env'],
      }
    );
    const res = await POST(req as any);
    expect(res.status).toBe(400);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('rejects filenames that are not .sql files', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);

    const { POST } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest(
      'http://localhost:3000/api/supabase/backups',
      'POST',
      {
        instanceId: 'local-1',
        action: 'delete',
        filenames: ['backup.sh'],
      }
    );
    const res = await POST(req as any);
    expect(res.status).toBe(400);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('returns 400 when filenames array is empty', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);

    const { POST } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest(
      'http://localhost:3000/api/supabase/backups',
      'POST',
      { instanceId: 'local-1', action: 'delete', filenames: [] }
    );
    const res = await POST(req as any);
    expect(res.status).toBe(400);
  });

  it('rejects filenames containing null bytes', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);

    const { POST } = await import('@/app/api/supabase/backups/route');
    const req = mockRequest(
      'http://localhost:3000/api/supabase/backups',
      'POST',
      { instanceId: 'local-1', action: 'delete', filenames: ['local-dev\x00evil.sql'] }
    );
    const res = await POST(req as any);
    expect(res.status).toBe(400);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('rejects filenames that belong to a different instance (prefix mismatch)', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);

    const { POST } = await import('@/app/api/supabase/backups/route');
    // LOCAL_INSTANCE name is 'Local Dev' → sanitized prefix 'local-dev-'
    // 'other-project-2026-04-09.sql' does not start with 'local-dev-'
    const req = mockRequest(
      'http://localhost:3000/api/supabase/backups',
      'POST',
      {
        instanceId: 'local-1',
        action: 'delete',
        filenames: ['other-project-2026-04-09.sql'],
      }
    );
    const res = await POST(req as any);
    expect(res.status).toBe(403);
    expect(unlink).not.toHaveBeenCalled();
  });
});
