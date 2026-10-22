/**
 * POST /api/collab/workspace — a channel's project folder, for the delete-channel dialog.
 *
 * Body: { action: 'status' | 'delete', channelId, discardUnsavedGit? }
 *  - status: where the folder is, whether it may be deleted (and why not), size and unsaved git work.
 *  - delete: remove it from the agent host (and the server's empty placeholder). the owner chooses this in the
 *    dialog; the channel's agents are stopped first by the caller. Works for live or archived channels.
 *    A folder with unsaved git work is removed only when `discardUnsavedGit` is exactly true, which the dialog
 *    sends after showing what would be lost and getting a ticked confirmation.
 */
import { NextRequest, NextResponse } from 'next/server';

import { requireAuthOrLocal } from '@/lib/api-auth';
import { deleteChannelWorkspace, getChannelWorkspaceStatus } from '@/lib/channel-workspace';
import { readData } from '../_collab-shared';

export async function POST(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  const body = await request.json().catch(() => ({})) as { action?: string; channelId?: string; discardUnsavedGit?: unknown };
  if (!body.channelId) return NextResponse.json({ success: false, error: 'channelId is required' }, { status: 400 });
  try {
    const data = await readData();
    if (body.action === 'status') {
      return NextResponse.json({ success: true, workspace: await getChannelWorkspaceStatus(body.channelId, data) });
    }
    if (body.action === 'delete') {
      return NextResponse.json({ success: true, ...(await deleteChannelWorkspace(body.channelId, data, { discardUnsavedGit: body.discardUnsavedGit === true })) });
    }
    return NextResponse.json({ success: false, error: 'action must be status or delete' }, { status: 400 });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
