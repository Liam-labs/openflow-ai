import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fsSync from 'node:fs';
import nodePath from 'node:path';

const { root } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'summary-route-')) };
});

vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: vi.fn(async () => null) }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_n: string, h: unknown) => h }));
vi.mock('@/lib/dashboard-auth', () => ({ hasPassword: async () => true }));
vi.mock('@/lib/data-paths', () => {
  const p = (n: string) => nodePath.join(root, n);
  return { DataPaths: { remoteAccess: p('remote.json'), cloudflareAccess: p('cf.json'), browserUse: p('browser.json'), memoryWizard: p('memory-wizard.json') } };
});

import { GET } from '@/app/api/setup/summary/route';

beforeEach(() => { fsSync.rmSync(nodePath.join(root, 'setup-channel.json'), { force: true }); });

describe('GET /api/setup/summary', () => {
  it('lists what is set up and names the Setup channel once it exists, and nothing secret', async () => {
    fsSync.writeFileSync(nodePath.join(root, 'remote.json'), JSON.stringify({ enabled: true, tailscale: { url: 'https://x.ts.net' } }));
    fsSync.writeFileSync(nodePath.join(root, 'setup-channel.json'), JSON.stringify({ channelId: 'setup-1' }));
    const res = await GET(new NextRequest('http://localhost/api/setup/summary'));
    const text = await res.text();
    const json = JSON.parse(text);
    expect(json.success).toBe(true);
    expect(json.setupChannelId).toBe('setup-1');
    expect(Object.fromEntries(json.items.map((i: { id: string; state: string }) => [i.id, i.state]))).toMatchObject({ password: 'on', 'phone-access': 'on', memory: 'off' });
    expect(text).not.toContain('ts.net');
  });

  it('has no Setup channel id before the wizard made one', async () => {
    const json = await (await GET(new NextRequest('http://localhost/api/setup/summary'))).json();
    expect(json.setupChannelId).toBeNull();
  });
});
