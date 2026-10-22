import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/api-tracking', () => ({
  tracked: (_path: string, handler: (...args: never[]) => unknown) => handler,
}));
vi.mock('@/lib/fetch-utils', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('@/lib/supabase-instance-store', () => ({
  supabaseInstanceStore: {
    getInstance: vi.fn().mockResolvedValue({
      id: 'src-uuid',
      name: 'SourceDB',
      type: 'local',
      connection: { url: 'http://localhost:54322' },
    }),
  },
}));

describe('POST /api/supabase/backups — retired local SQL restores', () => {
  it.each(['restore', 'restore-to-other'])('returns 410 for legacy action=%s', async action => {
    const { POST } = await import('@/app/api/supabase/backups/route');
    const request = new Request('http://localhost/api/supabase/backups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instanceId: 'src-uuid',
        action,
        filename: 'SourceDB-daily.sql',
        sourceBackupFile: 'SourceDB-daily.sql',
        targetInstanceId: 'target-uuid',
        confirmTargetName: 'TargetDB',
      }),
    });
    const response = await POST(request as never);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      deprecated: true,
      replacement: 'restore-custom',
    });
  });
});
