/**
 * Tests for S3.3-backend — schema diff parser + GET /api/supabase/backups/diff.
 *
 * Two layers:
 *   1. Pure parser tests (parseCreateTables, diffSchemas, diffSqlDumps) — no filesystem, no auth
 *   2. Route integration tests (NextRequest harness, mocked DataPaths + instance store + temp backups dir)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import {
  parseCreateTables,
  diffSchemas,
  diffSqlDumps,
} from '@/lib/supabase-backup-diff';

const TEST_APP_DATA = path.join(tmpdir(), 'diff-test-appdata-static');
const TEST_BACKUPS_DIR = path.join(TEST_APP_DATA, 'supabase-backups');

// ─── Mocks (for route-level tests) ─────────────────────────────────────────

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

const getInstanceMock = vi.fn();
vi.mock('@/lib/supabase-instance-store', () => ({
  supabaseInstanceStore: {
    getInstance: (id: string) => getInstanceMock(id),
  },
}));

vi.mock('@/lib/data-paths', () => ({
  DataPaths: {
    appData: path.join(tmpdir(), 'diff-test-appdata-static'),
  },
}));

// ─── Pure parser tests ─────────────────────────────────────────────────────

describe('parseCreateTables', () => {
  it('extracts a single plain CREATE TABLE', () => {
    const sql = `CREATE TABLE users (
  id integer NOT NULL,
  email text
);`;
    const tables = parseCreateTables(sql);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('users');
    expect(tables[0].columns.map(c => c.name)).toEqual(['id', 'email']);
    expect(tables[0].columns[0].definition).toBe('integer NOT NULL');
    expect(tables[0].columns[1].definition).toBe('text');
  });

  it('handles schema-qualified + quoted names', () => {
    const sql = 'CREATE TABLE public."User" (id uuid, name text);';
    const tables = parseCreateTables(sql);
    expect(tables[0].name).toBe('public.User');
    expect(tables[0].columns.map(c => c.name)).toEqual(['id', 'name']);
  });

  it('handles IF NOT EXISTS', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS posts (id serial);';
    const tables = parseCreateTables(sql);
    expect(tables[0].name).toBe('posts');
  });

  it('extracts multiple tables from a single dump', () => {
    const sql = `
      CREATE TABLE a (x int);
      CREATE TABLE b (y text);
      CREATE TABLE c (z boolean);
    `;
    const tables = parseCreateTables(sql);
    expect(tables.map(t => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('skips constraint rows inside the column list', () => {
    const sql = `CREATE TABLE t (
  id integer NOT NULL,
  email text,
  PRIMARY KEY (id),
  CONSTRAINT uniq_email UNIQUE (email)
);`;
    const columns = parseCreateTables(sql)[0].columns;
    expect(columns.map(c => c.name)).toEqual(['id', 'email']);
  });

  it('respects balanced parens inside type definitions', () => {
    const sql = `CREATE TABLE money (
  amount numeric(10,2) NOT NULL,
  label varchar(64)
);`;
    const columns = parseCreateTables(sql)[0].columns;
    expect(columns).toHaveLength(2);
    expect(columns[0].definition).toBe('numeric(10,2) NOT NULL');
    expect(columns[1].definition).toBe('varchar(64)');
  });

  it('returns empty array for SQL with no CREATE TABLE', () => {
    expect(parseCreateTables('-- comment only\nSELECT 1;')).toEqual([]);
  });

  it('normalizes whitespace in column definitions', () => {
    const sql = 'CREATE TABLE t (\n  id   integer   NOT NULL\n);';
    expect(parseCreateTables(sql)[0].columns[0].definition).toBe('integer NOT NULL');
  });
});

describe('diffSchemas', () => {
  it('reports added and removed tables', () => {
    const before = parseCreateTables('CREATE TABLE a (x int); CREATE TABLE b (y text);');
    const after = parseCreateTables('CREATE TABLE b (y text); CREATE TABLE c (z bool);');
    const diff = diffSchemas(before, after);
    expect(diff.addedTables.map(t => t.name)).toEqual(['c']);
    expect(diff.removedTables.map(t => t.name)).toEqual(['a']);
    expect(diff.modifiedTables).toEqual([]);
  });

  it('reports added columns on a modified table', () => {
    const before = parseCreateTables('CREATE TABLE t (id int, name text);');
    const after = parseCreateTables('CREATE TABLE t (id int, name text, email text);');
    const diff = diffSchemas(before, after);
    expect(diff.modifiedTables).toHaveLength(1);
    expect(diff.modifiedTables[0].name).toBe('t');
    expect(diff.modifiedTables[0].addedColumns.map(c => c.name)).toEqual(['email']);
    expect(diff.modifiedTables[0].removedColumns).toEqual([]);
    expect(diff.modifiedTables[0].modifiedColumns).toEqual([]);
  });

  it('reports removed columns on a modified table', () => {
    const before = parseCreateTables('CREATE TABLE t (id int, name text, old_col text);');
    const after = parseCreateTables('CREATE TABLE t (id int, name text);');
    const diff = diffSchemas(before, after);
    expect(diff.modifiedTables[0].removedColumns.map(c => c.name)).toEqual(['old_col']);
  });

  it('reports column definition changes as modified', () => {
    const before = parseCreateTables('CREATE TABLE t (id int, age integer);');
    const after = parseCreateTables('CREATE TABLE t (id int, age bigint NOT NULL);');
    const diff = diffSchemas(before, after);
    expect(diff.modifiedTables[0].modifiedColumns).toEqual([
      { name: 'age', before: 'integer', after: 'bigint NOT NULL' },
    ]);
  });

  it('reports combined added/removed/modified columns', () => {
    const before = parseCreateTables('CREATE TABLE t (a int, b text, c bool);');
    const after = parseCreateTables('CREATE TABLE t (a bigint, b text, d int);');
    const diff = diffSchemas(before, after);
    const mod = diff.modifiedTables[0];
    expect(mod.addedColumns.map(c => c.name)).toEqual(['d']);
    expect(mod.removedColumns.map(c => c.name)).toEqual(['c']);
    expect(mod.modifiedColumns.map(m => m.name)).toEqual(['a']);
  });

  it('returns empty diff when schemas are identical', () => {
    const sql = 'CREATE TABLE t (id int, name text);';
    const diff = diffSqlDumps(sql, sql);
    expect(diff).toEqual({ addedTables: [], removedTables: [], modifiedTables: [] });
  });

  it('produces deterministic (alphabetical) ordering', () => {
    const before = parseCreateTables('CREATE TABLE zulu (x int); CREATE TABLE alpha (y int);');
    const after = parseCreateTables('CREATE TABLE mike (z int); CREATE TABLE bravo (w int);');
    const diff = diffSchemas(before, after);
    expect(diff.addedTables.map(t => t.name)).toEqual(['bravo', 'mike']);
    expect(diff.removedTables.map(t => t.name)).toEqual(['alpha', 'zulu']);
  });
});

// ─── Route integration tests ───────────────────────────────────────────────

describe('GET /api/supabase/backups/diff', () => {
  beforeEach(async () => {
    vi.resetModules();
    getInstanceMock.mockReset();
    await rm(TEST_APP_DATA, { recursive: true, force: true });
    await mkdir(TEST_BACKUPS_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_APP_DATA, { recursive: true, force: true });
  });

  async function callGet(search: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const { GET } = await import('@/app/api/supabase/backups/diff/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(`http://localhost/api/supabase/backups/diff${search}`);
    const res = await (GET as unknown as (r: unknown) => Promise<Response>)(req);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body };
  }

  it('returns 400 when instanceId is missing', async () => {
    const { status, body } = await callGet('?fileA=a.sql&fileB=b.sql');
    expect(status).toBe(400);
    expect(body?.error).toBe('instanceId is required');
  });

  it('returns 400 when fileA or fileB is missing', async () => {
    const { status, body } = await callGet('?instanceId=x&fileA=a.sql');
    expect(status).toBe(400);
    expect(body?.error).toContain('fileA and fileB');
  });

  it('returns 400 for unsafe filename', async () => {
    const { status, body } = await callGet('?instanceId=x&fileA=../etc.sql&fileB=b.sql');
    expect(status).toBe(400);
    expect(body?.error).toBe('Invalid filename');
  });

  it('returns 400 when fileA equals fileB', async () => {
    const { status, body } = await callGet('?instanceId=x&fileA=BnG-CRM-daily-1.sql&fileB=BnG-CRM-daily-1.sql');
    expect(status).toBe(400);
    expect(body?.error).toContain('must be different');
  });

  it('returns 404 when instance not found', async () => {
    getInstanceMock.mockResolvedValueOnce(null);
    const { status } = await callGet('?instanceId=x&fileA=a-daily-1.sql&fileB=a-daily-2.sql');
    expect(status).toBe(404);
  });

  it('returns 400 for hosted instance', async () => {
    getInstanceMock.mockResolvedValueOnce({ id: 'h', name: 'H', type: 'hosted', connection: {} });
    const { status } = await callGet('?instanceId=h&fileA=H-daily-1.sql&fileB=H-daily-2.sql');
    expect(status).toBe(400);
  });

  it('returns 403 when a filename does not match the instance prefix', async () => {
    getInstanceMock.mockResolvedValueOnce({ id: 'loc1', name: 'BnG-CRM', type: 'local', connection: {} });
    const { status, body } = await callGet(
      '?instanceId=loc1&fileA=BnG-CRM-daily-a.sql&fileB=OtherInstance-daily-b.sql',
    );
    expect(status).toBe(403);
    expect(body?.error).toContain('do not belong');
  });

  it('returns 404 when a file does not exist on disk', async () => {
    getInstanceMock.mockResolvedValueOnce({ id: 'loc1', name: 'BnG-CRM', type: 'local', connection: {} });
    const { status, body } = await callGet(
      '?instanceId=loc1&fileA=BnG-CRM-daily-missing-a.sql&fileB=BnG-CRM-daily-missing-b.sql',
    );
    expect(status).toBe(404);
    expect(body?.error).toContain('not found');
  });

  it('returns structured diff for two real SQL files', async () => {
    getInstanceMock.mockResolvedValueOnce({ id: 'loc1', name: 'BnG-CRM', type: 'local', connection: {} });
    const sqlA = `
      CREATE TABLE users (id int, name text);
      CREATE TABLE old_stuff (x int);
    `;
    const sqlB = `
      CREATE TABLE users (id int, name text, email text);
      CREATE TABLE new_stuff (y int);
    `;
    await writeFile(path.join(TEST_BACKUPS_DIR, 'BnG-CRM-daily-before.sql'), sqlA);
    await writeFile(path.join(TEST_BACKUPS_DIR, 'BnG-CRM-daily-after.sql'), sqlB);
    const { status, body } = await callGet(
      '?instanceId=loc1&fileA=BnG-CRM-daily-before.sql&fileB=BnG-CRM-daily-after.sql',
    );
    expect(status).toBe(200);
    expect(body?.success).toBe(true);
    const diff = body?.diff as {
      addedTables: Array<{ name: string }>;
      removedTables: Array<{ name: string }>;
      modifiedTables: Array<{ name: string; addedColumns: Array<{ name: string }> }>;
    };
    expect(diff.addedTables.map(t => t.name)).toEqual(['new_stuff']);
    expect(diff.removedTables.map(t => t.name)).toEqual(['old_stuff']);
    expect(diff.modifiedTables).toHaveLength(1);
    expect(diff.modifiedTables[0].name).toBe('users');
    expect(diff.modifiedTables[0].addedColumns.map(c => c.name)).toEqual(['email']);
  });
});
