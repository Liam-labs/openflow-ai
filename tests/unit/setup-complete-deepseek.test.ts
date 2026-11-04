/**
 * POST /api/setup/complete: the DeepSeek key moves to the Connections store and no copy stays in credentials.json.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fsSync from 'node:fs';
import nodePath from 'node:path';

const { root, saveConnectorKey } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-ds-'));
  return { root, saveConnectorKey: vi.fn(async () => undefined) };
});

vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: vi.fn(async () => null) }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_n: string, h: unknown) => h }));
vi.mock('@/lib/connectors/secrets', () => ({ saveConnectorKey }));
vi.mock('@/lib/data-paths', () => {
  const p = (name: string) => nodePath.join(root, name);
  return { DataPaths: { user: { profile: p('profile.json'), credentials: p('credentials.json'), integrations: p('integrations.json'), team: p('team.json') } } };
});

import { POST } from '@/app/api/setup/complete/route';

const credentialsFile = nodePath.join(root, 'credentials.json');
const write = (name: string, value: unknown) => fsSync.writeFileSync(nodePath.join(root, name), JSON.stringify(value));

beforeEach(() => {
  saveConnectorKey.mockClear();
  write('profile.json', { name: 'Sam' });
  write('integrations.json', {});
  write('team.json', {});
});

describe('/api/setup/complete with a DeepSeek key', () => {
  it('saves it to the Connections store and leaves no copy in credentials.json', async () => {
    write('credentials.json', { deepseekApiKey: 'sk-secret-1', ollamaUrl: '' });
    const res = await POST(new NextRequest('http://localhost/api/setup/complete', { method: 'POST' }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.summary.providers).toContain('DeepSeek');
    expect(saveConnectorKey).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-secret-1', new Set(['DEEPSEEK_API_KEY']));
    const left = fsSync.readFileSync(credentialsFile, 'utf-8');
    expect(left).not.toContain('sk-secret-1');
    expect(JSON.parse(left).deepseekApiKey).toBe('');
    expect(JSON.stringify(json)).not.toContain('sk-secret-1');
  });

  it('does nothing about DeepSeek when no key was given', async () => {
    write('credentials.json', { ollamaUrl: '' });
    await POST(new NextRequest('http://localhost/api/setup/complete', { method: 'POST' }));
    expect(saveConnectorKey).not.toHaveBeenCalled();
  });
});
