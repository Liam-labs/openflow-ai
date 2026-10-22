'use client';

import React, { useCallback, useState, useRef, useEffect } from 'react';
import { DirectoryAutocomplete } from './DirectoryAutocomplete';
import {
  Plus,
  Loader2,
  RefreshCw,
  Trash2,
  ChevronRight,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  CornerDownRight,
  X,
  Pin,
  Archive,
  RotateCcw,
  Shield,
  FolderOpen,
  FolderPlus,
  Settings2, MoreHorizontal, GripVertical,
  Search, Users, Bell, Briefcase, Heart, Sparkles, Layers,
  type LucideIcon,
} from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  useDraggable,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type SensorDescriptor,
  type SensorOptions,
} from '@dnd-kit/core';
import type {
  CollabChannel,
  Project,
  AgentRole,
} from './colab-types';
import type { ChannelGroup } from '@/lib/types';
import { filterParentsByGroup, unreadByGroup } from '@/lib/collab-groups';
import { channelsNeedingYou } from '@/lib/collab-sidebar-logic';
import { AccountSettings, SettingsDialog, useAccountSettings } from './collab/AccountSettings';
import { ChannelToolsLauncher } from './ChannelToolsLauncher';
import { LoginsLauncher } from './LoginsLauncher';
import { useRileyVoiceWatching } from '@/lib/voice/watching';
import { ChannelJump, buildJumpEntries } from './collab/ChannelJump';

import { getHomeDir } from '@/lib/home-dir';
// Draggable + droppable channel wrapper — no sorting/shifting, just nest-on-drop
export function DraggableDroppableChannel({ id, isDragOver, isInvalid, targetName, isDragActive, children }: {
  id: string;
  isDragOver?: boolean;
  isInvalid?: boolean;
  targetName?: string;
  isDragActive?: boolean;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id });

  const {
    setNodeRef: setDropRef,
  } = useDroppable({ id });

  const setNodeRef = useCallback((node: HTMLElement | null) => {
    setDragRef(node);
    setDropRef(node);
  }, [setDragRef, setDropRef]);

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.25 : 1 }}
      className={`transition-colors duration-150 rounded-lg ${
        isDragOver && !isInvalid
          ? 'ring-2 ring-blue-400 bg-blue-500/15 shadow-[0_0_12px_rgba(168,85,247,0.25)]'
          : isDragOver && isInvalid
          ? 'ring-1 ring-red-500/40 bg-red-500/5'
          : ''
      }`}
    >
      <div className="flex items-center min-w-0" {...attributes} {...listeners} role={undefined} tabIndex={-1}>
        {children}
      </div>
      {isDragOver && !isInvalid && (
        <div className="mx-2 mb-1 px-2 py-0.5 rounded bg-blue-500/20 border border-blue-500/30 flex items-center gap-1.5 animate-pulse">
          <CornerDownRight className="w-3 h-3 text-blue-400" />
          <span className="text-[10px] text-blue-300 font-medium">
            Nest as subchannel{targetName ? ` of #${targetName}` : ''}
          </span>
        </div>
      )}
      {isDragOver && isInvalid && (
        <div className="mx-2 mb-1 px-2 py-0.5 rounded bg-red-500/10 border border-red-500/20 flex items-center gap-1.5">
          <X className="w-3 h-3 text-red-400" />
          <span className="text-[10px] text-red-400/80 font-medium">Can&apos;t nest here</span>
        </div>
      )}
    </div>
  );
}

export interface ColabSidebarProps {
  // Layout / mobile state
  isMobile: boolean;
  isMobileSidebarOpen: boolean;
  isSidebarCollapsed: boolean;
  isExpanded: boolean;

  // Channel data
  channels: CollabChannel[];
  activeChannel: CollabChannel | null;
  commanderChannel: CollabChannel | null;
  parentChannels: CollabChannel[];
  subChannelsByParent: Record<string, CollabChannel[]>;
  unreadCounts: Record<string, number>;
  collapsedParents: Set<string>;
  loading: boolean;

  channelGroups: ChannelGroup[];
  onGroupAction: (action: string, fields: Record<string, unknown>) => Promise<void>;
  onPinChannel: (channel: CollabChannel) => Promise<void>;

  // Projects
  projects: Project[];

  // Create channel form
  showCreateChannel: boolean;
  newChannelName: string;
  newChannelProjectId: string;
  isCreatingProject: boolean;
  newProjectName: string;
  newProjectPath: string;
  newProjectError: string | null;
  newProjectSaving: boolean;
  setNewProjectError: (error: string | null) => void;

  // Archived channels
  archivedExpanded: boolean;
  archivedChannels: CollabChannel[];
  loadingArchived: boolean;

  // Roles
  roles: AgentRole[];

  // DnD
  dndSensors: SensorDescriptor<SensorOptions>[];
  dragActiveId: string | null;
  dragOverId: string | null;

  // Handlers
  toggleSidebar: () => void;
  fetchData: () => void;
  setShowCreateChannel: (show: boolean) => void;
  setNewChannelProjectId: (id: string) => void;
  setNewChannelName: (name: string) => void;
  setIsCreatingProject: (v: boolean) => void;
  setNewProjectName: (name: string) => void;
  setNewProjectPath: (path: string) => void;
  handleCreateChannel: () => void;
  handleCreateNewProject: () => void;
  setActiveChannel: (channel: CollabChannel) => void;
  handleMobileChannelSelect: () => void;
  setChannelContextMenu: (menu: { x: number; y: number; channel: CollabChannel } | null) => void;
  toggleParentCollapsed: (parentId: string) => void;
  openSubChannelModal: (parentId: string) => void;
  handleDeleteChannel: (channelId: string, e: React.MouseEvent) => void;
  handleToggleArchived: () => void;
  handleRestoreChannel: (archiveId: string) => void;
  handlePermanentlyDeleteChannel: (archiveId: string) => void;
  setShowRolesModal: (show: boolean) => void;
  fetchRoles: () => void;
  handleChannelDragStart: (event: DragStartEvent) => void;
  handleChannelDragOver: (event: { over: { id: string | number } | null }) => void;
  handleChannelDragEnd: (event: DragEndEvent) => void;
}

// Custom project dropdown — replaces native <select> which renders OS-native option list
function ProjectSelect({
  projects,
  selectedId,
  onSelect,
}: {
  projects: { id: string; name: string }[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const items = [
    { id: '', label: 'Auto-create from channel name' },
    ...projects.map(p => ({ id: p.id, label: p.name })),
    { id: '__new__', label: '+ New Project', isNew: true },
  ];
  const selected = items.find(i => i.id === selectedId);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHighlightIdx(-1);
      }
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx(prev => Math.min(prev + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx(prev => Math.max(prev - 1, 0)); }
    else if (e.key === 'Enter' && open && highlightIdx >= 0) { e.preventDefault(); onSelect(items[highlightIdx].id); setOpen(false); setHighlightIdx(-1); }
    else if (e.key === 'Escape') { setOpen(false); setHighlightIdx(-1); }
  };

  return (
    <div ref={containerRef} className="relative flex-1 mb-2" onKeyDown={handleKey}>
      <button
        type="button"
        onClick={() => { setOpen(prev => !prev); setHighlightIdx(-1); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-black/40 border border-white/10 rounded-lg text-xs text-white/70 hover:border-white/20 hover:bg-white/[0.06] focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/30 transition-all"
      >
        <span className="flex-1 text-left truncate">
          {selected ? selected.label : 'Select project...'}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-white/30 transition-transform duration-200 flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-[70] bg-[#14141a] border border-white/[0.12] rounded-lg shadow-2xl shadow-black/60 max-h-52 overflow-y-auto backdrop-blur-xl">
          {items.map((item, i) => (
            <React.Fragment key={item.id}>
              {item.isNew && <div className="mx-2 my-0.5 border-t border-white/[0.06]" />}
              <button
                type="button"
                onClick={() => { onSelect(item.id); setOpen(false); setHighlightIdx(-1); }}
                onMouseEnter={() => setHighlightIdx(i)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                  item.isNew
                    ? 'text-blue-400/80 hover:bg-blue-500/10 hover:text-blue-300'
                    : 'text-white/70 hover:bg-white/[0.06] hover:text-white/90'
                } ${i === highlightIdx ? (item.isNew ? 'bg-blue-500/10 text-blue-300' : 'bg-white/[0.08] text-white/90') : ''} ${
                  !item.isNew && item.id === selectedId ? 'text-blue-400 bg-blue-500/[0.08]' : ''
                }`}
              >
                {item.isNew ? (
                  <FolderPlus className="w-3.5 h-3.5 text-blue-400/60 flex-shrink-0" />
                ) : (
                  <FolderOpen className={`w-3.5 h-3.5 flex-shrink-0 ${item.id === selectedId ? 'text-blue-400/60' : 'text-white/20'}`} />
                )}
                <span className="truncate">{item.label}</span>
                {!item.isNew && item.id === selectedId && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                )}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelBadge({ name }: { name: string }) {
  const words = name.trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : Array.from(words[0] || '?').slice(0, 2).join('')).toUpperCase();
  const hue = Array.from(name).reduce((n, c) => (n * 31 + c.codePointAt(0)!) % 360, 0);
  return <span title={name} className="w-7 h-7 rounded-md inline-flex items-center justify-center text-[10px] font-semibold shrink-0" style={{ backgroundColor: `hsl(${hue} 35% 23%)`, color: `hsl(${hue} 75% 83%)` }}>{letters}</span>;
}

/** An agent counts as working when it is online and its wrapper says so; humans never do. */
function isWorking(participant: CollabChannel['participants'][number]): boolean {
  return participant.type !== 'user' && participant.activityStatus === 'working' && participant.status === 'online';
}

/** "now", "14m", "3h", "2d" — the age of a channel's latest message. */
function relativeTime(iso: string | undefined, now: number): string {
  const then = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.floor((now - then) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const NEEDS_YOU_LIMIT = 6;
const FOLD_KEY = 'devflow-sidebar-fold';

/** `inert` keeps a collapsed section's rows out of the tab order while they animate shut. */
const inertWhen = (on: boolean) => (on ? { inert: true } : {});

/** Section heading with a fold toggle: NEEDS YOU, PINNED, ARCHIVED. The open state is the parent's mg-sec--open class (it lights the icon). */
function SectionLabel({ label, open, onToggle, count, flag, Icon }: { label: string; open: boolean; onToggle: () => void; count?: number; flag?: boolean; Icon: LucideIcon }) {
  return <div className="mg-sec__hdr">
    <button onClick={onToggle} aria-expanded={open} className="mg-sec__toggle">
      <Icon className="mg-sec__icon" strokeWidth={1.5} aria-hidden />
      <span className="truncate">{label}</span>
      {(!!flag || (!!count && count > 0)) && <span className="mg-sec__count">{flag && <i className="mg-flag" aria-hidden />}{!!count && count > 0 && (count > 99 ? '99+' : count)}</span>}
    </button>
    <span className="w-6 shrink-0" aria-hidden />
  </div>;
}

/** Icon for a user-named group: the usual four get their own, any other gets the stack. */
function groupIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (/work/.test(n)) return Briefcase;
  if (/life/.test(n)) return Heart;
  if (/fun|play|game/.test(n)) return Sparkles;
  return Layers;
}

function GroupList({ group, collapsed, unread, count, onToggle, onMenu, children, expanded }: { group: ChannelGroup; collapsed: boolean; unread: number; count: number; onToggle: () => void; onMenu: (event: React.MouseEvent) => void; children: React.ReactNode; expanded: boolean }) {
  const drag = useDraggable({ id: `group:${group.id}` });
  const drop = useDroppable({ id: `group:${group.id}` });
  const Icon = groupIcon(group.name);
  const folded = collapsed && expanded;
  return <section className={`mg-sec ${folded ? 'mg-sec--collapsed' : 'mg-sec--open'} ${expanded ? '' : 'mg-sec--rail'} rounded-lg ${drop.isOver ? 'ring-2 ring-blue-400 bg-blue-500/10' : ''}`} aria-label={`${group.name} group`}>
    {expanded && <div ref={drop.setNodeRef} className="mg-sec__hdr">
      <button ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners} aria-label={`Drag ${group.name} group`} className="cs-grip"><GripVertical size={12} /></button>
      <button onClick={onToggle} aria-expanded={!collapsed} className="mg-sec__toggle">
        <Icon className="mg-sec__icon" strokeWidth={1.5} aria-hidden /><span className="truncate">{group.name}</span>
        {(unread > 0 || count > 0) && <span className="mg-sec__count">{unread > 0 && <i className="mg-flag" aria-hidden />}{count}</span>}
      </button>
      <span className="cs-sec-tools"><button onClick={onMenu} aria-label={`${group.name} group options`} className="cs-tool"><MoreHorizontal size={14} /></button></span>
    </div>}
    <div className={`mg-sec__body ${expanded ? '' : 'is-flat'}`}><div {...inertWhen(folded)}>{children}</div></div>
  </section>;
}

export function ColabSidebar({
  isMobile,
  isMobileSidebarOpen,
  isSidebarCollapsed,
  isExpanded,
  channels,
  activeChannel,
  commanderChannel,
  parentChannels,
  subChannelsByParent,
  unreadCounts,
  collapsedParents,
  loading,
  channelGroups,
  onGroupAction,
  onPinChannel,
  projects,
  showCreateChannel,
  newChannelName,
  newChannelProjectId,
  isCreatingProject,
  newProjectName,
  newProjectPath,
  newProjectError,
  newProjectSaving,
  archivedExpanded,
  archivedChannels,
  loadingArchived,
  roles,
  dndSensors,
  dragActiveId,
  dragOverId,
  toggleSidebar,
  fetchData,
  setShowCreateChannel,
  setNewChannelProjectId,
  setNewChannelName,
  setIsCreatingProject,
  setNewProjectName,
  setNewProjectPath,
  setNewProjectError,
  handleCreateChannel,
  handleCreateNewProject,
  setActiveChannel,
  handleMobileChannelSelect,
  setChannelContextMenu,
  toggleParentCollapsed,
  openSubChannelModal,
  handleToggleArchived,
  handleRestoreChannel,
  handlePermanentlyDeleteChannel,
  setShowRolesModal,
  fetchRoles,
  handleChannelDragStart,
  handleChannelDragOver,
  handleChannelDragEnd,
}: ColabSidebarProps) {
  const { account, error: accountError, refresh: refreshAccount, save: saveAccount } = useAccountSettings();
  const riley = useRileyVoiceWatching();
  const voiceMark = (id: string) => riley.watches(id) && <span className="mg-voice" role="img" aria-label="Riley Voice is watching this channel" title="Riley Voice is watching this channel"><i /><i /><i /><i /><i /></span>;
  const [settingsMode, setSettingsMode] = useState<'account' | 'sidebar' | null>(null);
  const [groupMenu, setGroupMenu] = useState<ChannelGroup | null>(null);
  const [groupName, setGroupName] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [localDrag, setLocalDrag] = useState<string | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [showAllNeeds, setShowAllNeeds] = useState(false);
  const [fold, setFold] = useState<{ needs?: true; pinned?: true }>({});
  useEffect(() => { try { setFold(JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}); } catch { /* keep the defaults */ } }, []);
  const toggleFold = (key: 'needs' | 'pinned') => setFold(prev => {
    const next = { ...prev }; if (next[key]) delete next[key]; else next[key] = true;
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* the fold just will not persist */ }
    return next;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); setJumpOpen(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const closeSettings = useCallback(() => setSettingsMode(null), []);
  const closeGroup = useCallback(() => { setGroupMenu(null); setError(''); }, []);
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the change.'); } finally { setBusy(false); } };
  const sections = account?.sidebar.sections || ['commander', 'pinned', 'groups', 'archived', 'channel-tools', 'roles'].map(id => ({ id, visible: true }));
  const pinned = channels.filter(channel => !!channel.pinnedAt && channel.id !== commanderChannel?.id).sort((a, b) => new Date(b.pinnedAt!).getTime() - new Date(a.pinnedAt!).getTime());
  const unpinned = parentChannels.filter(channel => !channel.pinnedAt);
  const groupUnread = unreadByGroup(unpinned, Object.fromEntries(Object.entries(subChannelsByParent).map(([id, list]) => [id, list.filter(channel => !channel.pinnedAt)])), unreadCounts, channelGroups);
  const pinnedUnread = pinned.reduce((sum, channel) => sum + (unreadCounts[channel.id] || 0) + (subChannelsByParent[channel.id] || []).filter(sub => !sub.pinnedAt).reduce((n, sub) => n + (unreadCounts[sub.id] || 0), 0), 0);
  const now = Date.now();

  // Agents working right now, across every channel (one agent in several channels counts once).
  const workingChannelIds = new Set<string>(); const workingAgents = new Set<string>();
  for (const channel of channels) for (const participant of channel.participants || []) {
    if (isWorking(participant)) { workingChannelIds.add(channel.id); workingAgents.add(participant.name); }
  }
  // Needs you: only channels with unread messages, newest first. A working agent alone does not belong here (it shows as a ring on the channel row). Commander has its own row above this list.
  const needsAll_ = channelsNeedingYou(channels, unreadCounts, commanderChannel?.id);
  const waitingCount = needsAll_.length;
  const needs = showAllNeeds ? needsAll_ : needsAll_.slice(0, NEEDS_YOU_LIMIT);
  const jumpEntries = jumpOpen ? buildJumpEntries(channels, channelGroups, unreadCounts, commanderChannel?.id) : [];
  const openChannel = (channel: CollabChannel) => { setActiveChannel(channel); handleMobileChannelSelect(); };
  const reorderGroup = (delta: number) => { if (!groupMenu) return; const ids = channelGroups.map(g => g.id); const index = ids.indexOf(groupMenu.id); [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]]; void run(async () => { await onGroupAction('reorder_groups', { groupIds: ids }); setGroupMenu(null); }); };

  const renderCommander = () => {
    if (!commanderChannel) return null;
    const cmdUnread = unreadCounts[commanderChannel.id] || 0;
    const cmdWorking = workingChannelIds.has(commanderChannel.id);
    return (
      <div
        className={isExpanded ? `mg-cmd ${commanderChannel.id === activeChannel?.id ? 'is-active' : ''}` : 'mg-row mg-row--rail'}
        onClick={() => openChannel(commanderChannel)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setChannelContextMenu({ x: e.clientX, y: e.clientY, channel: commanderChannel }); }}
        role="button" tabIndex={0} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openChannel(commanderChannel); } }}
        title={!isExpanded ? `${commanderChannel.name}${cmdUnread > 0 ? ` (${cmdUnread} unread)` : ''}` : undefined}
      >
        <div className="relative">
          <Shield size={14} strokeWidth={1.5} aria-hidden />
          {!isExpanded && cmdUnread > 0 && <span className="absolute -top-1 -right-1 bg-white text-[#040816] text-[8px] font-bold w-3 h-3 rounded-full flex items-center justify-center">{cmdUnread > 9 ? '9' : cmdUnread}</span>}
        </div>
        {isExpanded && <span>{commanderChannel.name}</span>}
        {isExpanded && cmdWorking && <span className="mg-ring" role="img" aria-label="An agent is working here" />}
        {isExpanded && cmdUnread > 0 && <span className="mg-badge" aria-label={`${cmdUnread} unread`}>{cmdUnread > 99 ? '99+' : cmdUnread}</span>}
      </div>
    );
  };

  // The Needs you card: ring, name and age only (kit rule). The unread total lives in the pill and on the row below.
  const renderNeed = (channel: CollabChannel) => {
    const parent = channel.parentChannelId ? channels.find(c => c.id === channel.parentChannelId) : undefined;
    return <div
      key={channel.id}
      role="button" tabIndex={0}
      className={`mg-attn ${channel.id === activeChannel?.id ? 'is-active' : ''}`}
      onClick={() => openChannel(channel)}
      onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openChannel(channel); } }}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setChannelContextMenu({ x: e.clientX, y: e.clientY, channel }); }}
      title={parent ? `Inside ${parent.name}` : undefined}
    >
      <span className="mg-ring" role="img" aria-label="Waiting for you" />
      <span className="mg-attn__name">{channel.name.includes(' → ') ? channel.name.split(' → ')[1] : channel.name}</span>
      <span className="mg-attn__age">{relativeTime(channel.lastMessageAt, now)}</span>
    </div>;
  };

  const rowMarks = (id: string, unread: number) => <>
    {voiceMark(id)}
    {workingChannelIds.has(id) && <span className="mg-ring" role="img" aria-label="An agent is working here" />}
    {unread > 0 && <span className="mg-badge" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>}
  </>;
  const rowActions = (ch: CollabChannel) => <span className="mg-row__acts">
    <button aria-pressed={!!ch.pinnedAt} aria-label={`${ch.pinnedAt ? 'Unpin' : 'Pin'} ${ch.name}`} title={ch.pinnedAt ? 'Unpin channel' : 'Pin channel'} onClick={e => { e.stopPropagation(); void run(() => onPinChannel(ch)); }} className={`mg-act mg-act--pin ${ch.pinnedAt ? 'mg-act--on' : ''}`}><Pin size={14} strokeWidth={1.5} /></button>
    <button aria-haspopup="menu" aria-label={`${ch.name} channel options`} onClick={e => { e.stopPropagation(); const box = e.currentTarget.getBoundingClientRect(); setChannelContextMenu({ x: box.left, y: box.bottom, channel: ch }); }} className="mg-act mg-act--more"><MoreHorizontal size={14} /></button>
  </span>;
  const rowKeys = (ch: CollabChannel) => (e: React.KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openChannel(ch); } };

  const renderChannels = (list: CollabChannel[]) => <>{list.map((channel) => {
                const unread = unreadCounts[channel.id] || 0;
                const subs = (subChannelsByParent[channel.id] || []).filter(sub => !sub.pinnedAt);
                const hasChildren = subs.length > 0;
                const isCollapsed = isMobile ? false : collapsedParents.has(channel.id);
                const subUnreadTotal = isCollapsed ? subs.reduce((sum, sub) => sum + (unreadCounts[sub.id] || 0), 0) : 0;
                const totalUnread = unread + subUnreadTotal;
                const isDropTarget = dragOverId === channel.id && dragActiveId !== channel.id;
                const projectName = channel.projectId ? projects.find(p => p.id === channel.projectId)?.name : undefined;
                const hint = isExpanded
                  ? [projectName, `${channel.participants?.length || 0} participants`].filter(Boolean).join(' · ')
                  : `${channel.name}${totalUnread > 0 ? ` (${totalUnread} unread)` : ''}`;

                return (
                  <div key={channel.id}>
                    <DraggableDroppableChannel
                      id={channel.id}
                      isDragOver={isDropTarget}
                      isInvalid={isDropTarget && !!channel.parentChannelId}
                      targetName={channel.name}
                      isDragActive={dragActiveId === channel.id}
                    >
                      {/* Parent Channel */}
                      <div
                        role="button" tabIndex={0}
                        className={`mg-row ${riley.watches(channel.id) ? 'mg-row--voice' : ''} ${channel.id === activeChannel?.id ? 'mg-row--selected' : ''} ${totalUnread > 0 ? 'mg-row--unread' : ''} ${!isExpanded ? 'mg-row--rail' : ''} ${isMobile ? 'mg-row--touch' : ''}`}
                        onClick={() => openChannel(channel)}
                        onKeyDown={rowKeys(channel)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setChannelContextMenu({ x: e.clientX, y: e.clientY, channel });
                        }}
                        title={hint}
                      >
                        {!isExpanded && (
                          <div className="relative">
                            <span aria-label={channel.name}><ChannelBadge name={channel.name} /></span>
                            {totalUnread > 0 && (
                              <span className="absolute -top-1 -right-1 bg-white text-[#040816] text-[8px] font-bold w-3 h-3 rounded-full flex items-center justify-center">
                                {totalUnread > 9 ? '9' : totalUnread}
                              </span>
                            )}
                          </div>
                        )}
                        {isExpanded && (
                          <>
                            <span className="mg-row__name">{channel.name}</span>
                            {hasChildren && (
                              <button
                                onClick={(e) => { e.stopPropagation(); toggleParentCollapsed(channel.id); }}
                                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${channel.name} sub-channels`}
                                aria-expanded={!isCollapsed}
                                className={`mg-act !w-5 !h-5 ${isMobile ? '!w-8 !h-8' : ''}`}
                              >
                                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                              </button>
                            )}
                            {rowMarks(channel.id, totalUnread)}
                            {rowActions(channel)}
                          </>
                        )}
                      </div>
                    </DraggableDroppableChannel>

                    {/* Sub-channels (nested under a guide line) */}
                    {isExpanded && !isCollapsed && hasChildren && <div className="mg-nest">{subs.map((sub) => {
                      const subUnread = unreadCounts[sub.id] || 0;
                      return (
                        <DraggableDroppableChannel
                          key={sub.id}
                          id={sub.id}
                          isDragOver={dragOverId === sub.id && dragActiveId !== sub.id}
                          isInvalid={true}
                          isDragActive={dragActiveId === sub.id}
                        >
                          <div
                            role="button" tabIndex={0}
                            className={`mg-row ${riley.watches(sub.id) ? 'mg-row--voice' : ''} ${sub.id === activeChannel?.id ? 'mg-row--selected' : ''} ${subUnread > 0 ? 'mg-row--unread' : ''} ${isMobile ? 'mg-row--touch' : ''}`}
                            onClick={() => openChannel(sub)}
                            onKeyDown={rowKeys(sub)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setChannelContextMenu({ x: e.clientX, y: e.clientY, channel: sub });
                            }}
                            title={sub.name}
                          >
                            <span className="mg-row__name">{sub.name.includes(' → ') ? sub.name.split(' → ')[1] : sub.name}</span>
                            {rowMarks(sub.id, subUnread)}
                            {rowActions(sub)}
                          </div>
                        </DraggableDroppableChannel>
                      );
                    })}</div>}
                  </div>
                );
              })}</>;
  const dockVisible = (id: string) => sections.some(section => section.id === id && section.visible);
  const dockItems = [
    dockVisible('channel-tools') && <ChannelToolsLauncher key="channel-tools" channelId={activeChannel?.id ?? null} channelName={activeChannel?.name} isExpanded={isExpanded} compact={isExpanded} />,
    dockVisible('roles') && <button key="roles" onClick={() => { setShowRolesModal(true); fetchRoles(); }} className="cs-dock-btn" title="Manage roles" aria-label={`Manage roles${roles.length ? `, ${roles.length}` : ''}`}><Users size={16} />{isExpanded && roles.length > 0 && <span className="cs-dock-n">{roles.length}</span>}</button>,
    <LoginsLauncher key="logins" />,
    dockVisible('archived') && <button key="archived" onClick={handleToggleArchived} aria-pressed={archivedExpanded} className="cs-dock-btn" title={archivedExpanded ? 'Hide archived channels' : 'Show archived channels'} aria-label="Archived channels"><Archive size={16} /></button>,
  ];
  return (
    <div
      className={`collab-sidebar mg-scope border-r border-white/10 flex flex-col transition-all duration-300 ease-in-out ${
        isMobile
          ? `absolute inset-y-0 left-0 z-40 w-72 ${isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`
          : `relative ${isSidebarCollapsed ? 'w-12' : 'w-72'}`
      }`}
    >
      <div className="mg-orbs" aria-hidden="true"><i /><i /><i /><i /></div>
      {/* Header */}
      <div className={!isExpanded ? 'p-1.5 pb-2' : 'mg-panel__top'}>
        {isExpanded ? (
          <div className="mg-title">
            <div>
              <h1>Projects</h1>
              {(workingAgents.size > 0 || waitingCount > 0) && (
                <div className="mg-pill" role="status">
                  <span className="mg-voice" aria-hidden><i /><i /><i /><i /><i /></span>
                  {[workingAgents.size > 0 && `${workingAgents.size} working`, waitingCount > 0 && `${waitingCount} waiting`].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
            <div>
              <button onClick={fetchData} className="mg-iconbtn" title="Refresh" aria-label="Refresh channels"><RefreshCw size={14} strokeWidth={1.5} className={loading ? 'animate-spin' : ''} /></button>
              <button onClick={() => setShowCreateChannel(true)} className="mg-iconbtn" title="New project (Ctrl+N)" aria-label="New project"><Plus size={14} strokeWidth={1.5} /></button>
              <button onClick={toggleSidebar} className="mg-iconbtn" title="Hide sidebar (S)" aria-label="Hide sidebar"><PanelLeftClose size={14} strokeWidth={1.5} /></button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1">
            <button onClick={toggleSidebar} className="mg-iconbtn" title="Show sidebar (S)" aria-label="Show sidebar"><PanelLeftOpen size={16} strokeWidth={1.5} /></button>
          </div>
        )}
        {isExpanded
          ? <button onClick={() => setJumpOpen(true)} className="mg-search" aria-label="Jump to project (Ctrl K)"><Search size={14} strokeWidth={1.5} aria-hidden /><span>Jump to project</span><kbd className="mg-kbd">Ctrl K</kbd></button>
          : <button onClick={() => setJumpOpen(true)} className="mg-iconbtn mx-auto mt-1" title="Jump to channel (Ctrl K)" aria-label="Jump to channel"><Search size={16} strokeWidth={1.5} /></button>}
      </div>

      {/* Create Channel Input - hidden when collapsed */}
      {isExpanded && showCreateChannel && (
        <div className="p-3 border-b border-white/10 bg-blue-500/5">
          {!isCreatingProject ? (
            <>
              <ProjectSelect
                projects={projects}
                selectedId={newChannelProjectId}
                onSelect={(id) => {
                  if (id === '__new__') {
                    setIsCreatingProject(true);
                    setNewProjectName('');
                    setNewProjectPath('');
                    setNewProjectError(null);
                  } else {
                    setNewChannelProjectId(id);
                  }
                }}
              />
              <input
                type="text"
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateChannel()}
                placeholder="Channel name..."
                className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-sm placeholder-white/40 focus:outline-none focus:border-blue-500/50"
                autoFocus
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => {
                    setShowCreateChannel(false);
                    setNewChannelName('');
                    setNewChannelProjectId('');
                  }}
                  className="flex-1 px-3 py-1.5 rounded-lg text-sm bg-white/5 hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateChannel}
                  disabled={!newChannelName.trim()}
                  className="flex-1 px-3 py-1.5 rounded-lg text-sm bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors disabled:opacity-50"
                >
                  Create
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-blue-400 font-medium flex items-center gap-1.5">
                <FolderOpen className="w-3.5 h-3.5" />
                New Project Directory
              </p>
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => {
                  setNewProjectName(e.target.value);
                  const slug = e.target.value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
                  if (slug && !newProjectPath) {
                    setNewProjectPath(`${getHomeDir()}/${slug}`);
                  }
                  setNewProjectError(null);
                }}
                placeholder="Project name..."
                className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-sm placeholder-white/40 focus:outline-none focus:border-blue-500/50"
                autoFocus
              />
              <div className="text-[10px] text-white/30 font-medium px-1">Working directory</div>
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-black/40 border border-white/10 rounded-lg">
                <DirectoryAutocomplete
                  value={newProjectPath}
                  onChange={(path) => setNewProjectPath(path)}
                  placeholder="/home/you/project-name"
                  className="flex-1 bg-transparent border-none text-xs text-white/70 placeholder-white/30 focus:outline-none py-0.5 font-mono"
                  iconClassName="w-3.5 h-3.5 text-blue-400/60 flex-shrink-0"
                />
              </div>
              {newProjectError && (
                <p className="text-[10px] text-red-400 px-1">{newProjectError}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setIsCreatingProject(false);
                    setNewProjectName('');
                    setNewProjectPath('');
                    setNewProjectError(null);
                  }}
                  className="flex-1 px-3 py-1.5 rounded-lg text-sm bg-white/5 hover:bg-white/10 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleCreateNewProject}
                  disabled={!newProjectName.trim() || newProjectSaving}
                  className="flex-1 px-3 py-1.5 rounded-lg text-sm bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {newProjectSaving ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating...</>
                  ) : (
                    <><FolderOpen className="w-3.5 h-3.5" /> Create</>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <DndContext sensors={dndSensors} collisionDetection={closestCenter}
        onDragStart={event => { setLocalDrag(String(event.active.id)); if (!String(event.active.id).startsWith('group:')) handleChannelDragStart(event); }}
        onDragOver={event => { if (!String(event.over?.id || '').startsWith('group:')) handleChannelDragOver(event); }}
        onDragCancel={() => { setLocalDrag(null); handleChannelDragOver({ over: null }); }}
        onDragEnd={event => {
          setLocalDrag(null); const source = String(event.active.id); const target = String(event.over?.id || '');
          if (target.startsWith('group:')) {
            handleChannelDragOver({ over: null });
            void handleChannelDragEnd({ ...event, over: null });
            if (source.startsWith('group:')) { const ids = channelGroups.map(g => g.id); const from = ids.indexOf(source.slice(6)); const to = ids.indexOf(target.slice(6)); if (from >= 0 && to >= 0 && from !== to) { ids.splice(to, 0, ids.splice(from, 1)[0]); void run(() => onGroupAction('reorder_groups', { groupIds: ids })); } }
            else void run(() => onGroupAction('move_channel_to_group', { channelId: source, groupId: target.slice(6) }));
          } else if (!source.startsWith('group:')) handleChannelDragEnd(event);
        }}>
        <div className={!isExpanded ? 'flex-1 overflow-y-auto p-1' : 'mg-panel__scroll'}>
          {error && <p role="alert" className="p-2 text-xs text-red-300">{error}</p>}
          {accountError && <button onClick={() => void refreshAccount()} className="p-2 text-xs text-red-300" title={accountError}>Account settings unavailable. Retry</button>}

          {commanderChannel && sections.some(section => section.id === 'commander' && section.visible) && renderCommander()}

          {isExpanded && needs.length > 0 && <section aria-label="Needs you" className={`mg-sec ${fold.needs ? 'mg-sec--collapsed' : 'mg-sec--open'}`}>
            <SectionLabel Icon={Bell} label="Needs you" open={!fold.needs} onToggle={() => toggleFold('needs')} count={needsAll_.length} />
            <div className="mg-sec__body"><div {...inertWhen(!!fold.needs)}>
              {needs.map(renderNeed)}
              {needsAll_.length > NEEDS_YOU_LIMIT && <button onClick={() => setShowAllNeeds(v => !v)} className="mg-more w-full text-left">{showAllNeeds ? 'Show fewer' : `Show ${needsAll_.length - NEEDS_YOU_LIMIT} more`}</button>}
            </div></div>
          </section>}

          {sections.filter(section => section.visible).map(section => <React.Fragment key={section.id}>
            {section.id === 'pinned' && pinned.length > 0 && <section aria-label="Pinned channels" className={`mg-sec ${isExpanded && fold.pinned ? 'mg-sec--collapsed' : 'mg-sec--open'} ${isExpanded ? '' : 'mg-sec--rail'}`}>
              {isExpanded ? <SectionLabel Icon={Pin} label="Pinned" open={!fold.pinned} onToggle={() => toggleFold('pinned')} flag={pinnedUnread > 0} /> : <div className="mx-2 my-1 border-t border-white/[0.08]" />}
              <div className={`mg-sec__body ${isExpanded ? '' : 'is-flat'}`}><div {...inertWhen(isExpanded && !!fold.pinned)}>{renderChannels(pinned)}</div></div>
            </section>}
            {section.id === 'groups' && <>
              {loading && channels.length === 0 && <Loader2 className="m-4 animate-spin" />}
              {channelGroups.map(group => <GroupList key={group.id} group={group} expanded={isExpanded} collapsed={!!account?.sidebar.collapsedGroups[group.id]} unread={groupUnread[group.id] || 0} count={filterParentsByGroup(unpinned, group.id, channelGroups).length}
                onToggle={() => void run(() => saveAccount({ sidebar: { collapsedGroups: { [group.id]: !account?.sidebar.collapsedGroups[group.id] } } }))}
                onMenu={() => { setGroupMenu(group); setGroupName(group.name); }}>
                {renderChannels(filterParentsByGroup(unpinned, group.id, channelGroups))}
                {isExpanded && !filterParentsByGroup(unpinned, group.id, channelGroups).length && <p className="mg-more">No channels</p>}
              </GroupList>)}
              {isExpanded && <button className="mg-more mt-1 w-full text-left" onClick={() => { setGroupMenu({ id: '', name: '' }); setGroupName(''); }}>+ New group</button>}
            </>}
          </React.Fragment>)}

          {isExpanded && archivedExpanded && sections.some(section => section.id === 'archived' && section.visible) && (
            <section aria-label="Archived channels" className="mg-sec mg-sec--open">
              <SectionLabel Icon={Archive} label="Archived" open onToggle={handleToggleArchived} count={archivedChannels.length} />
            {archivedExpanded && (
              <div className="pb-2 space-y-0.5 px-2">
                {loadingArchived ? (
                  <div className="flex items-center justify-center py-3">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-white/30" />
                  </div>
                ) : archivedChannels.length === 0 ? (
                  <p className="text-[11px] text-[var(--faint)] text-center py-3">No archived channels</p>
                ) : archivedChannels.map(ch => (
                  <div
                    key={ch.id}
                    className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] transition-colors"
                  >
                    <span className="flex-1 truncate text-[12px] text-[var(--muted)]">{ch.name}</span>
                    <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity">
                      <button
                        onClick={() => handleRestoreChannel(ch.id)}
                        className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400/60 hover:text-emerald-400 transition-colors"
                        title="Restore channel"
                      >
                        <RotateCcw className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => handlePermanentlyDeleteChannel(ch.id)}
                        className="p-1 rounded hover:bg-red-500/20 text-red-400/60 hover:text-red-400 transition-colors"
                        title="Permanently delete"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            </section>
          )}
        </div>
        <DragOverlay>{localDrag && <div className="rounded-lg bg-[#18283d] border border-blue-400/40 px-3 py-2 text-sm">{localDrag.startsWith('group:') ? channelGroups.find(g => g.id === localDrag.slice(6))?.name : channels.find(c => c.id === localDrag)?.name}</div>}</DragOverlay>
      </DndContext>
      <div className={`cs-dock ${!isExpanded ? 'is-rail' : ''}`}>
        {dockItems}
        <button onClick={() => setSettingsMode('sidebar')} disabled={!account} aria-label="Customise sidebar" title="Customise sidebar" className={`cs-dock-btn disabled:opacity-40 ${isExpanded ? 'ml-auto' : ''}`}><Settings2 size={16} /></button>
      </div>
      <div className="border-t border-white/[0.07] p-2"><button onClick={() => setSettingsMode('account')} disabled={!account} aria-label="Your account" className="w-full flex items-center gap-2.5 rounded-lg p-1.5 text-sm hover:bg-white/5 disabled:opacity-60">
        <span className="relative grid h-[26px] w-[26px] flex-none place-items-center rounded-full bg-[#1d2a44] text-xs font-semibold text-[#bcd0f5]">{Array.from(account?.profile.displayName || 'L')[0]?.toUpperCase()}<span className="absolute -bottom-px -right-px h-2 w-2 rounded-full border-2 border-[#060912] bg-green-500" /></span>
        {isExpanded && <span className="flex-1 min-w-0 text-left leading-tight"><span className="block truncate">{account?.profile.displayName || 'Your account'}</span><span className="block text-[11px] text-white/45">Your account</span></span>}
      </button></div>
      {jumpOpen && <ChannelJump entries={jumpEntries} onPick={channel => { setJumpOpen(false); openChannel(channel); }} onClose={() => setJumpOpen(false)} />}
      {settingsMode && account && <AccountSettings account={account} mode={settingsMode} onSave={async patch => { await saveAccount(patch); fetchData(); }} onClose={closeSettings} />}
      {groupMenu && <SettingsDialog title={groupMenu.id ? `${groupMenu.name} group` : 'New group'} onClose={closeGroup}>
        <form onSubmit={event => { event.preventDefault(); void run(async () => { await onGroupAction(groupMenu.id ? 'rename_group' : 'create_group', { groupId: groupMenu.id, groupName }); setGroupMenu(null); }); }}>
          <label className="text-sm">Group name<input autoFocus required maxLength={48} value={groupName} onChange={e => setGroupName(e.target.value)} className="block w-full mt-2 p-2 rounded-lg border border-white/20 bg-black/20" /></label>
          <button disabled={busy} className="my-3 px-3 py-2 rounded-lg bg-blue-500/20 text-blue-200">{groupMenu.id ? 'Rename' : 'Create group'}</button>
        </form>
        {groupMenu.id && <div className="flex flex-wrap gap-2 border-t border-white/10 pt-3">
          <button disabled={busy || channelGroups[0]?.id === groupMenu.id} className="px-3 py-2 rounded hover:bg-white/10 disabled:opacity-30" onClick={() => reorderGroup(-1)}>Move up</button>
          <button disabled={busy || channelGroups.at(-1)?.id === groupMenu.id} className="px-3 py-2 rounded hover:bg-white/10 disabled:opacity-30" onClick={() => reorderGroup(1)}>Move down</button>
          <button disabled={busy || channelGroups.length < 2} className="px-3 py-2 text-red-300 rounded hover:bg-red-500/10 disabled:opacity-30" onClick={() => { const destination = channelGroups.find(g => g.id !== groupMenu.id); if (destination && window.confirm(`Delete ${groupMenu.name}? Its channels will move to ${destination.name}.`)) void run(async () => { await onGroupAction('delete_group', { groupId: groupMenu.id }); setGroupMenu(null); }); }}>Delete group</button>
        </div>}
        {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      </SettingsDialog>}
    </div>
  );
}
