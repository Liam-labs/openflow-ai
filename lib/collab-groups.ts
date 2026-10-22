/**
 * Sidebar groups: the ordered list that channels are organised into.
 *
 * This replaces the tab model in lib/collab-sidebar-logic.ts (Work / Life / Fun + one stored tab).
 * Every group, Work, Life and Fun included, can be renamed, reordered and deleted. The list is stored
 * as `channelGroups` in collab-channels.json; a channel's group is still `settings.category`.
 *
 * Everything here is pure (no file access), so the server handlers and the sidebar share one
 * definition of which group a channel is in. The mutating helpers work on the `data` they are given;
 * the caller (app/api/collab/_handlers/groups.ts) runs them inside `mutateChannels` and saves.
 *
 * Migration: `channelGroups` is seeded from the tabs, with the same ids, so every `settings.category`
 * stays valid and no channel is rewritten. `channelTabs` stays in the file for rollback.
 *
 * Where a channel appears:
 *   - a category that names a group                -> that group
 *   - no category, or a category with no such group -> the home group: 'work' while it exists, else
 *     the first group.
 *     12 of the owner's 38 top-level channels have no category and sit in Work today. Reordering or
 *     renaming groups must never move a channel, so the fallback is the home group, not whichever
 *     group happens to be first. (The plan said "first group" for a missing group; the two are the
 *     same until Work is moved, and this way a reorder is only a reorder.)
 */

import { resolveChannelTabs } from './collab-sidebar-logic';
import type { ChannelGroup, CollabChannelsData } from './types';

/** The home group's id: where channels that were never filed appear. Never given to a new group. */
export const DEFAULT_GROUP_ID = 'work';
export const MAX_GROUP_NAME_LENGTH = 24;
export const MAX_GROUPS = 30;
const MAX_REORDER_IDS = 200;

/** What the sidebar needs to know about a channel to place it. */
export interface GroupedChannel {
  id: string;
  parentChannelId?: string;
  settings?: { category?: string };
}

export type GroupResult<T> = ({ ok: true } & T) | { ok: false; status: 400 | 404; error: string };

function fail(status: 400 | 404, error: string): { ok: false; status: 400 | 404; error: string } {
  return { ok: false, status, error };
}

// ---------------------------------------------------------------------------
// Reading the list
// ---------------------------------------------------------------------------

/** The stored list with unusable entries and repeated ids dropped, or null when nothing usable is stored. */
function cleanGroups(raw: unknown): ChannelGroup[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const groups: ChannelGroup[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    const cleanId = id.trim();
    const cleanName = name.trim();
    if (!cleanId || !cleanName || seen.has(cleanId)) continue;
    seen.add(cleanId);
    groups.push({ id: cleanId, name: cleanName });
  }
  return groups.length > 0 ? groups : null;
}

/** True once the groups have been migrated into the file. */
export function hasChannelGroups(data: Pick<CollabChannelsData, 'channelGroups'>): boolean {
  return cleanGroups(data.channelGroups) !== null;
}

/** The groups the tabs would become: Work, Life, Fun, then the stored tabs, same ids. */
export function seedChannelGroups(data: Pick<CollabChannelsData, 'channelTabs'>): ChannelGroup[] {
  return resolveChannelTabs(data.channelTabs).map(({ id, name }) => ({ id, name }));
}

/** The ordered groups: the stored list, or the seed when the file has not been migrated yet. A fresh copy. */
export function resolveChannelGroups(
  data: Pick<CollabChannelsData, 'channelGroups' | 'channelTabs'>,
): ChannelGroup[] {
  return cleanGroups(data.channelGroups) ?? seedChannelGroups(data);
}

/** Store the seed when no usable list is stored. Returns true when it changed `data`. Idempotent. */
export function migrateChannelGroups(
  data: Pick<CollabChannelsData, 'channelGroups' | 'channelTabs'>,
): boolean {
  if (hasChannelGroups(data)) return false;
  data.channelGroups = seedChannelGroups(data);
  return true;
}

// ---------------------------------------------------------------------------
// Which group a channel is in
// ---------------------------------------------------------------------------

/** Where channels that were never filed appear: Work while it exists, otherwise the first group. */
export function homeGroupId(groups: readonly ChannelGroup[]): string {
  return groups.some(group => group.id === DEFAULT_GROUP_ID) ? DEFAULT_GROUP_ID : groups[0].id;
}

/** The group a top-level channel is shown in. Sub-channels follow their parent. */
export function getChannelGroupId(
  channel: Pick<GroupedChannel, 'settings'>,
  groups: readonly ChannelGroup[],
): string {
  const category = channel.settings?.category;
  return category && groups.some(group => group.id === category) ? category : homeGroupId(groups);
}

/** Top-level channels shown in a group. */
export function filterParentsByGroup<T extends Pick<GroupedChannel, 'settings'>>(
  parents: readonly T[],
  groupId: string,
  groups: readonly ChannelGroup[],
): T[] {
  return parents.filter(parent => getChannelGroupId(parent, groups) === groupId);
}

/** Unread totals per group, counting each parent plus its sub-channels. */
export function unreadByGroup<T extends GroupedChannel>(
  parents: readonly T[],
  subChannelsByParent: Readonly<Record<string, readonly { id: string }[]>>,
  unreadCounts: Readonly<Record<string, number>>,
  groups: readonly ChannelGroup[],
): Record<string, number> {
  const totals: Record<string, number> = Object.fromEntries(groups.map(group => [group.id, 0]));
  for (const parent of parents) {
    const groupId = getChannelGroupId(parent, groups);
    let count = unreadCounts[parent.id] || 0;
    for (const sub of subChannelsByParent[parent.id] ?? []) count += unreadCounts[sub.id] || 0;
    totals[groupId] = (totals[groupId] || 0) + count;
  }
  return totals;
}

/** Which group every top-level channel is shown in, by channel id. */
export function assignChannelsToGroups(
  channels: readonly GroupedChannel[],
  groups: readonly ChannelGroup[],
): Record<string, string> {
  const assignment: Record<string, string> = {};
  for (const channel of channels) {
    if (!channel.parentChannelId) assignment[channel.id] = getChannelGroupId(channel, groups);
  }
  return assignment;
}

// ---------------------------------------------------------------------------
// Changing the list
// ---------------------------------------------------------------------------

function normaliseName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
}

function nameLength(name: string): number {
  return Array.from(name).length;
}

/** A group name that is 1 to 24 characters and not already used (ignoring case). */
export function validateGroupName(
  raw: unknown,
  groups: readonly ChannelGroup[],
  exceptId?: string,
): { name: string } | { error: string } {
  const name = normaliseName(raw);
  if (!name) return { error: 'Give the group a name.' };
  if (nameLength(name) > MAX_GROUP_NAME_LENGTH) {
    return { error: `A group name can be up to ${MAX_GROUP_NAME_LENGTH} characters.` };
  }
  const key = name.toLocaleLowerCase();
  if (groups.some(group => group.id !== exceptId && group.name.toLocaleLowerCase() === key)) {
    return { error: `There is already a group called "${name}".` };
  }
  return { name };
}

/** Ids already used as a channel's category, so a new group never inherits a channel by accident. */
function usedCategories(data: Pick<CollabChannelsData, 'channels'>): Set<string> {
  const used = new Set<string>();
  for (const channel of data.channels ?? []) {
    const category = channel.settings?.category;
    if (category) used.add(category);
  }
  return used;
}

function newGroupId(
  name: string,
  groups: readonly ChannelGroup[],
  used: ReadonlySet<string>,
): string {
  const base = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
  const taken = (id: string) => id === DEFAULT_GROUP_ID || used.has(id) || groups.some(group => group.id === id);
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

/** Add a group at the end. */
export function createGroup(
  data: CollabChannelsData,
  rawName: unknown,
): GroupResult<{ group: ChannelGroup; groups: ChannelGroup[] }> {
  const groups = resolveChannelGroups(data);
  if (groups.length >= MAX_GROUPS) return fail(400, `You can have up to ${MAX_GROUPS} groups.`);
  const checked = validateGroupName(rawName, groups);
  if ('error' in checked) return fail(400, checked.error);
  const group = { id: newGroupId(checked.name, groups, usedCategories(data)), name: checked.name };
  data.channelGroups = [...groups, group];
  return { ok: true, group, groups: data.channelGroups };
}

/** Change a group's name. Its id, and so every channel in it, stays the same. */
export function renameGroup(
  data: CollabChannelsData,
  groupId: unknown,
  rawName: unknown,
): GroupResult<{ group: ChannelGroup; groups: ChannelGroup[] }> {
  const groups = resolveChannelGroups(data);
  const index = typeof groupId === 'string' ? groups.findIndex(group => group.id === groupId) : -1;
  if (index === -1) return fail(404, 'That group no longer exists.');
  const checked = validateGroupName(rawName, groups, groups[index].id);
  if ('error' in checked) return fail(400, checked.error);
  groups[index] = { id: groups[index].id, name: checked.name };
  data.channelGroups = groups;
  return { ok: true, group: groups[index], groups };
}

/**
 * Put the groups in the given order. Ids that no longer exist are ignored and groups the list does
 * not mention keep their relative order after it, so a reorder never loses a group another device
 * just added.
 */
export function reorderGroups(
  data: CollabChannelsData,
  groupIds: unknown,
): GroupResult<{ groups: ChannelGroup[] }> {
  if (!Array.isArray(groupIds) || groupIds.length > MAX_REORDER_IDS || !groupIds.every(id => typeof id === 'string')) {
    return fail(400, 'Send the group ids in the order you want.');
  }
  const groups = resolveChannelGroups(data);
  const byId = new Map(groups.map(group => [group.id, group]));
  const ordered: ChannelGroup[] = [];
  for (const id of groupIds as string[]) {
    const group = byId.get(id);
    if (group) {
      ordered.push(group);
      byId.delete(id);
    }
  }
  for (const group of groups) {
    if (byId.has(group.id)) ordered.push(group);
  }
  data.channelGroups = ordered;
  return { ok: true, groups: ordered };
}

/**
 * Delete a group. Its channels move to the first remaining group (the caller names it in the
 * confirmation), and the last group cannot be deleted.
 */
export function deleteGroup(
  data: CollabChannelsData,
  groupId: unknown,
): GroupResult<{ movedTo: ChannelGroup; movedChannelCount: number; groups: ChannelGroup[] }> {
  const groups = resolveChannelGroups(data);
  if (typeof groupId !== 'string' || !groups.some(group => group.id === groupId)) {
    return fail(404, 'That group no longer exists.');
  }
  if (groups.length === 1) return fail(400, "The last group can't be deleted.");

  const remaining = groups.filter(group => group.id !== groupId);
  const movedTo = remaining[0];
  const shown = (data.channels ?? []).filter(
    channel => !channel.parentChannelId && getChannelGroupId(channel, groups) === groupId,
  );
  for (const channel of data.channels ?? []) {
    if (channel.settings?.category === groupId) {
      channel.settings = { ...channel.settings, category: movedTo.id };
    }
  }
  data.channelGroups = remaining;
  return { ok: true, movedTo, movedChannelCount: shown.length, groups: remaining };
}

/** File a top-level channel under a group. */
export function moveChannelToGroup(
  data: CollabChannelsData,
  channelId: unknown,
  groupId: unknown,
): GroupResult<{ groups: ChannelGroup[] }> {
  const channel = typeof channelId === 'string' ? (data.channels ?? []).find(c => c.id === channelId) : undefined;
  if (!channel) return fail(404, 'That channel no longer exists.');
  const groups = resolveChannelGroups(data);
  if (typeof groupId !== 'string' || !groups.some(group => group.id === groupId)) {
    return fail(404, 'That group no longer exists.');
  }
  if (channel.parentChannelId) return fail(400, 'Sub-channels stay in the same group as their parent channel.');
  if (channel.settings?.category !== groupId) {
    channel.settings = { ...channel.settings, category: groupId };
  }
  data.channelGroups = groups;
  return { ok: true, groups };
}
