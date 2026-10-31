// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { importPathAllowed } from '@/lib/docs-import-path';

describe('importPathAllowed', () => {
  const roots = { home: '/home/u', app: '/srv/app' };
  it('allows the app folder and visible home folders', () => {
    expect(importPathAllowed('/srv/app/docs/a.md', roots)).toBe(true);
    expect(importPathAllowed('/home/u/notes/a.md', roots)).toBe(true);
  });
  it('blocks hidden and sensitive home folders and the bare home folder', () => {
    expect(importPathAllowed('/home/u/.ssh/a.txt', roots)).toBe(false);
    expect(importPathAllowed('/home/u/.claude/rules/a.md', roots)).toBe(false);
    expect(importPathAllowed('/home/u/Secrets/a.md', roots)).toBe(false);
    expect(importPathAllowed('/home/u', roots)).toBe(false);
    expect(importPathAllowed('/home/u/a.md', roots)).toBe(true);
  });
  it('blocks other places and sibling-prefix folders', () => {
    expect(importPathAllowed('/etc/a.md', roots)).toBe(false);
    expect(importPathAllowed('/home/user2/a.md', roots)).toBe(false);
    expect(importPathAllowed('/srv/app-secrets/a.md', roots)).toBe(false);
    expect(importPathAllowed('relative/a.md', roots)).toBe(false);
  });
});

describe('POST /api/docs/import', () => {
  let home: string;
  let POST: (r: NextRequest) => Promise<Response>;
  const call = async (p: string) => {
    const res = await POST(new NextRequest('http://localhost:3000/api/docs/import', { method: 'POST', body: JSON.stringify({ path: p }), headers: { 'content-type': 'application/json', host: 'localhost:3000' } }));
    return { status: res.status, body: await res.json() };
  };
  beforeAll(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-import-')));
    fs.mkdirSync(path.join(home, 'docs'));
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, 'docs', 'ok.md'), '# fine');
    fs.writeFileSync(path.join(home, '.ssh', 'notes.txt'), 'hidden-content');
    fs.symlinkSync(path.join(home, '.ssh', 'notes.txt'), path.join(home, 'docs', 'link.txt'));
    process.env.HOME = home;
    vi.resetModules();
    vi.doMock('@/lib/api-auth', () => ({ requireAuthOrLocal: async () => null }));
    vi.doMock('@/lib/api-tracking', () => ({ tracked: (_n: string, fn: unknown) => fn }));
    POST = (await import('@/app/api/docs/import/route')).POST as unknown as typeof POST;
  });
  afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('reads an ordinary file', async () => {
    const r = await call(path.join(home, 'docs', 'ok.md'));
    expect(r.status).toBe(200);
    expect(r.body.content).toContain('fine');
  });
  it('refuses a ".." path that lands in a hidden folder', async () => {
    const r = await call(home + '/docs/../.ssh/notes.txt');
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain('hidden-content');
  });
  it('refuses a symlink in a visible folder that points into a hidden one', async () => {
    const r = await call(path.join(home, 'docs', 'link.txt'));
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain('hidden-content');
  });
  it('answers a missing file in a hidden folder like an existing one, and never names the path', async () => {
    const r = await call(home + '/docs/../.ssh/nope.txt');
    expect(r.status).toBe(403);
    const missing = await call(path.join(home, 'docs', 'nope.md'));
    expect(missing.status).toBe(404);
    expect(JSON.stringify(missing.body)).not.toContain(home);
  });
});
