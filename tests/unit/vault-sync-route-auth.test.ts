import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: vi.fn().mockResolvedValue(null),
  requireTokenOrLocal: vi.fn().mockResolvedValue(
    NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
  ),
}));

vi.mock('@/lib/api-tracking', () => ({
  tracked: (_path: string, handler: Function) => handler,
}));

import { POST } from '@/app/api/vault/sync-secrets/route';
import { requireAuthOrLocal, requireTokenOrLocal } from '@/lib/api-auth';

describe('POST /api/vault/sync-secrets authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts an authenticated webgate request instead of requiring a bearer token', async () => {
    const request = new NextRequest('http://localhost:3000/api/vault/sync-secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add' }),
    });

    const response = await POST(request);

    expect(requireAuthOrLocal).toHaveBeenCalledWith(request, 'write');
    expect(requireTokenOrLocal).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });
});
