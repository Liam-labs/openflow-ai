import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  validateApiToken: vi.fn(),
  hasPermission: vi.fn(),
  findActiveDesignReferenceGate: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  validateApiToken: mocks.validateApiToken,
  hasPermission: mocks.hasPermission,
}));

vi.mock('@/lib/design-references/store', () => ({
  findActiveDesignReferenceGate: mocks.findActiveDesignReferenceGate,
}));

import { GET } from '@/app/api/design-references/active/route';

function request(query = 'workspacePath=%2Ftmp%2Fproject&sessionId=native-1&launcherPid=4242') {
  return new NextRequest(`http://localhost:3000/api/design-references/active?${query}`);
}

describe('GET /api/design-references/active', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateApiToken.mockResolvedValue({ valid: true, token: { scope: 'read' } });
    mocks.hasPermission.mockReturnValue(true);
  });

  it('requires an authenticated read token and never uses localhost as authority', async () => {
    mocks.validateApiToken.mockResolvedValue({ valid: false });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.findActiveDesignReferenceGate).not.toHaveBeenCalled();
  });

  it('passes the canonical workspace and launcher identities to the server lookup', async () => {
    mocks.findActiveDesignReferenceGate.mockResolvedValue({
      status: 'active',
      identity: {
        participantId: 'roster-architect',
        launcherSessionId: 'session:native-1',
        workspacePath: '/tmp/project',
      },
      createdAt: '2026-08-30T16:00:00.000Z',
      authorization: { boardId: 'board-1', implementationUnlocked: false },
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.findActiveDesignReferenceGate).toHaveBeenCalledWith(
      '/tmp/project',
      ['session:native-1', 'pid:4242'],
    );
    expect(await response.json()).toMatchObject({ status: 'active' });
  });

  it.each([
    ['identity-mismatch', 409],
    ['ambiguous', 503],
  ] as const)('maps %s to a fail-closed HTTP status', async (status, expectedStatus) => {
    mocks.findActiveDesignReferenceGate.mockResolvedValue({ status, error: 'blocked' });

    const response = await GET(request());

    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
