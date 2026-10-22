/**
 * POST /api/collab/workspace: the delete action may only discard unsaved git work when the body says exactly `true`.
 * (18 Oct 2026: Owner can delete a channel's folder even when git shows uncommitted changes, after the dialog warns him.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: vi.fn().mockResolvedValue(null) }));
vi.mock('@/app/api/collab/_collab-shared', () => ({ readData: async () => ({ channels: [] }) }));

const deleteChannelWorkspace = vi.fn();
const getChannelWorkspaceStatus = vi.fn();
vi.mock('@/lib/channel-workspace', () => ({
  deleteChannelWorkspace: (...a: unknown[]) => deleteChannelWorkspace(...a),
  getChannelWorkspaceStatus: (...a: unknown[]) => getChannelWorkspaceStatus(...a),
}));

const { POST } = await import('@/app/api/collab/workspace/route');

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/collab/workspace', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => {
  deleteChannelWorkspace.mockReset().mockResolvedValue({ removed: true, path: '/home/user/Showcase' });
  getChannelWorkspaceStatus.mockReset().mockResolvedValue({ eligible: true });
});

describe('workspace route: discardUnsavedGit', () => {
  it('passes the override on only for a literal true', async () => {
    await post({ action: 'delete', channelId: 'c1', discardUnsavedGit: true });
    expect(deleteChannelWorkspace).toHaveBeenLastCalledWith('c1', expect.anything(), { discardUnsavedGit: true });
  });

  it.each([['"true"', 'true'], ['1', 1], ['"yes"', 'yes'], ['an object', { a: 1 }], ['null', null], ['false', false]])(
    'does not treat %s as permission to discard unsaved work',
    async (_label, value) => {
      await post({ action: 'delete', channelId: 'c1', discardUnsavedGit: value });
      expect(deleteChannelWorkspace).toHaveBeenLastCalledWith('c1', expect.anything(), { discardUnsavedGit: false });
    },
  );

  it('defaults to keeping the safety check when the field is missing', async () => {
    await post({ action: 'delete', channelId: 'c1' });
    expect(deleteChannelWorkspace).toHaveBeenLastCalledWith('c1', expect.anything(), { discardUnsavedGit: false });
  });

  it('shows the folder status without deleting anything', async () => {
    const res = await post({ action: 'status', channelId: 'c1', discardUnsavedGit: true });
    expect(res.status).toBe(200);
    expect(deleteChannelWorkspace).not.toHaveBeenCalled();
  });

  it('reports a refusal from the host as an error, not a success', async () => {
    deleteChannelWorkspace.mockRejectedValue(Object.assign(new Error('folder kept, programs are still running inside it'), { statusCode: 409 }));
    const res = await post({ action: 'delete', channelId: 'c1', discardUnsavedGit: true });
    expect(res.status).toBe(409);
    expect((await res.json()).success).toBe(false);
  });
});
