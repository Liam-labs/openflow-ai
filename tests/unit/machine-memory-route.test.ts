import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({ requireAuthOrLocal: vi.fn(), getMachineMemory: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: mocks.requireAuthOrLocal }));
vi.mock('@/lib/system-memory', () => ({ getMachineMemory: mocks.getMachineMemory }));

import { GET } from '@/app/api/system/machine-memory/route';

const call = () => GET(new NextRequest('http://localhost/api/system/machine-memory'));

describe('GET /api/system/machine-memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthOrLocal.mockResolvedValue(null);
    mocks.getMachineMemory.mockResolvedValue({ generatedAt: 'now', machines: [{ id: 'server', label: 'Remote server', reachable: true }] });
  });

  it('needs read access, and reads nothing without it', async () => {
    mocks.requireAuthOrLocal.mockResolvedValue(NextResponse.json({ error: 'no' }, { status: 401 }));
    const res = await call();
    expect(res.status).toBe(401);
    expect(mocks.requireAuthOrLocal).toHaveBeenCalledWith(expect.anything(), 'read');
    expect(mocks.getMachineMemory).not.toHaveBeenCalled();
  });

  it('returns both machines and tells browsers not to keep it', async () => {
    const res = await call();
    expect(await res.json()).toEqual({ generatedAt: 'now', machines: [{ id: 'server', label: 'Remote server', reachable: true }] });
    expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0');
  });

  it('answers 500 with a plain message and no internals when the read fails', async () => {
    mocks.getMachineMemory.mockRejectedValue(new Error('internal detail'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not read the machines' memory", code: 'INTERNAL' });
  });
});
