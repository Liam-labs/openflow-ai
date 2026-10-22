/**
 * Tests for GET /api/supabase/overview
 *
 * Tests the overview data aggregation logic:
 * - Instance resolution
 * - DB size query
 * - User count query
 * - Service health checks
 * - Response shape matching OverviewData interface
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing route
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

const mockPgClient = {
  query: vi.fn(),
  release: vi.fn(),
};

vi.mock('pg', () => {
  return {
    Pool: function() { return { connect: () => Promise.resolve(mockPgClient) }; },
  };
});

import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { fetchWithTimeout } from '@/lib/fetch-utils';
import type { SupabaseInstance } from '@/lib/supabase-types';

// Helper to create a mock NextRequest
function mockRequest(url: string): Request {
  return new Request(url);
}

const LOCAL_INSTANCE: SupabaseInstance = {
  id: 'test-local',
  name: 'Local Dev',
  type: 'local',
  connection: {
    url: 'http://localhost:54321',
    anonKeyEnvVar: 'SUPABASE_ANON_KEY',
    serviceRoleKeyEnvVar: 'SUPABASE_SECRET_KEY',
    dbConnectionStringEnvVar: 'DATABASE_URL',
  },
  linkedProjects: [],
  status: 'online',
  lastCheckedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const HOSTED_INSTANCE: SupabaseInstance = {
  id: 'test-hosted',
  name: 'Production',
  type: 'hosted',
  connection: {
    url: 'https://abc.supabase.co',
    anonKeyEnvVar: 'SUPABASE_ANON_KEY',
    serviceRoleKeyEnvVar: 'SUPABASE_SECRET_KEY',
    projectId: 'abc123',
  },
  linkedProjects: [],
  status: 'online',
  lastCheckedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('GET /api/supabase/overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_ACCESS_TOKEN = 'test-token';
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  });

  it('returns 400 when instanceId is missing', async () => {
    const { GET } = await import('@/app/api/supabase/overview/route');
    const req = mockRequest('http://localhost:3000/api/supabase/overview');
    const res = await GET(req as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/instanceId/i);
  });

  it('returns 404 when instance not found', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(null);

    const { GET } = await import('@/app/api/supabase/overview/route');
    const req = mockRequest('http://localhost:3000/api/supabase/overview?instanceId=nonexistent');
    const res = await GET(req as any);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns correct OverviewData shape for local instance', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);

    // DB size query
    mockPgClient.query.mockResolvedValueOnce({ rows: [{ size_mb: 42.5 }] });
    // User count query
    mockPgClient.query.mockResolvedValueOnce({ rows: [{ count: '150' }] });

    // Mock service health checks
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      new Response('ok', { status: 200 }) as any
    );

    const { GET } = await import('@/app/api/supabase/overview/route');
    const req = mockRequest('http://localhost:3000/api/supabase/overview?instanceId=test-local');
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();

    const data = body.data;
    // Verify all required fields from OverviewData interface
    expect(typeof data.dbSizeMb).toBe('number');
    expect(typeof data.apiRequestsToday).toBe('number');
    expect(typeof data.usersTotal).toBe('number');
    expect(typeof data.errorsToday).toBe('number');
    expect(Array.isArray(data.apiRequestsHistory)).toBe(true);
    expect(data.apiRequestsHistory).toHaveLength(24);
    expect(Array.isArray(data.services)).toBe(true);
  });

  it('services array contains expected service names', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);

    mockPgClient.query.mockResolvedValueOnce({ rows: [{ size_mb: 10 }] });
    mockPgClient.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    vi.mocked(fetchWithTimeout).mockResolvedValue(
      new Response('ok', { status: 200 }) as any
    );

    const { GET } = await import('@/app/api/supabase/overview/route');
    const req = mockRequest('http://localhost:3000/api/supabase/overview?instanceId=test-local');
    const res = await GET(req as any);
    const { data } = await res.json();

    const serviceNames = data.services.map((s: any) => s.name);
    expect(serviceNames).toContain('REST');
    expect(serviceNames).toContain('Auth');
    expect(serviceNames).toContain('Realtime');
    expect(serviceNames).toContain('Storage');
  });

  it('service health reports correct status and latency', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);

    mockPgClient.query.mockResolvedValueOnce({ rows: [{ size_mb: 10 }] });
    mockPgClient.query.mockResolvedValueOnce({ rows: [{ count: '5' }] });

    vi.mocked(fetchWithTimeout).mockResolvedValue(
      new Response('ok', { status: 200 }) as any
    );

    const { GET } = await import('@/app/api/supabase/overview/route');
    const req = mockRequest('http://localhost:3000/api/supabase/overview?instanceId=test-local');
    const res = await GET(req as any);
    const { data } = await res.json();

    for (const svc of data.services) {
      expect(['up', 'degraded', 'down', 'unknown']).toContain(svc.status);
      expect(typeof svc.latencyMs).toBe('number');
    }
  });

  it('handles service health check failures gracefully', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);

    mockPgClient.query.mockResolvedValueOnce({ rows: [{ size_mb: 10 }] });
    mockPgClient.query.mockResolvedValueOnce({ rows: [{ count: '5' }] });

    // Services return errors
    vi.mocked(fetchWithTimeout).mockRejectedValue(new Error('Connection refused'));

    const { GET } = await import('@/app/api/supabase/overview/route');
    const req = mockRequest('http://localhost:3000/api/supabase/overview?instanceId=test-local');
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    const { data } = await res.json();
    // Should still return data with services marked as down
    expect(data.services.every((s: any) => s.status === 'down')).toBe(true);
  });

  it('handles DB query failure gracefully', async () => {
    vi.mocked(supabaseInstanceStore.getInstance).mockResolvedValue(LOCAL_INSTANCE);

    mockPgClient.query.mockRejectedValue(new Error('Connection refused'));

    const { GET } = await import('@/app/api/supabase/overview/route');
    const req = mockRequest('http://localhost:3000/api/supabase/overview?instanceId=test-local');
    const res = await GET(req as any);
    expect(res.status).toBe(500);
  });
});
