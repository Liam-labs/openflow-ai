import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/api-tracking', () => ({
  tracked: (_path: string, handler: (...args: never[]) => unknown) => handler,
}));

vi.mock('@/lib/fetch-utils', () => ({ fetchWithTimeout: vi.fn() }));

vi.mock('@/lib/supabase-instance-store', () => ({
  supabaseInstanceStore: { getInstance: vi.fn(), listInstances: vi.fn().mockResolvedValue([]) },
}));

const scanLocalSupabaseBackupsMock = vi.fn();
const listRunningSupabaseContainersMock = vi.fn();
const resolveKnownLocalSupabaseProjectsMock = vi.fn();
const getCustomRestoreStatusMock = vi.fn();
const getActiveCustomRestoreMock = vi.fn();
const initiateCustomRestoreMock = vi.fn();

vi.mock('@/lib/supabase-local-backups', () => ({
  scanLocalSupabaseBackups: (...args: unknown[]) => scanLocalSupabaseBackupsMock(...args),
  listRunningSupabaseContainers: (...args: unknown[]) => listRunningSupabaseContainersMock(...args),
  resolveKnownLocalSupabaseProjects: (...args: unknown[]) => resolveKnownLocalSupabaseProjectsMock(...args),
}));

vi.mock('@/lib/supabase-custom-restore', () => ({
  getCustomRestoreStatus: (...args: unknown[]) => getCustomRestoreStatusMock(...args),
  getActiveCustomRestore: (...args: unknown[]) => getActiveCustomRestoreMock(...args),
  initiateCustomRestore: (...args: unknown[]) => initiateCustomRestoreMock(...args),
}));

function request(url: string, method = 'GET', body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('/api/supabase/backups custom-format inventory and restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listRunningSupabaseContainersMock.mockResolvedValue({
      containers: new Set(['supabase_db_alpha']),
      apiPortSlugs: new Map([[54321, 'alpha']]),
      available: true,
      error: null,
    });
    resolveKnownLocalSupabaseProjectsMock.mockReturnValue(new Map([['alpha', 'Alpha']]));
    scanLocalSupabaseBackupsMock.mockResolvedValue({
      summary: {
        totalBackups: 1,
        totalProjects: 1,
        healthyProjects: 1,
        staleProjects: 0,
        offlineProjects: 0,
        unknownProjects: 0,
        lastBackupAt: '2026-07-28T11:00:00.000Z',
        totalSizeBytes: 2048,
      },
      projects: [],
    });
    getCustomRestoreStatusMock.mockResolvedValue(null);
    getActiveCustomRestoreMock.mockResolvedValue(null);
    initiateCustomRestoreMock.mockResolvedValue({ id: 'restore-123', status: 'pending' });
  });

  it('returns the complete inventory contract with active restore state', async () => {
    const { GET } = await import('@/app/api/supabase/backups/route');
    const response = await GET(request('http://localhost/api/supabase/backups?scope=inventory') as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      summary: { totalBackups: 1, totalProjects: 1 },
      projects: [],
      restore: { active: null },
    });
  });

  it('requires exact typed confirmation before a custom restore can start', async () => {
    const { POST } = await import('@/app/api/supabase/backups/route');
    const response = await POST(request('http://localhost/api/supabase/backups', 'POST', {
      action: 'restore-custom',
      projectSlug: 'alpha',
      filename: 'alpha-hourly-2026-07-28T11.dump',
      confirmProjectSlug: 'ALPHA',
    }) as never);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('exactly match');
    expect(initiateCustomRestoreMock).not.toHaveBeenCalled();
  });

  it('returns 202 and a restore id without waiting for the restore command', async () => {
    const { POST } = await import('@/app/api/supabase/backups/route');
    const response = await POST(request('http://localhost/api/supabase/backups', 'POST', {
      action: 'restore-custom',
      projectSlug: 'alpha',
      filename: 'alpha-hourly-2026-07-28T11.dump',
      confirmProjectSlug: 'alpha',
    }) as never);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true, restoreId: 'restore-123' });
    expect(initiateCustomRestoreMock).toHaveBeenCalledWith(expect.objectContaining({
      projectSlug: 'alpha',
      filename: 'alpha-hourly-2026-07-28T11.dump',
    }));
  });

  it('exposes asynchronous restore status by id', async () => {
    getCustomRestoreStatusMock.mockResolvedValue({ id: 'restore-123', status: 'running' });
    const { GET } = await import('@/app/api/supabase/backups/route');
    const response = await GET(request(
      'http://localhost/api/supabase/backups?action=restore-status&restoreId=restore-123',
    ) as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      status: { id: 'restore-123', status: 'running' },
    });
  });
});
