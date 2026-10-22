import { isMessageHiddenFromHumans } from '@/lib/hidden-messages';
import type { ChannelTab } from '@/lib/types';

export interface SidebarParticipant {
  id: string;
  name: string;
  type?: string;
  unreadCount?: number;
}

export interface SidebarIdentity {
  resolvedParticipantId?: string | null;
  browserParticipantId: string;
  browserUsername?: string | null;
}

export interface SidebarChannel {
  id: string;
  name: string;
  createdAt: string;
  lastActivity?: string;
  lastMessageAt?: string;
  pinnedAt?: string;
  parentChannelId?: string;
  settings?: { category?: string };
}

interface SidebarMessage {
  timestamp: string;
  from: { id: string; name?: string };
  content?: string;
  images?: readonly unknown[];
  silent?: boolean;
  system?: boolean;
  metadata?: { isHidden?: boolean; crossChannel?: Record<string, unknown> };
}

function timestampMs(value?: string): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Resolve the browser user's unread count across local browser IDs and the
 * canonical WebGate identity returned by the server.
 */
export function getSidebarUnreadCount(
  participants: readonly SidebarParticipant[],
  identity: SidebarIdentity,
): number {
  const exactIds = [identity.resolvedParticipantId, identity.browserParticipantId]
    .filter((id): id is string => Boolean(id));

  for (const id of exactIds) {
    const exact = participants.find(participant => participant.id === id);
    if (exact) return exact.unreadCount ?? 0;
  }

  const browserUsername = identity.browserUsername?.trim().toLocaleLowerCase();
  if (browserUsername) {
    const namedUser = participants.find(participant =>
      participant.type === 'user'
      && participant.name.trim().toLocaleLowerCase() === browserUsername
    );
    if (namedUser) return namedUser.unreadCount ?? 0;
  }

  const legacyBrowserUser = participants.find(participant =>
    participant.type === 'user' && participant.id.startsWith('browser-user-')
  );
  return legacyBrowserUser?.unreadCount ?? 0;
}

/** The latest visible human/agent chat message (not a system, silent or hidden one). */
function latestVisibleMessage<T extends SidebarMessage>(messages: readonly T[]): T | undefined {
  let latest: T | undefined;
  let latestTime = 0;

  for (const message of messages) {
    if (
      message.from.id === 'system'
      || message.system
      || message.silent
      || isMessageHiddenFromHumans(message)
    ) {
      continue;
    }

    const messageTime = timestampMs(message.timestamp);
    if (messageTime > latestTime) {
      latestTime = messageTime;
      latest = message;
    }
  }

  return latest;
}

/** Latest timestamp that represents a visible human/agent chat message. */
export function getLatestVisibleMessageTimestamp(
  messages: readonly SidebarMessage[],
): string | undefined {
  return latestVisibleMessage(messages)?.timestamp;
}

export const SIDEBAR_PREVIEW_MAX_CHARS = 90;

/**
 * One plain line for the sidebar's "Needs you" list: "Sender: what they said". Leading @mentions are dropped (nearly every
 * message opens with one), code blocks, links and markdown marks are flattened so the line reads as speech, then it is cut to SIDEBAR_PREVIEW_MAX_CHARS.
 */
export function getLatestVisibleMessagePreview(
  messages: readonly SidebarMessage[],
): string | undefined {
  const message = latestVisibleMessage(messages);
  if (!message) return undefined;
  let text = (message.content ?? '')
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:@[\w.-]+[\s,:\u2014-]*)+/, '');
  if (!text && message.images?.length) text = 'sent an attachment';
  if (!text) return undefined;
  const chars = Array.from(text);
  if (chars.length > SIDEBAR_PREVIEW_MAX_CHARS) text = `${chars.slice(0, SIDEBAR_PREVIEW_MAX_CHARS - 1).join('').trimEnd()}…`;
  const sender = message.from.name?.trim().split(/\s+/)[0];
  return sender ? `${sender}: ${text}` : text;
}

function compareRecent<T extends SidebarChannel>(a: T, b: T): number {
  const activityDifference =
    timestampMs(b.lastMessageAt || b.createdAt)
    - timestampMs(a.lastMessageAt || a.createdAt);
  if (activityDifference !== 0) return activityDifference;

  const createdDifference = timestampMs(b.createdAt) - timestampMs(a.createdAt);
  if (createdDifference !== 0) return createdDifference;

  const nameDifference = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  if (nameDifference !== 0) return nameDifference;
  return a.id.localeCompare(b.id);
}

function compareParents<T extends SidebarChannel>(a: T, b: T): number {
  const aPinned = Boolean(a.pinnedAt);
  const bPinned = Boolean(b.pinnedAt);
  if (aPinned !== bPinned) return aPinned ? -1 : 1;

  if (aPinned && bPinned) {
    const pinDifference = timestampMs(b.pinnedAt) - timestampMs(a.pinnedAt);
    if (pinDifference !== 0) return pinDifference;
  }

  return compareRecent(a, b);
}

/**
 * Build the sidebar hierarchy with deterministic, user-meaningful ordering:
 * Commander is fixed in its dedicated slot; pinned parents come first (newest
 * pin first); all other ordering follows the latest visible chat message.
 */
export function groupChannelsForSidebar<T extends SidebarChannel>(
  channels: readonly T[],
  commanderChannelId: string,
): {
  commanderChannel: T | null;
  parentChannels: T[];
  subChannelsByParent: Record<string, T[]>;
} {
  const parentChannels: T[] = [];
  const subChannelsByParent: Record<string, T[]> = {};
  let commanderChannel: T | null = null;

  for (const channel of channels) {
    if (channel.parentChannelId) {
      (subChannelsByParent[channel.parentChannelId] ??= []).push(channel);
    } else if (channel.id === commanderChannelId) {
      commanderChannel = channel;
    } else {
      parentChannels.push(channel);
    }
  }

  parentChannels.sort(compareParents);
  for (const subChannels of Object.values(subChannelsByParent)) {
    subChannels.sort(compareRecent);
  }

  return { commanderChannel, parentChannels, subChannelsByParent };
}

// ---------------------------------------------------------------------------
// Sidebar tabs (Work / Life / Fun + user-added)
// ---------------------------------------------------------------------------

export const DEFAULT_CHANNEL_TAB_ID = 'work';
export const BUILT_IN_CHANNEL_TABS: readonly ChannelTab[] = [
  { id: 'work', name: 'Work' },
  { id: 'life', name: 'Life' },
  { id: 'fun', name: 'Fun' },
];
export const MAX_TAB_NAME_LENGTH = 24;

/** Built-in tabs first, then stored user tabs in creation order (duplicates dropped). */
export function resolveChannelTabs(stored?: readonly ChannelTab[] | null): ChannelTab[] {
  const tabs = [...BUILT_IN_CHANNEL_TABS];
  for (const tab of stored ?? []) {
    if (tab && typeof tab.id === 'string' && typeof tab.name === 'string'
        && !tabs.some(t => t.id === tab.id)) {
      tabs.push({ id: tab.id, name: tab.name });
    }
  }
  return tabs;
}

/** The tab a channel belongs to; unassigned or unknown (e.g. removed) tabs fall back to Work. */
export function getChannelTabId(
  channel: Pick<SidebarChannel, 'settings'>,
  tabs: readonly ChannelTab[],
): string {
  const category = channel.settings?.category;
  return category && tabs.some(t => t.id === category) ? category : DEFAULT_CHANNEL_TAB_ID;
}

/** Top-level channels shown under a tab. Sub-channels follow their parent. */
export function filterParentsByTab<T extends SidebarChannel>(
  parents: readonly T[],
  tabId: string,
  tabs: readonly ChannelTab[],
): T[] {
  return parents.filter(p => getChannelTabId(p, tabs) === tabId);
}

/** Unread totals per tab, counting each parent plus its sub-channels. */
export function unreadByTab<T extends SidebarChannel>(
  parents: readonly T[],
  subChannelsByParent: Readonly<Record<string, readonly T[]>>,
  unreadCounts: Readonly<Record<string, number>>,
  tabs: readonly ChannelTab[],
): Record<string, number> {
  const totals: Record<string, number> = Object.fromEntries(tabs.map(t => [t.id, 0]));
  for (const parent of parents) {
    const tabId = getChannelTabId(parent, tabs);
    let count = unreadCounts[parent.id] || 0;
    for (const sub of subChannelsByParent[parent.id] ?? []) count += unreadCounts[sub.id] || 0;
    totals[tabId] = (totals[tabId] || 0) + count;
  }
  return totals;
}

/**
 * Validate a new tab name and derive a stable id. Returns an error string for
 * an empty, over-long or duplicate (case-insensitive) name.
 */
export function prepareNewChannelTab(
  rawName: unknown,
  tabs: readonly ChannelTab[],
): { tab: ChannelTab } | { error: string } {
  const name = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ') : '';
  if (!name) return { error: 'Tab name is required' };
  if (name.length > MAX_TAB_NAME_LENGTH) return { error: `Tab name must be ${MAX_TAB_NAME_LENGTH} characters or fewer` };
  if (tabs.some(t => t.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return { error: `A "${name}" tab already exists` };
  }
  const base = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tab';
  let id = base;
  for (let n = 2; tabs.some(t => t.id === id); n++) id = `${base}-${n}`;
  return { tab: { id, name } };
}

/**
 * Channels for the sidebar's "Needs you" list: a channel is there only while it has unread messages for the user, newest
 * first. An agent working in a channel is not a reason (the channel row already shows a ring for that), and Commander has
 * its own row.
 */
export function channelsNeedingYou<T extends SidebarChannel>(
  channels: readonly T[],
  unreadCounts: Readonly<Record<string, number>>,
  commanderChannelId?: string,
): T[] {
  const when = (channel: T) => timestampMs(channel.lastMessageAt || channel.lastActivity);
  return channels
    .filter(channel => channel.id !== commanderChannelId && (unreadCounts[channel.id] || 0) > 0)
    .sort((a, b) => when(b) - when(a));
}
