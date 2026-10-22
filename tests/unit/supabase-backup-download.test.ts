/**
 * Tests for S3.1 — GET /api/supabase/backups/download.
 *
 * Focuses on the safety surface: filename validation, instance-prefix check,
 * and integration-level response shape. The canonical-path realpath check
 * relies on the filesystem and is covered by the integration tests that
 * exercise the real route handler with a temp backups dir.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';

// Use a static temp path so the mock can reference it at module-init time
// without hitting TDZ. Re-created fresh per test.
const TEST_APP_DATA = path.join(tmpdir(), 'dl-test-appdata-static');
const TEST_BACKUPS_DIR = path.join(TEST_APP_DATA, 'supabase-backups');

// Mock auth + tracking before importing the route
vi.mock('@/lib/api-auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/api-auth');
  return {
    ...actual,
    requireAuthOrLocal: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('@/lib/api-tracking', () => ({
  tracked: (_path: string, handler: Function) => handler,
  withTiming: (_path: string, handler: Function) => handler,
}));

// Mock the instance store
const getInstanceMock = vi.fn();
vi.mock('@/lib/supabase-instance-store', () => ({
  supabaseInstanceStore: {
    getInstance: (id: string) => getInstanceMock(id),
  },
}));

// Mock DataPaths so BACKUPS_DIR points to our fixed test dir
vi.mock('@/lib/data-paths', () => ({
  DataPaths: {
    appData: path.join(tmpdir(), 'dl-test-appdata-static'),
  },
}));

import { isSafeBackupFilename, sanitizeBackupInstanceName } from '@/lib/supabase-backup-security';

describe('isSafeBackupFilename', () => {
  it('accepts a normal backup filename', () => {
    expect(isSafeBackupFilename('bng-crm-daily-2026-04-10.sql')).toBe(true);
  });

  it('accepts underscores, dashes, and numbers', () => {
    expect(isSafeBackupFilename('my_backup-123.sql')).toBe(true);
  });

  it('rejects filenames with forward slashes', () => {
    expect(isSafeBackupFilename('../etc/passwd.sql')).toBe(false);
    expect(isSafeBackupFilename('/etc/passwd.sql')).toBe(false);
    expect(isSafeBackupFilename('subdir/backup.sql')).toBe(false);
  });

  it('rejects filenames with backslashes', () => {
    expect(isSafeBackupFilename('..\\windows\\backup.sql')).toBe(false);
  });

  it('rejects parent-dir traversal ".." even without slashes', () => {
    expect(isSafeBackupFilename('backup..sql')).toBe(false);
    expect(isSafeBackupFilename('..backup.sql')).toBe(false);
  });

  it('rejects null bytes', () => {
    expect(isSafeBackupFilename('backup\0.sql')).toBe(false);
  });

  it('rejects filenames without .sql extension', () => {
    expect(isSafeBackupFilename('backup')).toBe(false);
    expect(isSafeBackupFilename('backup.txt')).toBe(false);
    expect(isSafeBackupFilename('backup.sql.bak')).toBe(false);
  });

  it('accepts case-insensitive .sql extension', () => {
    expect(isSafeBackupFilename('backup.SQL')).toBe(true);
    expect(isSafeBackupFilename('backup.Sql')).toBe(true);
  });

  it('rejects empty string + non-string inputs', () => {
    expect(isSafeBackupFilename('')).toBe(false);
    expect(isSafeBackupFilename(null as unknown as string)).toBe(false);
    expect(isSafeBackupFilename(undefined as unknown as string)).toBe(false);
  });

  it('rejects hidden files (leading dot)', () => {
    expect(isSafeBackupFilename('.secret-backup.sql')).toBe(false);
  });

  it('rejects filenames over 255 chars', () => {
    expect(isSafeBackupFilename('x'.repeat(256) + '.sql')).toBe(false);
  });
});

describe('sanitizeBackupInstanceName', () => {
  it('strips spaces and special chars, keeps alphanumerics and dash/underscore', () => {
    expect(sanitizeBackupInstanceName('BnG-CRM')).toBe('BnG-CRM');
    expect(sanitizeBackupInstanceName('Local Development')).toBe('Local-Development');
    expect(sanitizeBackupInstanceName('My App!@#')).toBe('My-App---');
  });
});

describe('GET /api/supabase/backups/download — integration', () => {
  beforeEach(async () => {
    vi.resetModules();
    getInstanceMock.mockReset();
    // Clean + re-create the fixed test backups dir
    await rm(TEST_APP_DATA, { recursive: true, force: true });
    await mkdir(TEST_BACKUPS_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_APP_DATA, { recursive: true, force: true });
  });

  async function callGet(search: string): Promise<{ status: number; body: Record<string, unknown> | null; headers: Record<string, string> }> {
    // Fresh import so the route reads the patched DataPaths mock
    const { GET } = await import('@/app/api/supabase/backups/download/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(`http://localhost/api/supabase/backups/download${search}`);
    const res = await (GET as unknown as (r: unknown) => Promise<Response>)(req);
    const contentType = res.headers.get('content-type') || '';
    let body: Record<string, unknown> | null = null;
    if (contentType.includes('application/json')) {
      body = (await res.json()) as Record<string, unknown>;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, body, headers };
  }

  it('returns 400 when instanceId is missing', async () => {
    const { status, body } = await callGet('?filename=x.sql');
    expect(status).toBe(400);
    expect(body?.error).toBe('instanceId is required');
  });

  it('returns 400 when filename is missing', async () => {
    const { status, body } = await callGet('?instanceId=abc');
    expect(status).toBe(400);
    expect(body?.error).toBe('filename is required');
  });

  it('returns 400 for an unsafe filename', async () => {
    const { status, body } = await callGet('?instanceId=abc&filename=' + encodeURIComponent('../etc/passwd.sql'));
    expect(status).toBe(400);
    expect(body?.error).toBe('Invalid filename');
  });

  it('returns 404 when the instance is not found', async () => {
    getInstanceMock.mockResolvedValueOnce(null);
    const { status, body } = await callGet('?instanceId=missing&filename=backup.sql');
    expect(status).toBe(404);
    expect(body?.error).toContain('Instance not found');
  });

  it('returns 400 for hosted instances (local-only endpoint)', async () => {
    getInstanceMock.mockResolvedValueOnce({ id: 'h1', name: 'Hosted', type: 'hosted', connection: {} });
    const { status, body } = await callGet('?instanceId=h1&filename=backup.sql');
    expect(status).toBe(400);
    expect(body?.error).toContain('local instances');
  });

  it('returns 403 when filename does not match the instance prefix', async () => {
    getInstanceMock.mockResolvedValueOnce({ id: 'loc1', name: 'BnG-CRM', type: 'local', connection: {} });
    const { status, body } = await callGet('?instanceId=loc1&filename=other-instance-daily-2026-04-10.sql');
    expect(status).toBe(403);
    expect(body?.error).toContain('does not belong');
  });

  it('returns 404 when the file does not exist on disk', async () => {
    getInstanceMock.mockResolvedValueOnce({ id: 'loc1', name: 'BnG-CRM', type: 'local', connection: {} });
    const { status, body } = await callGet('?instanceId=loc1&filename=BnG-CRM-daily-2026-04-10.sql');
    expect(status).toBe(404);
    expect(body?.error).toContain('not found');
  });

  it('streams the file with Content-Disposition when everything is valid', async () => {
    getInstanceMock.mockResolvedValueOnce({ id: 'loc1', name: 'BnG-CRM', type: 'local', connection: {} });
    // Create a real .sql file in the temp backups dir
    const filename = 'BnG-CRM-daily-2026-04-10.sql';
    const content = '-- sql dump body --\n';
    await writeFile(path.join(TEST_BACKUPS_DIR, filename), content);
    const { status, headers } = await callGet(`?instanceId=loc1&filename=${filename}`);
    expect(status).toBe(200);
    expect(headers['content-disposition']).toBe(`attachment; filename="${filename}"`);
    expect(headers['content-type']).toBe('application/sql');
    expect(Number(headers['content-length'])).toBe(Buffer.byteLength(content));
  });
});
