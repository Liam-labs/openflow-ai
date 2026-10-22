/**
 * Sidebar group handlers: create_group, rename_group, reorder_groups, delete_group,
 * move_channel_to_group. The model and the rules are in lib/collab-groups.ts.
 *
 * The dispatcher runs every action inside mutateChannels, so each change is one locked read, one
 * change and one write. The first group change on a file that still has tabs also migrates them
 * (with a copy of the file first), so a group action never depends on the read having run before it.
 */

import { NextResponse } from 'next/server';
import { backupChannelsFile, saveChannels } from '@/lib/collab-channel-store';
import {
  createGroup,
  deleteGroup,
  hasChannelGroups,
  moveChannelToGroup,
  renameGroup,
  reorderGroups,
  type GroupResult,
} from '@/lib/collab-groups';
import type {
  ChannelGroup,
  CollabChannelActionRequest,
  CollabChannelActionResponse,
  CollabChannelsData,
} from '@/lib/types';

type Reply = NextResponse<CollabChannelActionResponse>;

/** Apply one change and save it. Nothing is saved, or migrated, when the change is refused. */
async function commit<T extends { groups: ChannelGroup[] }>(
  data: CollabChannelsData,
  change: () => GroupResult<T>,
): Promise<GroupResult<T>> {
  const wasMigrated = hasChannelGroups(data);
  const result = change();
  if (!result.ok) return result;
  if (!wasMigrated) {
    const copy = await backupChannelsFile(data, 'before-groups');
    console.info(`[Groups] tabs migrated to groups by the first group change; copy of the channels file: ${copy ?? 'none, there was no file'}`);
  }
  await saveChannels(data);
  return result;
}

function refused(result: { status: number; error: string }): Reply {
  return NextResponse.json<CollabChannelActionResponse>({ success: false, error: result.error }, { status: result.status });
}

export async function handleCreateGroup(data: CollabChannelsData, body: CollabChannelActionRequest): Promise<Reply> {
  const result = await commit(data, () => createGroup(data, body.groupName));
  if (!result.ok) return refused(result);
  return NextResponse.json<CollabChannelActionResponse>({ success: true, group: result.group, channelGroups: result.groups });
}

export async function handleRenameGroup(data: CollabChannelsData, body: CollabChannelActionRequest): Promise<Reply> {
  const result = await commit(data, () => renameGroup(data, body.groupId, body.groupName));
  if (!result.ok) return refused(result);
  return NextResponse.json<CollabChannelActionResponse>({ success: true, group: result.group, channelGroups: result.groups });
}

export async function handleReorderGroups(data: CollabChannelsData, body: CollabChannelActionRequest): Promise<Reply> {
  const result = await commit(data, () => reorderGroups(data, body.groupIds));
  if (!result.ok) return refused(result);
  return NextResponse.json<CollabChannelActionResponse>({ success: true, channelGroups: result.groups });
}

export async function handleDeleteGroup(data: CollabChannelsData, body: CollabChannelActionRequest): Promise<Reply> {
  const result = await commit(data, () => deleteGroup(data, body.groupId));
  if (!result.ok) return refused(result);
  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelGroups: result.groups,
    movedTo: result.movedTo,
    movedChannelCount: result.movedChannelCount,
  });
}

export async function handleMoveChannelToGroup(data: CollabChannelsData, body: CollabChannelActionRequest): Promise<Reply> {
  const result = await commit(data, () => moveChannelToGroup(data, body.channelId, body.groupId));
  if (!result.ok) return refused(result);
  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: body.channelId,
    channelGroups: result.groups,
  });
}
