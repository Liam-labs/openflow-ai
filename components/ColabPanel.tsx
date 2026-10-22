'use client';

/**
 * ColabPanel - Full-screen panel for multi-agent collaboration
 *
 * Features:
 * - Full-screen panel with collapsible channel sidebar
 * - Real-time message streaming
 * - Participant management
 * - Agent spawning and invitation
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useBreakpoint } from '@/lib/hooks/useBreakpoint';
import { useToast } from '@/lib/contexts/ToastContext';
import { requestRosterTerminal } from '@/lib/roster-terminal-action';
import {
  CLAUDE_DESIGN_AGENTCHAT_COMMANDS,
  parseClaudeDesignAgentChatCommand,
} from '@/lib/claude-design-agentchat';
import { detectFrozenParticipantIds } from '@/lib/frozen-detection';
import { detectCodeSnippet, fenceWithLanguage } from '@/lib/code-detect';
import type { Editor } from '@tiptap/react';
import { ASK_OWNER_ANSWER_KIND, type StructuredAnswer } from '@/lib/ask-owner/types';
import {
  DESIGN_REFERENCE_SELECTION_KIND,
  type DesignReferenceSelection,
} from '@/lib/design-references/types';
import {
  Users,
  Plus,
  Circle,
  Terminal,
  Sparkles,
  Loader2,
  X,
  Check,
  RefreshCw,
  Trash2,
  UserMinus,
  Send,
  Bot,
  User,
  Settings,
  ChevronRight,
  ChevronLeft,
  Zap,
  ExternalLink,
  Play,
  ChevronDown,
  WifiOff,
  Wifi,
  Clock,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Reply,
  CornerDownRight,
  Smile,
  Search,
  Pin,
  Copy,
  Pencil,
  Crown,
  MessageSquarePlus,
  Power,
  RotateCcw,
  Skull,
  Monitor,
  Rocket,
  FolderOpen,
  ToggleLeft,
  ToggleRight,
  AlertTriangle,
  Dices,
  Shield,
  UsersRound,
  Layers,
  ChevronUp,
  Folder,
  Download,
  GripVertical,
  ArrowLeft,
  Server,
  Plug,
  ArrowRightLeft,
  Undo2,
  Brain,
  Paperclip,
  FileText,
  FileSpreadsheet,
  FileArchive,
  FileCode,
  Film,
  Music,
  File,
  Upload,
  MoreHorizontal,
  Menu,
  Archive,
  Activity,
  AudioLines,
} from 'lucide-react';
import { useRileyVoiceWatching } from '@/lib/voice/watching';
import { ImageLightboxModal, type LightboxImage } from './modals/ImageLightboxModal';
import { RolesModal } from './modals/RolesModal';
import { DocPanelModal } from './modals/DocPanelModal';
import type {
  CollabChannel,
  CollabParticipant,
  CollabMessage,
  CollabTask,
  AgentRosterEntry,
  Team,
  Project,
  AgentRole,
  ChannelGroup,
  CrossChannelTarget,
} from '@/lib/types';
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { ColabInput } from './ColabInput';
import { ColabSidebar } from './ColabSidebar';
import { ColabChatView } from './ColabChatView';
import { TaskBoard } from './TaskBoard';
import { HierarchicalTaskBoard } from './HierarchicalTaskBoard';
import { DirectoryBrowser } from './DirectoryBrowser';
import { IdeaBoard } from './IdeaBoard';
import { TeamsBridgePanel } from './TeamsBridgePanel';
import { DirectoryAutocomplete } from './DirectoryAutocomplete';
import { KeepAliveModal } from './KeepAliveModal';
import { RosterConfigModal } from './modals/RosterConfigModal';
import { ChannelDeleteDialog } from './modals/ChannelDeleteDialog';
import { ScaffoldingFilesPanel } from './ScaffoldingFilesPanel';
import { AnchorRulesPanel } from './AnchorRulesPanel';
import { ToolsPanel } from './ToolsPanel';
import { ColabRightPanel } from './ColabRightPanel';
import { ChatNavbar, type NavMember } from './ChatNavbar';
import { ParticipantContextMenu } from './ParticipantContextMenu';
import { AgentDetailsModal } from './AgentDetailsModal';
import { ChatSettingsModal } from './ChatSettingsModal';
import { PinnedMessagesDropdown } from './PinnedMessagesDropdown';
import { ChannelSettingsModal } from './ChannelSettingsModal';
import { SubChannelModal } from './SubChannelModal';
import Link from 'next/link';
import { useEventStreamContext } from '@/lib/contexts/EventStreamContext';
import { writeRichClipboard } from '@/lib/chat-rich-clipboard';
import { motion, AnimatePresence } from 'framer-motion';
import { VoiceModeOverlay } from './VoiceModeOverlay';
import { RileyVoiceControl } from './RileyVoiceControl';
import {
  getSidebarUnreadCount,
  groupChannelsForSidebar,
} from '@/lib/collab-sidebar-logic';
import { resolveChannelGroups, getChannelGroupId, homeGroupId } from '@/lib/collab-groups';
import { useChannelAttachmentDrafts } from '@/hooks/useChannelAttachmentDrafts';
import { useAccountSettings } from './collab/AccountSettings';
import { isHumanParticipant, mentionsHuman } from '@/lib/human-identity';
import { resolveChannelWorkingDirectory } from '@/lib/channel-working-directory';
import { selectStaleParticipantsForCleanup } from '@/lib/collab-participant-cleanup';
import { buildAgentDetailsText } from '@/lib/agent-details-copy';
import { formatCrossChannelMessageForHumans } from '@/lib/hidden-messages';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';
import { getHomeDir, getDevflowHome } from '@/lib/home-dir';
import { hasReplyTag } from '@/lib/reply-tag';
import {
  attachmentReferenceLabel,
  createAttachmentReference,
  removeAttachmentReference,
  stripAttachmentReferences,
} from '@/lib/collab-attachment-references';

// Track which participants are currently typing/responding
interface TypingState {
  participantId: string;
  participantName: string;
  startedAt: number;
  activity?: 'typing' | 'working';
  activityDetail?: string | null;
}

interface PendingChatAttachment {
  data: string;
  name: string;
  type: string;
  size?: number;
  clientId: string;
}

// Generate a persistent browser participant ID
const BROWSER_PARTICIPANT_ID = typeof window !== 'undefined'
  ? localStorage.getItem('devflow-collab-participant-id') || (() => {
      const id = `browser-user-${Date.now().toString(36)}`;
      localStorage.setItem('devflow-collab-participant-id', id);
      return id;
    })()
  : 'browser-user';

// Routing is stable; account display names are separate.
const getBrowserUsername = () => HUMAN_ROUTING_NAME;

interface ColabPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialChannelId?: string | null;
  mode?: 'modal' | 'page';
}

// Structured error logging for collab operations
function logCollabError(operation: string, error: unknown, context?: Record<string, unknown>) {
  const details: Record<string, unknown> = { operation, ...context };
  if (error instanceof Response) {
    details.status = error.status;
    details.statusText = error.statusText;
    details.url = error.url;
  } else if (error instanceof Error) {
    details.message = error.message;
    details.name = error.name;
  } else {
    details.error = String(error);
  }
  console.error(`[Collab] ${operation} failed:`, details);
}

// Log failed fetch responses with body context
async function logFailedResponse(operation: string, res: Response) {
  let body = '';
  try { body = await res.text(); } catch {}
  console.error(`[Collab] ${operation} failed: HTTP ${res.status}`, { url: res.url, body: body.slice(0, 300) });
}

// Format token count to compact display (e.g., 657K, 1.2M)
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

// Default usage limits (configurable via localStorage)
const DEFAULT_DAILY_LIMIT = 5_000_000;  // 5M tokens
const DEFAULT_WEEKLY_LIMIT = 25_000_000; // 25M tokens
const DAILY_LIMIT_KEY = 'devflow-usage-daily-limit';
const WEEKLY_LIMIT_KEY = 'devflow-usage-weekly-limit';

function getUsageLimits(): { daily: number; weekly: number } {
  if (typeof window === 'undefined') return { daily: DEFAULT_DAILY_LIMIT, weekly: DEFAULT_WEEKLY_LIMIT };
  const daily = parseInt(localStorage.getItem(DAILY_LIMIT_KEY) || '', 10);
  const weekly = parseInt(localStorage.getItem(WEEKLY_LIMIT_KEY) || '', 10);
  return {
    daily: isNaN(daily) ? DEFAULT_DAILY_LIMIT : daily,
    weekly: isNaN(weekly) ? DEFAULT_WEEKLY_LIMIT : weekly,
  };
}

// Compute time remaining until next 5-hour session window reset.
// Claude MAX uses ~5-hour rolling windows. We approximate with fixed windows from midnight.
function getTimeUntilDailyReset(): string {
  const WINDOW_HOURS = 5;
  const now = new Date();
  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);
  const windowMs = WINDOW_HOURS * 3600_000;
  const elapsed = now.getTime() - todayMidnight.getTime();
  const currentWindowIndex = Math.floor(elapsed / windowMs);
  const nextReset = new Date(todayMidnight.getTime() + (currentWindowIndex + 1) * windowMs);
  const diff = nextReset.getTime() - now.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// Compute time remaining until next Sunday 10:00 AM (weekly reset), always in hours.
function getTimeUntilWeeklyReset(): string {
  const RESET_DAY = 0;   // Sunday
  const RESET_HOUR = 10; // 10:00 AM
  const now = new Date();
  let daysUntilReset = RESET_DAY - now.getDay();
  if (daysUntilReset < 0) {
    daysUntilReset += 7;
  } else if (daysUntilReset === 0 && now.getHours() >= RESET_HOUR) {
    daysUntilReset = 7;
  }
  const nextReset = new Date(now);
  nextReset.setDate(now.getDate() + daysUntilReset);
  nextReset.setHours(RESET_HOUR, 0, 0, 0);
  const diff = nextReset.getTime() - now.getTime();
  const totalHours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
}

interface ModelCapabilities {
  reasoning?: boolean;
  reasoningOnly?: boolean;
  vision?: boolean;
  toolUse?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStreaming?: boolean;
  supportsTemperature?: boolean;
  preview?: boolean;
}

interface ModelEntry {
  id: string;
  provider: string;
  label: string;
  description?: string;
  tier: string;
  agentTypes: string[];
  isDefault?: boolean;
  apiId?: string;
  capabilities?: ModelCapabilities;
}


// Graceful restart: notifies agents → waits 45s → relaunches all
const GRACEFUL_RESTART_DELAY_MS = 45_000;

function GracefulRestartButton({ channelId }: { channelId: string }) {
  const [state, setState] = useState<'idle' | 'notifying' | 'countdown' | 'launching' | 'done'>('idle');
  const [countdown, setCountdown] = useState(0);

  const handleClick = async () => {
    if (state !== 'idle') return;
    if (!window.confirm('Restart every running agent in this channel? Each saves its state first, then relaunches.')) return;
    setState('notifying');

    // Step 1: notify agents to save state
    try {
      await fetch('/api/roster/prepare-restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId }),
      });
    } catch {
      // best-effort — proceed regardless
    }

    // Step 2: countdown
    const totalSecs = GRACEFUL_RESTART_DELAY_MS / 1000;
    setCountdown(totalSecs);
    setState('countdown');
    const interval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) { clearInterval(interval); return 0; }
        return prev - 1;
      });
    }, 1000);

    await new Promise(res => setTimeout(res, GRACEFUL_RESTART_DELAY_MS));

    // Step 3: relaunch — restartOnly so we bounce only the agents that were
    // running, never wake offline ones (this is "restart", not "launch all").
    setState('launching');
    try {
      await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'roster_launch_all', channelId, restartOnly: true }),
      });
    } catch {
      // best-effort
    }

    setState('done');
    setTimeout(() => setState('idle'), 4000);
  };

  const isActive = state !== 'idle' && state !== 'done';

  const tooltip =
    state === 'notifying' ? 'Notifying agents to save state…' :
    state === 'countdown' ? `Restarting in ${countdown}s…` :
    state === 'launching' ? 'Relaunching agents…' :
    state === 'done' ? 'Restart complete' :
    'Gracefully restart all agents — saves state then relaunches';

  return (
    <button
      onClick={handleClick}
      disabled={isActive}
      title={tooltip}
      className="mg-btn mg-btn--ghost"
    >
      {state === 'done' ? (
        <Check className="w-3.5 h-3.5" />
      ) : state === 'launching' ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : state === 'countdown' ? (
        <span className="text-[10px] font-bold leading-none">{countdown}</span>
      ) : state === 'notifying' ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <RotateCcw className="w-3.5 h-3.5" />
      )}
      <span className="truncate">{state === 'done' ? 'Restarted' : isActive ? 'Restarting…' : 'Restart'}</span>
    </button>
  );
}

function StartRosterButton({ channelId, onComplete }: { channelId: string; onComplete?: () => void }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');

  const handleClick = async () => {
    setState('loading');
    try {
      await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'roster_launch_all', channelId }),
      });
    } catch {
      // best-effort
    }
    setState('done');
    // Refresh roster status after agents start — poll twice to catch fast + slow starters
    setTimeout(() => onComplete?.(), 2000);
    setTimeout(() => onComplete?.(), 5000);
    setTimeout(() => setState('idle'), 4000);
  };

  return (
    <button
      onClick={handleClick}
      disabled={state === 'loading'}
      title="Start all stopped roster agents"
      className="mg-btn mg-btn--ghost"
    >
      {state === 'loading' ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : state === 'done' ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <Rocket className="w-3.5 h-3.5" />
      )}
      <span className="truncate">{state === 'done' ? 'Started' : state === 'loading' ? 'Starting…' : 'Start all'}</span>
    </button>
  );
}

function GracefulShutdownButton({ channelId }: { channelId: string }) {
  const [state, setState] = useState<'idle' | 'notifying' | 'countdown' | 'killing' | 'done'>('idle');
  const [countdown, setCountdown] = useState(0);

  const handleClick = async () => {
    if (state !== 'idle') return;
    if (!window.confirm('Shut down every agent in this channel? Each saves its state first, then stops. You can start them again with Start all.')) return;
    setState('notifying');

    // Step 1: notify agents to flush logs + write handoffs (silent — not shown in chat)
    try {
      await fetch('/api/roster/prepare-restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, mode: 'shutdown' }),
      });
    } catch {
      // best-effort — proceed regardless
    }

    // Step 2: countdown
    const totalSecs = GRACEFUL_RESTART_DELAY_MS / 1000;
    setCountdown(totalSecs);
    setState('countdown');
    const interval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) { clearInterval(interval); return 0; }
        return prev - 1;
      });
    }, 1000);

    await new Promise(res => setTimeout(res, GRACEFUL_RESTART_DELAY_MS));

    // Step 3: kill all — no relaunch
    setState('killing');
    try {
      await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'roster_kill_all', channelId }),
      });
    } catch {
      // best-effort
    }

    setState('done');
    setTimeout(() => setState('idle'), 4000);
  };

  const isActive = state !== 'idle' && state !== 'done';

  const tooltip =
    state === 'notifying' ? 'Notifying agents to save state…' :
    state === 'countdown' ? `Shutting down in ${countdown}s…` :
    state === 'killing' ? 'Stopping agents…' :
    state === 'done' ? 'Team shut down' :
    'Gracefully shut down all agents — saves state then stops';

  return (
    <button
      onClick={handleClick}
      disabled={isActive}
      title={tooltip}
      className="mg-btn mg-btn--danger"
    >
      {state === 'done' ? (
        <Check className="w-3.5 h-3.5" />
      ) : state === 'killing' ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : state === 'countdown' ? (
        <span className="text-[10px] font-bold leading-none">{countdown}</span>
      ) : state === 'notifying' ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Power className="w-3.5 h-3.5" />
      )}
      <span className="truncate">{state === 'done' ? 'Stopped' : isActive ? 'Stopping…' : 'Stop all'}</span>
    </button>
  );
}

export function ColabPanel({ isOpen, onClose, initialChannelId, mode = 'modal' }: ColabPanelProps) {
  const { isMobile, isTablet, width: viewportWidth } = useBreakpoint();
  const { toast } = useToast();
  // Riley Voice watching a channel: shown and switched from the channel's right-click menu (lib/voice/watching.ts).
  const riley = useRileyVoiceWatching();
  const eventStream = useEventStreamContext();
  const [channels, setChannels] = useState<CollabChannel[]>([]);
  const [archivedChannels, setArchivedChannels] = useState<CollabChannel[]>([]);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [activeChannel, setActiveChannel] = useState<CollabChannel | null>(null);
  const [messages, setMessages] = useState<CollabMessage[]>([]);
  const [participantId, setParticipantId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('devflow-collab-participantId') || null;
  });
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isVoiceModeOpen, setIsVoiceModeOpen] = useState(false);
  const [spellcheckEnabled, setSpellcheckEnabled] = useState(false);
  const [spellcheckResults, setSpellcheckResults] = useState<Array<{ word: string; isCorrect: boolean; suggestions: string[] }>>([]);
  const spellcheckDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const [loading, setLoading] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [typingParticipants, setTypingParticipants] = useState<TypingState[]>([]);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [kickedParticipants, setKickedParticipants] = useState<CollabParticipant[]>([]);
  const [activeView, setActiveView] = useState<'chat' | 'tasks' | 'sprints' | 'teams' | 'ideas'>('chat');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('devflow-collab-sidebar-collapsed') === 'true';
    }
    return false;
  });
  // On mobile, sidebar is a slide-over drawer — tracked separately from desktop collapsed state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  // On mobile, right panel (participants + roster) is a slide-over drawer from the right
  const [isMobileRightPanelOpen, setIsMobileRightPanelOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  // On mobile, sidebar is always "expanded" (full drawer) — desktop uses isSidebarCollapsed
  const isExpanded = isMobile || !isSidebarCollapsed;
  // Pasted and dropped attachments are part of their channel's draft: kept per channel, restored with the draft, and only
  // sent or cleared with it (lib/chat-draft-attachments.ts). A slow file read finishes into the channel it started in.
  const {
    attachments: pendingImages,
    reads: pendingAttachmentReads,
    setAttachments: setPendingImages,
    store: draftAttachments,
  } = useChannelAttachmentDrafts(activeChannel?.id);
  // Non-destructive code-snippet suggestion (T2.2). Set when a pasted block reads
  // as code; never mutates the paste — only offers to wrap it in a fenced block.
  const [codeSuggestion, setCodeSuggestion] = useState<{ language: string | null; snippet: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [replyingTo, setReplyingTo] = useState<CollabMessage | null>(null);
  // Agent in another channel that the next message is also sent to (set from a cross-channel header).
  const [crossChannelTarget, setCrossChannelTarget] = useState<CrossChannelTarget | null>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<CollabParticipant[]>([]);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [searchResultIndex, setSearchResultIndex] = useState(0);
  const [showChannelSettings, setShowChannelSettings] = useState(false);
  const [showChatSettings, setShowChatSettings] = useState(false);
  const [chatSettingsTab, setChatSettingsTab] = useState<'general' | 'scaffolding' | 'tools' | 'anchor' | 'structure'>('general');
  const [showDocPanel, setShowDocPanel] = useState(false);
  const [showPinnedPanel, setShowPinnedPanel] = useState(false);
  const [docPanelLoading, setDocPanelLoading] = useState(false);
  const [docPanelContent, setDocPanelContent] = useState<string | null>(null);
  const [docPanelProjectPath, setDocPanelProjectPath] = useState<string | null>(null);
  const [docPanelExists, setDocPanelExists] = useState(false);
  const [docPanelNotice, setDocPanelNotice] = useState<string | null>(null);
  const [editChannelName, setEditChannelName] = useState('');
  const [editChannelDescription, setEditChannelDescription] = useState('');
  const [editChannelProjectPath, setEditChannelProjectPath] = useState('');
  const [channelSettingsError, setChannelSettingsError] = useState<string | null>(null);
  const [channelSettingsSaving, setChannelSettingsSaving] = useState(false);
  const [editingMyName, setEditingMyName] = useState(false);
  const [myNewName, setMyNewName] = useState('');
  const [renamingParticipantId, setRenamingParticipantId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [timeUpdate, setTimeUpdate] = useState(0); // Trigger for relative time updates
  const [soundEnabled, setSoundEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('devflow-collab-sound') !== 'false';
    }
    return true;
  });
  const [showSilentMessages, setShowSilentMessages] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('devflow-collab-show-silent') === 'true';
    }
    return false;
  });
  const [silentMessages, setSilentMessages] = useState<CollabMessage[]>([]);
  // Per-agent message filter: set of participant IDs whose messages are hidden
  const [hiddenParticipants, setHiddenParticipants] = useState<Set<string>>(new Set());
  const [showParticipantFilter, setShowParticipantFilter] = useState(false);
  // @owner-only mode: show only messages @mentioning the owner
  const [mentionsOnlyMode, setMentionsOnlyMode] = useState(false);
  // Sub-channel state
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('devflow-collab-collapsed-channels');
        return saved ? new Set(JSON.parse(saved)) : new Set();
      } catch { return new Set(); }
    }
    return new Set();
  });
  const [channelGroups, setChannelGroups] = useState<ChannelGroup[]>(() => resolveChannelGroups({}));
  const { account, save: saveAccount } = useAccountSettings();
  const participantLabel = (p: CollabParticipant) => isHumanParticipant(p) ? account?.profile.displayName || p.displayName || p.name : p.displayName || p.name;
  const [showSubChannelModal, setShowSubChannelModal] = useState(false);
  const [subChannelParentId, setSubChannelParentId] = useState<string | null>(null);
  const [selectedSubChannelMembers, setSelectedSubChannelMembers] = useState<Set<string>>(new Set());
  // Roster / Agent Management state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; participant: CollabParticipant } | null>(null);
  const [agentDetailsRoster, setAgentDetailsRoster] = useState<{ roster: AgentRosterEntry; participantName: string } | null>(null);
  const [channelContextMenu, setChannelContextMenu] = useState<{ x: number; y: number; channel: CollabChannel } | null>(null);
  // Ask the voice server again when the menu opens, so it never shows a stale state.
  const refreshRiley = riley.refresh;
  useEffect(() => { if (channelContextMenu) void refreshRiley(); }, [channelContextMenu, refreshRiley]);
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Projects state (for project-team linking)
  const [projects, setProjects] = useState<Project[]>([]);
  const [teamFormProjectId, setTeamFormProjectId] = useState<string>('');
  const [newChannelProjectId, setNewChannelProjectId] = useState<string>('');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [newProjectSaving, setNewProjectSaving] = useState(false);

  // Teams state
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [launchingTeam, setLaunchingTeam] = useState<Team | null>(null);
  const [teamFormName, setTeamFormName] = useState('');
  const [teamFormDescription, setTeamFormDescription] = useState('');
  const [teamFormAgents, setTeamFormAgents] = useState<Array<{
    id?: string;
    name: string;
    workingDirectory: string;
    color: string;
    autoResume: boolean;
    useCollabWrapper: boolean;
    dangerouslySkipPermissions: boolean;
  }>>([]);
  const [launchMode, setLaunchMode] = useState<'new' | 'existing'>('new');
  const [launchChannelName, setLaunchChannelName] = useState('');
  const [launchChannelId, setLaunchChannelId] = useState('');
  const [launchInProgress, setLaunchInProgress] = useState(false);
  const [deletingTeamId, setDeletingTeamId] = useState<string | null>(null);
  // Inline spawn form in the Roster section (right pane)
  const [showRosterSpawn, setShowRosterSpawn] = useState(false);
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [showRolesModal, setShowRolesModal] = useState(false);
  const [configModalAgentId, setConfigModalAgentId] = useState<string | null>(null);
  const [modelRegistry, setModelRegistry] = useState<ModelEntry[]>([]);
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);
  // Keep Alive state
  const [keepAliveParticipant, setKeepAliveParticipant] = useState<CollabParticipant | null>(null);
  const [keepAliveAgentIds, setKeepAliveAgentIds] = useState<Set<string>>(new Set());

  // Token usage state
  const [agentUsage, setAgentUsage] = useState<Record<string, { total: number; input: number; output: number; thinking: number }>>({}); // participantId -> token breakdown

  // Send validation state
  const [broadcastConfirmPending, setBroadcastConfirmPending] = useState(false);
  const [invalidMentions, setInvalidMentions] = useState<string[]>([]);
  const skipMentionValidationRef = React.useRef(false);

  // Pagination state
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const oldestLoadedTimestamp = useRef<string | null>(null);

  // Computer Use kill switch state
  const [computerUseEnabled, setComputerUseEnabled] = useState(false);
  const [activeComputerUseSessions, setActiveComputerUseSessions] = useState(0);
  const [killSwitchLoading, setKillSwitchLoading] = useState(false);
  const [killSwitchFlash, setKillSwitchFlash] = useState<'success' | 'error' | null>(null);

  const lastPollTime = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTypingRef = useRef(false);
  const markReadDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const markAsReadRef = useRef<((channelId: string) => void) | null>(null);

  const activeChannelProjectDirectory = resolveChannelWorkingDirectory(activeChannel, projects, '');

  // Draft autosave — track previous channel so we can save before switching
  const prevChannelIdRef = useRef<string | undefined>(undefined);
  const draftSaveDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Broadcast typing status to other participants
  const broadcastTypingStatus = useCallback(async (status: 'typing' | 'idle') => {
    if (!activeChannel || !participantId) return;
    // Don't send duplicate status
    if (status === 'typing' && isTypingRef.current) return;
    if (status === 'idle' && !isTypingRef.current) return;

    isTypingRef.current = status === 'typing';

    try {
      await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'heartbeat',
          channelId: activeChannel.id,
          participantId,
          activityStatus: status,
        }),
      });
    } catch {
      // Ignore errors
    }
  }, [activeChannel, participantId]);

  // Poll computer use status — enabled flag + active session count
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok || cancelled) return;
        const data = await res.json() as { settings?: { computerUse?: { enabled?: boolean } } };
        const enabled = data?.settings?.computerUse?.enabled === true;
        if (!cancelled) setComputerUseEnabled(enabled);

        if (enabled) {
          const cuRes = await fetch('/api/computer-use?summary=true');
          if (!cuRes.ok || cancelled) return;
          const cuData = await cuRes.json() as { activeSessions?: number };
          const count = cuData?.activeSessions ?? 0;
          if (!cancelled) setActiveComputerUseSessions(count);
        } else {
          if (!cancelled) setActiveComputerUseSessions(0);
        }
      } catch {
        // Ignore — non-critical
      }
    };

    poll();
    const interval = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const handleKillAllComputerUse = useCallback(async () => {
    if (killSwitchLoading) return;
    setKillSwitchLoading(true);
    setKillSwitchFlash(null);
    try {
      const res = await fetch('/api/computer-use/emergency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'kill_all' }),
      });
      if (res.ok) {
        setActiveComputerUseSessions(0);
        setKillSwitchFlash('success');
      } else {
        setKillSwitchFlash('error');
      }
    } catch {
      setKillSwitchFlash('error');
    } finally {
      setKillSwitchLoading(false);
      setTimeout(() => setKillSwitchFlash(null), 3000);
    }
  }, [killSwitchLoading]);

  // Play notification sound using Web Audio API
  const playNotificationSound = useCallback(() => {
    if (!soundEnabled) return;
    // Don't play if document is visible/focused
    if (document.visibilityState === 'visible' && document.hasFocus()) return;

    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      // Gentle notification tone
      oscillator.frequency.setValueAtTime(880, ctx.currentTime); // A5
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);

      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.15);
    } catch {
      // Audio not supported, silently fail
    }
  }, [soundEnabled]);

  // Toggle sound setting
  const toggleSound = useCallback(() => {
    setSoundEnabled(prev => {
      const newValue = !prev;
      localStorage.setItem('devflow-collab-sound', String(newValue));
      return newValue;
    });
  }, []);

  // Toggle silent messages visibility
  const toggleSilentMessages = useCallback(() => {
    setShowSilentMessages(prev => {
      const newValue = !prev;
      localStorage.setItem('devflow-collab-show-silent', String(newValue));
      return newValue;
    });
  }, []);

  // Copy message to clipboard
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const copyMessage = useCallback(async (messageId: string, content: string, html?: string) => {
    try {
      await writeRichClipboard({ text: content, html: html ?? '' });
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch {
      // Clipboard not available
    }
  }, []);

  // Helper function for relative timestamps
  const getRelativeTime = useCallback((timestamp: string): string => {
    const now = new Date();
    const then = new Date(timestamp);
    const diffMs = now.getTime() - then.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 30) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay === 1) return 'yesterday';
    if (diffDay < 7) return `${diffDay}d ago`;
    return then.toLocaleDateString();
  }, []);

  // Get participants who have read a message (their lastRead >= message timestamp)
  // For targeted messages, only show participants who were actual recipients
  const getReadBy = useCallback((msgTimestamp: string, participants: CollabParticipant[], excludeId?: string, recipients?: string[]): CollabParticipant[] => {
    const msgTime = new Date(msgTimestamp).getTime();
    return participants.filter(p => {
      if (p.id === excludeId) return false; // Exclude message author
      if (!p.lastRead) return false;
      // If message was targeted, only count participants who were recipients
      if (recipients && !recipients.includes(p.id)) return false;
      return new Date(p.lastRead).getTime() >= msgTime;
    });
  }, []);

  // Get participants who are currently typing (excluding self)
  const typingUsers = useMemo(() => {
    if (!activeChannel?.participants) return [];
    const now = Date.now();
    return activeChannel.participants.filter(p => {
      if (p.id === participantId) return false; // Exclude self
      if (p.activityStatus !== 'typing') return false;
      if (!p.activityUpdatedAt) return false;
      // Typing status expires after 5 seconds
      const age = now - new Date(p.activityUpdatedAt).getTime();
      return age < 5000;
    });
  }, [activeChannel?.participants, participantId, timeUpdate]);

  // Update relative times every minute
  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => {
      setTimeUpdate(prev => prev + 1);
    }, 60000);
    return () => clearInterval(interval);
  }, [isOpen]);

  // SSE: Subscribe to collab:message events for real-time message push
  useEffect(() => {
    if (!activeChannel || !eventStream.isSSE) return;

    return eventStream.subscribe<{
      channelId: string;
      message: CollabMessage;
      participants: CollabParticipant[];
    }>('collab:message', (data) => {
      if (data.channelId !== activeChannel.id) return;

      const msg = data.message;

      // Route silent messages to separate state — don't add to regular message history
      if (msg.silent) {
        if (showSilentMessages) {
          setSilentMessages(prev => [...prev, msg].slice(-50));
        }
        return;
      }

      setMessages(prev => {
        // Check if this is an update to an existing or streaming message
        const existingIdx = prev.findIndex(m => m.id === msg.id);
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = msg;
          return updated;
        }
        // Replace optimistic message if this is the server confirmation
        const optimisticIdx = prev.findIndex(m =>
          m.metadata?._optimistic &&
          m.from.id === msg.from.id &&
          Math.abs(new Date(m.timestamp).getTime() - new Date(msg.timestamp).getTime()) < 5000
        );
        if (optimisticIdx >= 0) {
          const updated = [...prev];
          updated[optimisticIdx] = msg;
          return updated;
        }
        // Play notification sound for messages from others
        if (msg.from.id !== participantId && msg.from.id !== 'system') {
          playNotificationSound();
        }
        return [...prev, msg];
      });

      // Track streaming messages
      if (msg.metadata?.isStreaming) {
        setStreamingMessageId(msg.id);
        setTypingParticipants(prev => {
          if (prev.some(t => t.participantId === msg.from.id)) return prev;
          return [...prev, {
            participantId: msg.from.id,
            participantName: msg.from.name,
            startedAt: Date.now(),
          }];
        });
      } else {
        setStreamingMessageId(null);
      }

      // Update participants from SSE data — only if actually changed
      if (data.participants) {
        setActiveChannel(prev => {
          if (!prev) return null;
          if (JSON.stringify(prev.participants) === JSON.stringify(data.participants)) return prev;
          return { ...prev, participants: data.participants };
        });
      }

      // Keep lastRead current while viewing — prevents stale unread badge counts
      if (msg.from.id !== participantId) {
        markAsReadRef.current?.(data.channelId);
      }
    });
  }, [activeChannel?.id, eventStream.subscribe, eventStream.isSSE, participantId, playNotificationSound, showSilentMessages]);

  // SSE: Subscribe to collab:participant events for join/leave
  useEffect(() => {
    if (!activeChannel || !eventStream.isSSE) return;

    return eventStream.subscribe<{
      channelId: string;
      action: 'joined' | 'left';
      participant: CollabParticipant;
      participants: CollabParticipant[];
    }>('collab:participant', (data) => {
      if (data.channelId !== activeChannel.id) return;
      setActiveChannel(prev => {
        if (!prev) return null;
        if (JSON.stringify(prev.participants) === JSON.stringify(data.participants)) return prev;
        return { ...prev, participants: data.participants };
      });
    });
  }, [activeChannel?.id, eventStream.subscribe, eventStream.isSSE]);

  // SSE: Subscribe to collab:typing events for typing/working indicators
  useEffect(() => {
    if (!activeChannel || !eventStream.isSSE) return;

    return eventStream.subscribe<{
      channelId: string;
      participantId: string;
      participantName: string;
      activityStatus: 'typing' | 'working' | 'idle';
      activityUpdatedAt: string;
      activityDetail?: string | null;
    }>('collab:typing', (data) => {
      if (data.channelId !== activeChannel.id) return;
      if (data.participantId === participantId) return; // Ignore own typing

      if (data.activityStatus === 'idle') {
        setTypingParticipants(prev => prev.filter(t => t.participantId !== data.participantId));
      } else {
        setTypingParticipants(prev => {
          const existing = prev.findIndex(t => t.participantId === data.participantId);
          const entry: TypingState = {
            participantId: data.participantId,
            participantName: data.participantName,
            startedAt: Date.now(),
            activity: data.activityStatus as 'typing' | 'working',
            activityDetail: data.activityDetail ?? null,
          };
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = entry;
            return updated;
          }
          return [...prev, entry];
        });
      }
    });
  }, [activeChannel?.id, eventStream.subscribe, eventStream.isSSE, participantId]);

  // Periodic staleness cleanup for typing/working indicators.
  // The poll fallback (below) has a timeout, but only runs when SSE is disconnected.
  // This effect runs ALWAYS (regardless of SSE) to catch stale entries.
  useEffect(() => {
    if (!activeChannel) return;

    const cleanupStaleActivity = () => {
      const now = Date.now();
      setTypingParticipants(prev => {
        const filtered = prev.filter(t => {
          // "working" expires after 25s, "typing" after 15s of no heartbeat refresh
          const timeout = t.activity === 'working' ? 25000 : 15000;
          return (now - t.startedAt) < timeout;
        });
        return filtered.length !== prev.length ? filtered : prev;
      });
    };

    const intervalId = setInterval(cleanupStaleActivity, 5000);
    return () => clearInterval(intervalId);
  }, [activeChannel?.id]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // inputRef points at the WYSIWYG editor's contenteditable DOM node (set in
  // handleEditorReady) so existing .focus() callers keep working.
  const inputRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const handleEditorReady = useCallback((ed: Editor) => {
    editorRef.current = ed;
    inputRef.current = ed.view.dom as HTMLElement;
    setEditor(ed);
  }, []);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Draft autosave — load draft when active channel changes, save previous channel draft
  useEffect(() => {
    const newChannelId = activeChannel?.id;
    const prevChannelId = prevChannelIdRef.current;

    // Save whatever was typed for the channel we're leaving
    if (prevChannelId && prevChannelId !== newChannelId) {
      const currentDraft = inputValue.trim();
      if (currentDraft) {
        localStorage.setItem(`devflow-draft-${prevChannelId}`, inputValue);
      } else {
        localStorage.removeItem(`devflow-draft-${prevChannelId}`);
      }
    }

    // Load saved draft for the channel we're entering
    if (newChannelId) {
      const saved = localStorage.getItem(`devflow-draft-${newChannelId}`) || '';
      setInputValue(saved);
    } else {
      setInputValue('');
    }

    prevChannelIdRef.current = newChannelId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannel?.id]);

  // Draft autosave — debounced write while user types
  useEffect(() => {
    const channelId = activeChannel?.id;
    if (!channelId) return;

    if (draftSaveDebounceRef.current) clearTimeout(draftSaveDebounceRef.current);
    draftSaveDebounceRef.current = setTimeout(() => {
      if (inputValue.trim()) {
        localStorage.setItem(`devflow-draft-${channelId}`, inputValue);
      } else {
        localStorage.removeItem(`devflow-draft-${channelId}`);
      }
    }, 300);

    return () => {
      if (draftSaveDebounceRef.current) clearTimeout(draftSaveDebounceRef.current);
    };
  }, [inputValue, activeChannel?.id]);

  // The reply tag is the reply link: delete the tag from the text and the reply goes with it.
  useEffect(() => {
    if (replyingTo && !hasReplyTag(inputValue, replyingTo.id)) setReplyingTo(null);
  }, [inputValue, replyingTo]);

  // Fetch silent messages when toggle is ON and a channel is active
  useEffect(() => {
    if (!showSilentMessages || !activeChannel) {
      setSilentMessages([]);
      return;
    }
    fetch(`/api/collab/silent-messages?channelId=${activeChannel.id}`)
      .then(r => r.json())
      .then(data => setSilentMessages(data.messages || []))
      .catch(() => setSilentMessages([]));
  }, [showSilentMessages, activeChannel?.id]);

  // Deduplicate messages by ID (safety net for SSE/poll/optimistic race conditions)
  const dedupedMessages = React.useMemo(() => {
    const seen = new Set<string>();
    const allMessages = showSilentMessages
      ? [...messages, ...silentMessages].sort((a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        )
      : messages;
    return allMessages.filter(msg => {
      if (seen.has(msg.id)) return false;
      if (!showSilentMessages && msg.silent) return false;
      seen.add(msg.id);
      return true;
    }).map(formatCrossChannelMessageForHumans);
  }, [messages, silentMessages, showSilentMessages]);

  // Apply per-agent and @owner-only filters (system messages are never hidden)
  const participantAndMentionFilteredMessages = React.useMemo(() => {
    let msgs = dedupedMessages;
    // Per-agent filter: hide messages from hidden participants (never hide system messages)
    if (hiddenParticipants.size > 0) {
      msgs = msgs.filter(msg => msg.from.id === 'system' || !hiddenParticipants.has(msg.from.id));
    }
    // @owner-only filter: show messages @mentioning the owner OR sent by the owner
    if (mentionsOnlyMode) {
      msgs = msgs.filter(msg =>
        mentionsHuman(msg.content) ||
        msg.from.id === participantId
      );
    }
    return msgs;
  }, [dedupedMessages, hiddenParticipants, mentionsOnlyMode, participantId]);

  // Filter messages based on search query
  const filteredMessages = searchQuery.trim()
    ? participantAndMentionFilteredMessages.filter(msg =>
        msg.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
        msg.from.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : participantAndMentionFilteredMessages;

  // Reset search index when query changes
  useEffect(() => {
    setSearchResultIndex(0);
  }, [searchQuery]);

  // The active (focused) search result message ID
  const activeSearchMessageId = searchQuery.trim() && filteredMessages.length > 0
    ? filteredMessages[searchResultIndex]?.id
    : null;

  // Scroll to the active search result
  useEffect(() => {
    if (activeSearchMessageId) {
      const el = document.getElementById(`msg-${activeSearchMessageId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeSearchMessageId]);

  // Navigate search results
  const goToSearchResult = useCallback((direction: 'next' | 'prev') => {
    if (!searchQuery.trim() || filteredMessages.length === 0) return;
    setSearchResultIndex(prev => {
      if (direction === 'next') return prev < filteredMessages.length - 1 ? prev + 1 : 0;
      return prev > 0 ? prev - 1 : filteredMessages.length - 1;
    });
  }, [searchQuery, filteredMessages.length]);

  // Get pinned messages (sorted by pin time, newest first)
  const pinnedMessages = messages.filter(msg => msg.pinnedAt).sort((a, b) =>
    new Date(b.pinnedAt!).getTime() - new Date(a.pinnedAt!).getTime()
  );

  // Find the first unread message ID for showing divider
  const firstUnreadMessageId = useMemo(() => {
    if (!activeChannel) return null;
    const participant = activeChannel.participants.find(p => p.id === participantId);
    if (!participant?.lastRead) return null;

    const lastReadTime = new Date(participant.lastRead);
    const unreadMsg = messages.find(m =>
      m.from.id !== participantId &&
      m.from.id !== 'system' &&
      new Date(m.timestamp) > lastReadTime
    );
    return unreadMsg?.id || null;
  }, [activeChannel, participantId, messages]);

  // Frozen agent detection — see lib/frozen-detection.ts for thresholds and exemptions.
  const frozenParticipantIds = useMemo(() => {
    if (!activeChannel?.participants) return new Set<string>();
    return detectFrozenParticipantIds({
      participants: activeChannel.participants,
      messages,
      activeTyping: typingParticipants.map(t => ({
        participantId: t.participantId,
        activity: t.activity,
        activityDetail: t.activityDetail ?? null,
      })),
      now: Date.now(),
    });
  }, [activeChannel?.participants, messages, typingParticipants]);

  // Highlight matching text in search results
  const highlightMatch = (text: string, query: string, isActiveResult?: boolean) => {
    if (!query.trim()) return text;
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark key={i} className={`${isActiveResult ? 'bg-yellow-400/70 text-black' : 'bg-yellow-500/40 text-white'} rounded px-0.5`}>{part}</mark>
      ) : (
        part
      )
    );
  };

  // Apply search highlighting to React nodes (wraps string children)
  const applySearchHighlight = (nodes: React.ReactNode, query: string, isActiveResult?: boolean): React.ReactNode => {
    if (!query.trim()) return nodes;
    if (typeof nodes === 'string') return highlightMatch(nodes, query, isActiveResult);
    if (Array.isArray(nodes)) return nodes.map((node, i) => {
      if (typeof node === 'string') return <React.Fragment key={`sh-${i}`}>{highlightMatch(node, query, isActiveResult)}</React.Fragment>;
      return node;
    });
    return nodes;
  };


  // Mark channel as read
  const markAsRead = useCallback(async (channelId: string) => {
    if (!participantId) return;

    try {
      await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mark_read',
          channelId,
          participantId,
        }),
      });

      // Update local unread counts
      setUnreadCounts(prev => ({ ...prev, [channelId]: 0 }));
    } catch (err) {
      console.error('Failed to mark as read:', err);
    }
  }, [participantId]);

  // Debounced mark-as-read: keeps lastRead current while viewing a channel.
  // Without this, lastRead only updates on join — messages arriving while viewing
  // are counted as "unread" when switching away, inflating the badge count.
  const debouncedMarkAsRead = useCallback((channelId: string) => {
    if (markReadDebounceRef.current) {
      clearTimeout(markReadDebounceRef.current);
    }
    markReadDebounceRef.current = setTimeout(() => {
      // A tab nobody is looking at (background tab, locked phone) must not mark messages read: the read
      // state belongs to the person, so the channel would drop out of "Needs you" unseen. The focus effect
      // below marks it read when the tab is actually looked at again.
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      markAsRead(channelId);
    }, 2000);
  }, [markAsRead]);

  // Keep ref in sync so SSE handler (declared earlier) can access it
  markAsReadRef.current = debouncedMarkAsRead;

  // Back in view: whatever arrived while the tab was hidden is now seen, so mark it read.
  useEffect(() => {
    const onBackInView = () => {
      if (document.visibilityState === 'visible' && document.hasFocus() && activeChannel?.id) {
        markAsReadRef.current?.(activeChannel.id);
      }
    };
    document.addEventListener('visibilitychange', onBackInView);
    window.addEventListener('focus', onBackInView);
    return () => {
      document.removeEventListener('visibilitychange', onBackInView);
      window.removeEventListener('focus', onBackInView);
    };
  }, [activeChannel?.id]);

  // Resolve slim messages: convert fromId → from object using participants array from API response
  const resolveSlimMessages = useCallback((messages: CollabMessage[], responseParticipants: CollabParticipant[]): CollabMessage[] => {
    const participantMap = new Map<string, CollabParticipant>(
      responseParticipants.map(p => [p.id, p])
    );
    return messages.map(msg => {
      if (msg.from) return msg; // already a full message (non-slim response)
      const fromId = (msg as unknown as { fromId: string }).fromId;
      // A cross-channel sender belongs to another channel, so it is not in this channel's participants.
      // Never show the raw id (e.g. a pty-xxxx session): use the name the route carries.
      const routeSender = (msg.metadata?.crossChannel as { senderName?: unknown } | undefined)?.senderName;
      const resolved: CollabParticipant = participantMap.get(fromId) ?? {
        id: fromId,
        name: typeof routeSender === 'string' && routeSender ? routeSender : 'Unknown sender',
        color: '#8B5CF6',
        type: 'user',
        source: 'unknown',
        status: 'offline',
        joinedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
      return { ...msg, from: resolved };
    });
  }, []);

  // Fetch channels
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const channelsRes = await fetch(`/api/collab?participantId=${encodeURIComponent(BROWSER_PARTICIPANT_ID)}`);

      if (channelsRes.ok) {
        const data = await channelsRes.json();
        const fetchedChannels = data.channels || [];
        setChannels(fetchedChannels);
        setChannelGroups(resolveChannelGroups(data));

        // Calculate unread counts
        const counts: Record<string, number> = {};
        for (const channel of fetchedChannels) {
          counts[channel.id] = getSidebarUnreadCount(channel.participants, {
            resolvedParticipantId: data.participantId,
            browserParticipantId: BROWSER_PARTICIPANT_ID,
            browserUsername: getBrowserUsername(),
          });
        }
        setUnreadCounts(counts);

        // Sync activeChannel with fresh data ONLY if it actually changed
        // This prevents unnecessary re-renders and flickering
        setActiveChannel(prev => {
          if (!prev) return null;
          const freshChannel = fetchedChannels.find((c: CollabChannel) => c.id === prev.id);
          if (!freshChannel) return prev;

          // Only update if there are meaningful changes
          // Note: Do NOT compare messages.length — the list endpoint returns messages:[]
          // for efficiency, while activeChannel has populated messages from join. Comparing
          // them would cause constant unnecessary re-renders.
          const hasChanges =
            freshChannel.name !== prev.name ||
            freshChannel.description !== prev.description ||
            freshChannel.teamLeadId !== prev.teamLeadId ||
            JSON.stringify(freshChannel.participants) !== JSON.stringify(prev.participants) ||
            JSON.stringify(freshChannel.roster?.agents) !== JSON.stringify(prev.roster?.agents);

          // Preserve messages from prev — list endpoint returns messages:[] for efficiency
          return hasChanges ? { ...freshChannel, messages: prev.messages } : prev;
        });
      }
    } catch (error) {
      logCollabError('fetch channels', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Keep inactive-channel badges and ordering live. The existing message SSE
  // handler is scoped to the open channel; this lightweight listener refreshes
  // sidebar metadata when another channel receives a message.
  useEffect(() => {
    if (!isOpen || !eventStream.isSSE) return;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = eventStream.subscribe<{ channelId: string }>(
      'collab:message',
      ({ channelId }) => {
        if (channelId === activeChannel?.id) return;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => fetchData(), 150);
      },
    );

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [activeChannel?.id, eventStream, fetchData, isOpen]);

  // Fetch teams
  const fetchTeams = useCallback(async () => {
    setTeamsLoading(true);
    try {
      const res = await fetch('/api/teams');
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.data?.teams) {
          setTeams(data.data.teams);
        }
      }
    } catch (error) {
      console.error('Failed to fetch teams:', error);
    } finally {
      setTeamsLoading(false);
    }
  }, []);

  // Fetch projects (for project-team/channel linking)
  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      if (res.ok) {
        const data = await res.json();
        if (data.projects) {
          setProjects(data.projects);
        }
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    }
  }, []);

  const fetchRoles = useCallback(async () => {
    try {
      const res = await fetch('/api/roles');
      if (res.ok) {
        const data = await res.json();
        if (data.data?.roles) {
          setRoles(data.data.roles);
        }
      }
    } catch (error) {
      console.error('Failed to fetch roles:', error);
    }
  }, []);

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'skills_list' }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.items) {
          const designCommandNames = new Set<string>(
            CLAUDE_DESIGN_AGENTCHAT_COMMANDS.map(command => command.name),
          );
          setAllSkills([
            ...CLAUDE_DESIGN_AGENTCHAT_COMMANDS,
            ...data.items.filter((item: { name: string }) => !designCommandNames.has(item.name)),
          ]);
        }
      }
    } catch (error) {
      console.error('Failed to fetch skills:', error);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    if (isOpen) {
      fetchData();
      fetchTeams();
      fetchProjects();
      fetchRoles();
      fetchSkills();
    }
  }, [isOpen, fetchData, fetchTeams, fetchProjects, fetchRoles, fetchSkills]);

  useEffect(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then(data => setModelRegistry(data.models || []))
      .catch(() => {}); // silently ignore — fallback to empty (pickers show "Default model" only)
  }, []);

  // Group channels into parent/sub-channel hierarchy
  // WhatsApp bridge channel — dedicated HQ slot above channel list
  const COMMANDER_CHANNEL_ID = '3b994a27-0a17-46a9-99eb-03e38b6832e6';

  const { commanderChannel, parentChannels, subChannelsByParent } = useMemo(
    () => groupChannelsForSidebar(channels, COMMANDER_CHANNEL_ID),
    [channels],
  );

  const groupAction = useCallback(async (action: string, fields: Record<string, unknown>) => {
    const response = await fetch('/api/collab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Could not update the group.');
    if (data.channelGroups) setChannelGroups(data.channelGroups);
    await fetchData();
  }, [fetchData]);
  const pinChannel = useCallback(async (channel: CollabChannel) => {
    const response = await fetch('/api/collab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update_settings', channelId: channel.id, pinned: !channel.pinnedAt }) });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Could not pin the channel.');
    await fetchData();
  }, [fetchData]);

  // Persist collapsed state to localStorage
  const toggleParentCollapsed = useCallback((parentId: string) => {
    setCollapsedParents(prev => {
      const next = new Set(prev);
      if (next.has(parentId)) {
        next.delete(parentId);
      } else {
        next.add(parentId);
      }
      localStorage.setItem('devflow-collab-collapsed-channels', JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Create sub-channel handler
  const handleCreateSubChannel = async () => {
    if (!subChannelParentId || selectedSubChannelMembers.size === 0) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_subchannel',
          channelId: subChannelParentId,
          participantId: BROWSER_PARTICIPANT_ID,
          participantIds: [BROWSER_PARTICIPANT_ID, ...Array.from(selectedSubChannelMembers)],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.channel) {
          setChannels(prev => [...prev, data.channel]);
          setActiveChannel(data.channel);
        }
      }
    } catch (error) {
      console.error('Failed to create sub-channel:', error);
    } finally {
      setShowSubChannelModal(false);
      setSubChannelParentId(null);
      setSelectedSubChannelMembers(new Set());
    }
  };

  // Open sub-channel creation modal for a parent channel
  const openSubChannelModal = (parentId: string) => {
    setSubChannelParentId(parentId);
    setSelectedSubChannelMembers(new Set());
    setShowSubChannelModal(true);
  };

  // Drag-and-drop sensors (require 8px movement to start drag, avoids conflicts with click)
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const handleChannelDragStart = useCallback((event: DragStartEvent) => {
    setDragActiveId(event.active.id as string);
  }, []);

  const handleChannelDragOver = useCallback((event: { over: { id: string | number } | null }) => {
    setDragOverId(event.over?.id as string | null);
  }, []);

  const handleChannelDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    setDragActiveId(null);
    setDragOverId(null);

    if (!active || !over || active.id === over.id) return;

    const draggedChannel = channels.find(c => c.id === active.id);
    const targetChannel = channels.find(c => c.id === over.id);
    if (!draggedChannel || !targetChannel) return;

    // Can't nest a subchannel under another subchannel (max 1 level)
    if (targetChannel.parentChannelId) return;
    // Can't drop a parent onto its own subchannel
    if (draggedChannel.id === targetChannel.parentChannelId) return;
    // Already a child of this parent — no-op
    if (draggedChannel.parentChannelId === targetChannel.id) return;
    // Can't nest a channel that has children
    const hasChildren = channels.some(c => c.parentChannelId === draggedChannel.id);
    if (hasChildren) return;

    // Optimistic UI update — move channel immediately
    const previousChannels = [...channels];
    setChannels(prev => prev.map(c =>
      c.id === draggedChannel.id
        ? { ...c, parentChannelId: targetChannel.id }
        : c
    ));
    // Expand target so the nested channel is visible
    setCollapsedParents(prev => {
      if (prev.has(targetChannel.id)) {
        const next = new Set(prev);
        next.delete(targetChannel.id);
        localStorage.setItem('devflow-collab-collapsed-channels', JSON.stringify([...next]));
        return next;
      }
      return prev;
    });

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reparent',
          channelId: draggedChannel.id,
          parentChannelId: targetChannel.id,
          participantId: BROWSER_PARTICIPANT_ID,
        }),
      });
      if (!res.ok) {
        // Revert on failure
        setChannels(previousChannels);
      }
    } catch (error) {
      console.error('Failed to reparent channel:', error);
      // Revert on error
      setChannels(previousChannels);
    }
  }, [channels, fetchData]);

  // Make channel top-level (remove parent)
  const handleMakeTopLevel = useCallback(async (channelId: string) => {
    // Optimistic UI update
    const previousChannels = [...channels];
    setChannels(prev => prev.map(c =>
      c.id === channelId ? { ...c, parentChannelId: undefined } : c
    ));

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reparent',
          channelId,
          parentChannelId: null,
          participantId: BROWSER_PARTICIPANT_ID,
        }),
      });
      if (!res.ok) {
        setChannels(previousChannels);
      }
    } catch (error) {
      console.error('Failed to make channel top-level:', error);
      setChannels(previousChannels);
    }
  }, [channels]);

  // Auto-select channel when initialChannelId is provided (e.g. from Idea Board "Discuss")
  useEffect(() => {
    if (!initialChannelId || channels.length === 0) return;
    const target = channels.find(c => c.id === initialChannelId);
    if (target && target.id !== activeChannel?.id) {
      setActiveChannel(target);
    }
  }, [initialChannelId, channels]);

  // Persist last-opened channel to localStorage
  useEffect(() => {
    if (activeChannel?.id) {
      localStorage.setItem('devflow-last-collab-channel', activeChannel.id);
    }
  }, [activeChannel?.id]);

  // Restore last-opened channel on mount (when no initialChannelId provided)
  useEffect(() => {
    if (initialChannelId || activeChannel || channels.length === 0) return;
    const lastChannelId = localStorage.getItem('devflow-last-collab-channel');
    if (!lastChannelId) return;
    const target = channels.find(c => c.id === lastChannelId);
    if (target) setActiveChannel(target);
  }, [channels, initialChannelId]);

  // Rejoin channel — reusable for both initial join and pre-send recovery
  const rejoinChannel = useCallback(async (channelId: string): Promise<string | null> => {
    try {
      setIsReconnecting(true);
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'join',
          channelId,
          participant: {
            id: BROWSER_PARTICIPANT_ID,
            type: 'user',
            name: getBrowserUsername(),
            source: 'DevFlow Browser',
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          const newParticipantId = data.participantId || BROWSER_PARTICIPANT_ID;
          setParticipantId(newParticipantId);
          localStorage.setItem('devflow-collab-participantId', newParticipantId);
          setIsReconnecting(false);
          return newParticipantId;
        }
      }
      setIsReconnecting(false);
      return null;
    } catch (err) {
      logCollabError('rejoin channel', err, { channelId });
      setIsReconnecting(false);
      return null;
    }
  }, []);

  // Join channel when selected
  useEffect(() => {
    if (!activeChannel) {
      setMessages([]);
      setHasMoreMessages(false);
      oldestLoadedTimestamp.current = null;
      setParticipantId(null);
      setTypingParticipants([]);
      lastPollTime.current = null;
      return;
    }

    // Capture channel ID at effect creation time for race-condition-safe guards.
    // If the user switches channels before the join fetch returns, this ID
    // will differ from the current activeChannel.id, and we safely bail out.
    const targetChannelId = activeChannel.id;

    // Clear messages and typing state immediately when switching channels to prevent
    // stale data from the previous channel being shown
    setMessages([]);
    setHasMoreMessages(false);
    setTypingParticipants([]);
    oldestLoadedTimestamp.current = null;
    lastPollTime.current = null;

    const joinChannel = async () => {
      try {
        setIsReconnecting(true);
        const res = await fetch('/api/collab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'join',
            channelId: targetChannelId,
            participant: {
              id: BROWSER_PARTICIPANT_ID,
              type: 'user',
              name: getBrowserUsername(),
              source: 'DevFlow Browser',
            },
          }),
        });

        if (!res.ok) {
          logCollabError('join channel', res, { channelId: targetChannelId });
          setIsReconnecting(false);
          return;
        }

        // Guard against non-JSON responses (e.g. Cloudflare tunnel HTML error pages)
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          logCollabError('join channel', new Error(`Unexpected content-type: ${contentType}`), { channelId: targetChannelId });
          setIsReconnecting(false);
          return;
        }

        const data = await res.json();

        if (!data.success || !data.channel) {
          logCollabError('join channel', new Error(data.error || 'Join response missing channel data'), { channelId: targetChannelId });
          setIsReconnecting(false);
          return;
        }

        // Race guard: if user switched channels while this fetch was in-flight,
        // discard the stale response. Use functional setState to read current state.
        setActiveChannel(currentChannel => {
          if (!currentChannel || currentChannel.id !== targetChannelId) {
            // Channel changed — discard this join response
            return currentChannel;
          }
          // Channel still matches — apply fresh data
          setMessages(data.channel.messages || []);
          setHasMoreMessages(!!data.hasMore);
          oldestLoadedTimestamp.current = data.oldestTimestamp || null;
          const newParticipantId = data.participantId || BROWSER_PARTICIPANT_ID;
          setParticipantId(newParticipantId);
          localStorage.setItem('devflow-collab-participantId', newParticipantId);

          // Persist server-returned name so subsequent page loads show the
          // correct identity, not "Browser User". The server may resolve a
          // canonical name via webgate identity or preferredNames.
          const serverParticipant = data.channel.participants?.find(
            (p: { id: string; name: string }) => p.id === newParticipantId
          );
          if (serverParticipant?.name && serverParticipant.name !== 'Browser User') {
            localStorage.setItem('devflow-collab-username', serverParticipant.name);
          }

          setIsReconnecting(false);
          lastPollTime.current = new Date().toISOString();

          // Mark as read immediately after joining, unless this tab is hidden (a reloaded background tab):
          // the back-in-view effect marks it read when somebody actually looks.
          if (document.visibilityState === 'visible' && document.hasFocus()) {
            fetch('/api/collab', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'mark_read',
                channelId: targetChannelId,
                participantId: newParticipantId,
              }),
            }).catch(() => {});
            setUnreadCounts(prev => ({ ...prev, [targetChannelId]: 0 }));
          }

          return data.channel;
        });
      } catch (err) {
        logCollabError('join channel', err, { channelId: targetChannelId });
        setIsReconnecting(false);
      }
    };

    joinChannel();

    // Cleanup: mark channel as read when switching away
    return () => {
      if (targetChannelId && participantId) {
        // Fire-and-forget mark_read on channel leave
        fetch('/api/collab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'mark_read',
            channelId: targetChannelId,
            participantId,
          }),
        }).catch(() => {}); // Best-effort
      }
    };
  }, [activeChannel?.id]);

  // Poll for new messages — primary when SSE is down, reconciliation when SSE is active.
  // SSE can drop events (tab backgrounded, network blip, reconnect gap).
  // Without this catch-up poll, missed messages become permanently invisible.
  useEffect(() => {
    if (!activeChannel) return;

    const pollMessages = async () => {
      try {
        const since = lastPollTime.current || new Date().toISOString();
        const res = await fetch(
          `/api/collab?channelId=${activeChannel.id}&since=${encodeURIComponent(since)}&slim=1`
        );

        if (res.ok) {
          const data = await res.json();
          let hasStreamingMsg = false;

          if (data.messages && data.messages.length > 0) {
            const resolvedMsgs = resolveSlimMessages(data.messages, data.participants || []);
            // Handle streaming messages - update existing or add new
            setMessages(prev => {
              const newMessages = [...prev];
              for (const msg of resolvedMsgs) {
                // Check if this is an update to a streaming message
                const existingIdx = newMessages.findIndex(m => m.id === msg.id);
                if (existingIdx >= 0) {
                  // Update existing message (streaming update)
                  newMessages[existingIdx] = msg;
                } else {
                  // Add new message
                  newMessages.push(msg);
                  // Play notification sound for messages from others
                  if (msg.from.id !== participantId && msg.from.id !== 'system') {
                    playNotificationSound();
                  }
                }
              }
              return newMessages;
            });

            // Track streaming messages
            const streamingMsg = resolvedMsgs.find((m: CollabMessage) => m.metadata?.isStreaming);
            if (streamingMsg) {
              hasStreamingMsg = true;
              setStreamingMessageId(streamingMsg.id);
              // Add to typing indicators if not already there
              setTypingParticipants(prev => {
                const exists = prev.some(t => t.participantId === streamingMsg.from.id);
                if (!exists) {
                  return [...prev, {
                    participantId: streamingMsg.from.id,
                    participantName: streamingMsg.from.name,
                    startedAt: Date.now(),
                  }];
                }
                return prev;
              });
            } else {
              setStreamingMessageId(null);
            }
          }

          // Always check activity status from participants on every poll
          // (streaming takes priority — skip if a streaming message is active)
          if (!hasStreamingMsg) {
            const now = Date.now();
            const typingFromActivity = (data.participants || [])
              .filter((p: CollabParticipant) => {
                if (p.activityStatus !== 'typing' && p.activityStatus !== 'working') return false;
                const activityAge = p.activityUpdatedAt
                  ? now - new Date(p.activityUpdatedAt).getTime()
                  : Infinity;
                // Fallback timeouts if SSE heartbeats stop arriving.
                // Wrapper sends heartbeats every 5s during work. 20s = 4 missed heartbeats.
                const timeout = p.activityStatus === 'working' ? 20000 : 15000;
                return activityAge < timeout;
              })
              .map((p: CollabParticipant) => ({
                participantId: p.id,
                participantName: p.name,
                startedAt: now,
                activity: p.activityStatus as 'typing' | 'working',
              }));
            setTypingParticipants(typingFromActivity);
          }
          if (data.participants) {
            setActiveChannel(prev => {
              if (!prev) return null;
              const updates: Partial<typeof prev> = { participants: data.participants };
              // Sync roster status from poll response (faster than waiting for full refresh)
              if (data.roster) {
                updates.roster = data.roster;
              }
              return { ...prev, ...updates };
            });
          }
          lastPollTime.current = data.timestamp;

          // Keep lastRead current while viewing — prevents stale unread badge counts
          if (data.messages && data.messages.length > 0) {
            const hasOtherMessages = data.messages.some((m: CollabMessage) => m.from?.id !== participantId);
            if (hasOtherMessages && activeChannel?.id) {
              markAsReadRef.current?.(activeChannel.id);
            }
          }
        }
      } catch (err) {
        logCollabError('poll messages', err, { channelId: activeChannel?.id });
      }
    };

    // 5s when SSE is down (primary delivery), 15s when SSE is up (catch-up for missed events)
    const interval = setInterval(pollMessages, eventStream.isSSE ? 15000 : 5000);
    return () => {
      clearInterval(interval);
      // Mark as read when switching away from this channel
      if (markReadDebounceRef.current) {
        clearTimeout(markReadDebounceRef.current);
      }
    };
  }, [activeChannel?.id, eventStream.isSSE, participantId]);

  // Periodic full channel refresh (roster, sessions, etc.) — 30s when SSE active, 10s fallback
  useEffect(() => {
    if (!isOpen) return;
    const refreshInterval = eventStream.isSSE ? 30000 : 10000;
    const fullRefresh = setInterval(() => fetchData(), refreshInterval);
    return () => clearInterval(fullRefresh);
  }, [isOpen, fetchData, eventStream.isSSE]);

  // Auto-cleanup stale participants — remove after 10 minutes of no heartbeat
  // Uses ref for participants to avoid re-running the effect (and resetting timers)
  // on every participant update from SSE.
  const activeChannelRef = useRef(activeChannel);
  activeChannelRef.current = activeChannel;
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  useEffect(() => {
    if (!activeChannel?.id || !isOpen) return;

    const STALE_AUTO_REMOVE_MS = 10 * 60 * 1000; // 10 minutes

    const cleanupStale = async () => {
      const current = activeChannelRef.current;
      if (!current?.participants) return;

      const staleParticipants = selectStaleParticipantsForCleanup({
        participants: current.participants,
        parentChannel: current.parentChannelId
          ? channelsRef.current.find(c => c.id === current.parentChannelId) ?? null
          : null,
        rosterAgents: current.roster?.agents,
        protectedParticipantIds: [BROWSER_PARTICIPANT_ID],
        nowMs: Date.now(),
        staleAfterMs: STALE_AUTO_REMOVE_MS,
      });

      for (const p of staleParticipants) {
        try {
          await fetch('/api/collab', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'leave',
              channelId: current.id,
              participantId: p.id,
              // Idle is not misbehaviour: remove without the 7-day rejoin block.
              block: false,
            }),
          });
        } catch {
          // Silently ignore cleanup failures
        }
      }

      if (staleParticipants.length > 0) {
        fetchData();
      }
    };

    // Run cleanup every 60 seconds
    const interval = setInterval(cleanupStale, 60000);
    // Also run once on mount after a short delay
    const initial = setTimeout(cleanupStale, 5000);
    return () => {
      clearInterval(interval);
      clearTimeout(initial);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannel?.id, isOpen, fetchData]);

  // Poll per-agent token usage for active channel (every 10s)
  useEffect(() => {
    if (!isOpen || !participantId || !activeChannel?.id) { setAgentUsage({}); return; }
    const fetchAgentUsage = async () => {
      try {
        const res = await fetch(`/api/collab/usage?channelId=${activeChannel.id}`);
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.data?.agents) {
            const map: Record<string, { total: number; input: number; output: number; thinking: number }> = {};
            for (const agent of data.data.agents) {
              map[agent.participantId] = {
                total: agent.totalTokens,
                input: agent.tokens?.inputTokens || 0,
                output: agent.tokens?.outputTokens || 0,
                thinking: agent.tokens?.thinkingTokens || 0,
              };
            }
            setAgentUsage(map);
          }
        }
      } catch {}
    };
    fetchAgentUsage();
    const interval = setInterval(fetchAgentUsage, 10000);
    return () => clearInterval(interval);
  }, [isOpen, participantId, activeChannel?.id]);

  // Load older messages when scrolling to top
  const loadOlderMessages = useCallback(async () => {
    if (!activeChannel || !hasMoreMessages || loadingOlderMessages || !oldestLoadedTimestamp.current) return;

    setLoadingOlderMessages(true);
    try {
      const res = await fetch(
        `/api/collab?channelId=${activeChannel.id}&before=${encodeURIComponent(oldestLoadedTimestamp.current)}&limit=50&slim=1`
      );
      if (res.ok) {
        const data = await res.json();
        if (data.messages && data.messages.length > 0) {
          const resolvedMsgs = resolveSlimMessages(data.messages, data.participants || []);
          // Save scroll position before prepending
          const container = messagesContainerRef.current;
          const prevScrollHeight = container?.scrollHeight || 0;

          setMessages(prev => {
            // Deduplicate by ID
            const existingIds = new Set(prev.map(m => m.id));
            const newMsgs = resolvedMsgs.filter((m: CollabMessage) => !existingIds.has(m.id));
            return [...newMsgs, ...prev];
          });

          setHasMoreMessages(!!data.hasMore);
          oldestLoadedTimestamp.current = data.oldestTimestamp || null;

          // Restore scroll position after prepending (next frame)
          requestAnimationFrame(() => {
            if (container) {
              const newScrollHeight = container.scrollHeight;
              container.scrollTop = newScrollHeight - prevScrollHeight;
            }
          });
        } else {
          setHasMoreMessages(false);
        }
      }
    } catch (err) {
      console.error('[Collab] Failed to load older messages:', err);
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [activeChannel?.id, hasMoreMessages, loadingOlderMessages]);

  // Scroll-to-top detection for loading older messages
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !hasMoreMessages || activeView !== 'chat') return;

    const checkShouldLoad = () => {
      if (container.scrollTop < 300 && hasMoreMessages && !loadingOlderMessages) {
        loadOlderMessages();
      }
    };

    const handleScroll = () => {
      checkShouldLoad();
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    // Also check immediately — if content doesn't fill the viewport (no scrollbar),
    // no scroll event will ever fire, so we need to check on mount.
    // Use a short delay to let the DOM settle after messages render.
    const timerId = setTimeout(() => {
      if (container.scrollTop < 300 && container.scrollHeight <= container.clientHeight + 50) {
        checkShouldLoad();
      }
    }, 200);

    return () => {
      container.removeEventListener('scroll', handleScroll);
      clearTimeout(timerId);
    };
  }, [hasMoreMessages, loadingOlderMessages, loadOlderMessages, activeView]);

  const prevActiveView = useRef(activeView);
  const savedScrollPosition = useRef<number | null>(null);
  // Sticky flag: set on channel/view switch, cleared after scrolling with real messages
  const needsScrollToBottom = useRef(true);
  // Track if user is near bottom BEFORE new messages arrive (updated by scroll events)
  const wasNearBottom = useRef(true);

  // Ref callback for the messages container — fires when the element mounts (i.e. when chat
  // tab becomes active after AnimatePresence finishes its exit animation on the previous tab).
  // Scrolls to bottom immediately on mount so tab switches always land at the bottom.
  const setMessagesContainerRef = useCallback((el: HTMLDivElement | null) => {
    messagesContainerRef.current = el;
    if (el) {
      // Double-RAF: first frame lets React commit layout, second ensures scrollHeight is final
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight;
        });
      });
    }
  }, []);

  // Set flag when channel changes or view switches to chat
  useEffect(() => {
    needsScrollToBottom.current = true;
    // Close pinned messages panel when switching channels
    setShowPinnedPanel(false);
  }, [activeChannel?.id]);

  // Auto-scroll only if near bottom or when flag is set (channel/view switch)
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || activeView !== 'chat') {
      prevActiveView.current = activeView;
      return;
    }

    const wasViewSwitched = prevActiveView.current !== 'chat' && activeView === 'chat';
    prevActiveView.current = activeView;

    // Tab switch scroll is handled by setMessagesContainerRef (ref callback) — the chat
    // container remounts after AnimatePresence exit animation, so the ref callback fires
    // at the right time. Nothing to do here for wasViewSwitched.
    if (wasViewSwitched) {
      needsScrollToBottom.current = true;
    }

    // Don't scroll to bottom on empty messages - wait for real messages to load
    if (needsScrollToBottom.current && messages.length === 0) return;

    const shouldForceScroll = needsScrollToBottom.current;

    // Use wasNearBottom ref (tracked by scroll events BEFORE new messages change scrollHeight)
    // This prevents the bug where a tall incoming message pushes the user "far" from bottom
    // even though they were at the bottom before the message arrived
    const isNearBottom = wasNearBottom.current;

    if (isNearBottom || shouldForceScroll) {
      if (shouldForceScroll) {
        needsScrollToBottom.current = false;
      }
      // Use requestAnimationFrame to ensure DOM has rendered new messages,
      // then set scrollTop directly for reliable scrolling
      const rafId = requestAnimationFrame(() => {
        const c = messagesContainerRef.current;
        if (c) {
          if (shouldForceScroll) {
            c.scrollTop = c.scrollHeight;
          } else {
            c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
          }
        }
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [messages, activeView]);

  // Track scroll position to show/hide jump to bottom button
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || activeView !== 'chat') return;

    const handleScroll = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollToBottom(distanceFromBottom > 150);
      // Track scroll position for auto-scroll decisions (before new messages arrive)
      wasNearBottom.current = distanceFromBottom < 150;
    };

    container.addEventListener('scroll', handleScroll);
    // Initial check
    handleScroll();

    return () => container.removeEventListener('scroll', handleScroll);
  }, [activeChannel?.id, activeView]);

  // Scroll to bottom function
  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    }
  }, []);

  // Tab-switch handler: save scroll position synchronously before the chat DOM unmounts
  const handleSetActiveView = useCallback((view: typeof activeView) => {
    setActiveView(view);
  }, [activeView]);

  // Focus input when channel changes
  useEffect(() => {
    if (activeChannel && inputRef.current) {
      inputRef.current.focus();
    }
  }, [activeChannel?.id]);

  // Toggle sidebar collapsed state
  // Close mobile drawers when switching to desktop/tablet
  useEffect(() => {
    if (!isMobile) {
      setIsMobileSidebarOpen(false);
      setIsMobileRightPanelOpen(false);
    }
  }, [isMobile]);

  // Close hamburger menu when viewport crosses above 1200px
  useEffect(() => {
    if (viewportWidth >= 1200) {
      setIsMobileMenuOpen(false);
    }
  }, [viewportWidth]);

  // Close mobile sidebar when a channel is selected
  const handleMobileChannelSelect = useCallback(() => {
    if (isMobile) {
      setIsMobileSidebarOpen(false);
    }
  }, [isMobile]);

  const toggleSidebar = useCallback(() => {
    if (isMobile) {
      setIsMobileSidebarOpen(prev => !prev);
      return;
    }
    setIsSidebarCollapsed(prev => {
      const newValue = !prev;
      localStorage.setItem('devflow-collab-sidebar-collapsed', String(newValue));
      return newValue;
    });
  }, [isMobile]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // ESC - close lightbox first, then expand sidebar if collapsed, otherwise close panel
      if (e.key === 'Escape') {
        if (lightboxImage) {
          setLightboxImage(null);
          return;
        }
        if (isSidebarCollapsed) {
          toggleSidebar();
        } else {
          onClose();
        }
        return;
      }

      // Ctrl+S - open message search (works while typing; stops the browser's Save Page dialog)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (showSearch) {
          const input = document.querySelector<HTMLInputElement>('input[placeholder="Search messages..."]');
          input?.focus();
          input?.select();
        } else {
          setShowSearch(true);
        }
        return;
      }

      // Don't process other shortcuts while typing
      if (isTyping) return;

      // Ctrl+N - create new channel
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        setShowCreateChannel(true);
        return;
      }

      // Arrow Up/Down - navigate channels
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (channels.length === 0) return;
        e.preventDefault();

        const currentIndex = activeChannel
          ? channels.findIndex(c => c.id === activeChannel.id)
          : -1;

        let newIndex: number;
        if (e.key === 'ArrowUp') {
          newIndex = currentIndex <= 0 ? channels.length - 1 : currentIndex - 1;
        } else {
          newIndex = currentIndex >= channels.length - 1 ? 0 : currentIndex + 1;
        }

        setActiveChannel(channels[newIndex]);
        return;
      }

      // S - toggle sidebar
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        toggleSidebar();
        return;
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, isSidebarCollapsed, onClose, toggleSidebar, channels, activeChannel, lightboxImage, showSearch]);

  // Create channel
  const handleCreateChannel = async () => {
    if (!newChannelName.trim()) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          name: newChannelName.trim(),
          ownerId: BROWSER_PARTICIPANT_ID, // Track channel ownership
          projectId: newChannelProjectId || undefined,
          category: activeChannel ? getChannelGroupId(activeChannel, channelGroups) : homeGroupId(channelGroups),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.channel) {
          setChannels(prev => [...prev, data.channel]);
          setActiveChannel(data.channel);
          await fetchProjects();
          setNewChannelName('');
          setNewChannelProjectId('');
          setShowCreateChannel(false);
        }
      }
    } catch (error) {
      logCollabError('create channel', error, { name: newChannelName });
    }
  };

  // Create a new project directory and register it
  const handleCreateNewProject = async () => {
    if (!newProjectName.trim()) return;
    setNewProjectSaving(true);
    setNewProjectError(null);

    const slug = newProjectName.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
    const projectPath = newProjectPath.trim() || `${getHomeDir()}/${slug}`;

    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newProjectName.trim(),
          path: projectPath,
          category: 'tool',
          createDirectory: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setNewProjectError(data.error || 'Failed to create project');
        return;
      }

      // Refresh projects and select the new one
      await fetchProjects();
      setNewChannelProjectId(data.project?.id || '');
      setIsCreatingProject(false);
      setNewProjectName('');
      setNewProjectPath('');
    } catch {
      setNewProjectError('Failed to create project');
    } finally {
      setNewProjectSaving(false);
    }
  };

  // Save channel settings (rename/description)
  const handleSaveChannelSettings = async () => {
    if (!activeChannel || channelSettingsSaving) return;
    setChannelSettingsError(null);
    setChannelSettingsSaving(true);
    try {
      // Name + project path are one server-side operation. Sending them as two
      // parallel writes allowed the stale settings response to restore the old
      // directory after a channel rename.
      const renameRes = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'rename',
          channelId: activeChannel.id,
          name: editChannelName.trim() || undefined,
          description: editChannelDescription,
          projectPath: editChannelProjectPath.trim() || undefined,
        }),
      });
      if (renameRes.ok) {
        const data = await renameRes.json();
        if (data.channel) {
          setChannels(prev => prev.map(c => c.id === data.channel.id ? data.channel : c));
          setActiveChannel(data.channel);
        }
        setShowChannelSettings(false);
      } else {
        const data = await renameRes.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save channel settings');
      }
    } catch (error) {
      console.error('Failed to save channel settings:', error);
      setChannelSettingsError(error instanceof Error ? error.message : 'Failed to save channel settings');
    } finally {
      setChannelSettingsSaving(false);
    }
  };

  // Open channel settings
  const openChannelSettings = () => {
    if (activeChannel) {
      setEditChannelName(activeChannel.name);
      setEditChannelDescription(activeChannel.description || '');
      setEditChannelProjectPath(activeChannel.projectPath || '');
      setChannelSettingsError(null);
      setShowChannelSettings(true);
    }
  };

  // Delete channel (browser user can always delete). The dialog also asks whether to keep or delete
  // the channel's project folder (owner, 6 Oct 2026).
  const [pendingDelete, setPendingDelete] = useState<{ channelId: string; name: string; mode: 'archive' | 'permanent'; archiveId?: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const handleDeleteChannel = async (channelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const name = channels.find(c => c.id === channelId)?.name || 'this channel';
    setDeleteError('');
    setPendingDelete({ channelId, name, mode: 'archive' });
  };

  /** Remove the channel's project folder. Returns an error message, or '' on success. */
  const deleteChannelFolder = async (channelId: string, discardUnsavedGit: boolean): Promise<string> => {
    const res = await fetch('/api/collab/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', channelId, ...(discardUnsavedGit ? { discardUnsavedGit: true } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.success ? '' : (data.error || 'The folder could not be deleted.');
  };

  const confirmPendingDelete = async (deleteFolder: boolean, discardUnsavedGit = false) => {
    if (!pendingDelete) return;
    const { channelId, mode, archiveId } = pendingDelete;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      if (mode === 'archive') {
        // Agents must stop before their folder goes; archive first so the channel is gone either way.
        if (deleteFolder) {
          await fetch('/api/collab/pty', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'roster_kill_all', channelId }),
          }).catch(() => undefined);
        }
        const res = await fetch('/api/collab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', channelId, participantId: BROWSER_PARTICIPANT_ID }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setDeleteError(data.error || 'The channel could not be archived.');
          return;
        }
        setChannels(prev => prev.filter(c => c.id !== channelId));
        if (channelId === activeChannel?.id) setActiveChannel(null);
      }
      const folderError = deleteFolder ? await deleteChannelFolder(channelId, discardUnsavedGit) : '';
      if (mode === 'permanent' && archiveId) {
        if (folderError) {
          setDeleteError(`Folder kept: ${folderError} The channel was not deleted.`);
          return;
        }
        const res = await fetch('/api/collab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'permanently_delete', archiveId, participantId: BROWSER_PARTICIPANT_ID }),
        });
        if (res.ok) setArchivedChannels(prev => prev.filter(c => c.id !== archiveId));
      }
      if (folderError) {
        setDeleteError(`Channel ${mode === 'archive' ? 'archived' : 'deleted'}, but the folder was kept: ${folderError}`);
        return;
      }
      setPendingDelete(null);
    } catch (error) {
      logCollabError('delete channel', error);
      setDeleteError('Something went wrong. Check the channel list and try again.');
    } finally {
      setDeleteBusy(false);
    }
  };

  // Fetch archived channels
  const fetchArchivedChannels = async () => {
    setLoadingArchived(true);
    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_archived', participantId: BROWSER_PARTICIPANT_ID }),
      });
      if (res.ok) {
        const data = await res.json();
        setArchivedChannels(data.archives || []);
      }
    } catch (error) {
      logCollabError('fetch archived channels', error);
    } finally {
      setLoadingArchived(false);
    }
  };

  // Restore an archived channel
  const handleRestoreChannel = async (archiveId: string) => {
    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', archiveId, participantId: BROWSER_PARTICIPANT_ID }),
      });
      if (res.ok) {
        setArchivedChannels(prev => prev.filter(c => c.id !== archiveId));
        fetchArchivedChannels();
        fetchData(); // Re-fetch live channels to include restored one
      }
    } catch (error) {
      logCollabError('restore channel', error);
    }
  };

  // Permanently delete from archive
  const handlePermanentlyDeleteChannel = async (archiveId: string) => {
    // list_archived returns summaries: id is the archive entry, channelId the channel.
    const entry = archivedChannels.find(c => c.id === archiveId) as unknown as { channelId?: string; name?: string } | undefined;
    if (!entry?.channelId) return;
    setDeleteError('');
    setPendingDelete({ channelId: entry.channelId, name: entry.name || 'this channel', mode: 'permanent', archiveId });
  };

  // Toggle archived section visibility
  const handleToggleArchived = () => {
    const next = !archivedExpanded;
    setArchivedExpanded(next);
    if (next) fetchArchivedChannels();
  };

  // Remove participant (kick)
  const handleRemoveParticipant = async (pId: string) => {
    if (!activeChannel) return;

    // Find the participant before removing so we can track them
    const participant = activeChannel.participants.find(p => p.id === pId);

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'leave',
          channelId: activeChannel.id,
          participantId: pId,
          block: true,
        }),
      });

      if (res.ok) {
        // Track kicked participant for re-invite option (only agents, not users)
        if (participant && participant.type !== 'user') {
          setKickedParticipants(prev => {
            // Avoid duplicates
            if (prev.some(p => p.id === participant.id)) return prev;
            return [...prev, { ...participant, status: 'offline' }];
          });
        }

        setActiveChannel(prev =>
          prev ? {
            ...prev,
            participants: prev.participants.filter(p => p.id !== pId)
          } : null
        );
      }
    } catch (error) {
      console.error('Failed to remove participant:', error);
    }
  };

  // Recall an agent from another channel back to this one
  const handleRecallAgent = async (pId: string) => {
    if (!activeChannel) return;

    const participant = activeChannel.participants.find(p => p.id === pId);
    if (!participant) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'recall',
          channelId: activeChannel.id,
          participantId: pId,
        }),
      });

      if (res.ok) {
        // Update participant status locally (will be refreshed on next poll)
        setActiveChannel(prev =>
          prev ? {
            ...prev,
            participants: prev.participants.map(p =>
              p.id === pId
                ? { ...p, status: undefined, awayInChannelId: undefined, awayInChannelName: undefined }
                : p
            )
          } : null
        );
      } else {
        const errData = await res.json();
        console.error('Failed to recall agent:', errData.error);
      }
    } catch (error) {
      console.error('Failed to recall agent:', error);
    }
  };

  // Make a participant the Team Lead (agents only)
  const handleMakeTeamLead = async (pId: string) => {
    if (!activeChannel) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_settings',
          channelId: activeChannel.id,
          teamLeadId: pId,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.channel) {
          setActiveChannel(data.channel);
          setChannels(prev => prev.map(c => c.id === data.channel.id ? data.channel : c));

          // Send announcement so all agents know about the Team Lead change
          const newLead = data.channel.participants?.find((p: CollabParticipant) => p.id === pId);
          const leadName = newLead?.name || 'Unknown';
          toast.success(`${leadName} is now Team Lead`);
          try {
            await fetch('/api/collab', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'message',
                channelId: activeChannel.id,
                participantId: participantId,
                content: `[System] Team Lead has been changed to **${leadName}**. ${leadName} is now responsible for coordinating the team, managing sprints, and assigning tasks.`,
              }),
            });
          } catch { /* announcement is best-effort */ }
        } else {
          toast.error('Team Lead changed, but the updated channel was not returned');
        }
      } else {
        const error = await res.json();
        console.error('Failed to set Team Lead:', error.error);
        toast.error(error.error || 'Failed to set Team Lead');
      }
    } catch (error) {
      console.error('Failed to set Team Lead:', error);
      toast.error('Failed to set Team Lead');
    }
  };

  // Account display names never change the routing name agents mention.
  const handleRenameMyself = async (newName: string) => {
    try { await saveAccount({ profile: { displayName: newName } }); await fetchData(); setEditingMyName(false); setMyNewName(''); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Could not save your name.'); }
  };

  // Rename any participant (for Gemini agents etc)
  const handleRenameParticipant = async (pId: string, newName: string) => {
    if (!activeChannel || !newName.trim()) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'rename_participant',
          channelId: activeChannel.id,
          participantId: pId,
          name: newName.trim(),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.channel) {
          setActiveChannel(data.channel);
          setChannels(prev => prev.map(c => c.id === data.channel.id ? data.channel : c));
        }
        setRenamingParticipantId(null);
        setRenameValue('');
      }
    } catch (error) {
      console.error('Failed to rename participant:', error);
    }
  };

  // Re-invite a kicked participant
  const handleReinviteParticipant = async (participant: CollabParticipant) => {
    if (!activeChannel) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'join',
          channelId: activeChannel.id,
          force: true, // Bypass block list - explicit re-invite from UI
          participant: {
            id: participant.id,
            type: participant.type,
            name: participant.name,
            source: participant.source,
            pid: participant.pid,
            projectPath: participant.projectPath,
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success && data.channel) {
          setActiveChannel(data.channel);
        }
        // Remove from kicked list
        setKickedParticipants(prev => prev.filter(p => p.id !== participant.id));

        // If session is collab-ready, send invite notification
        if (participant.pid) {
          try {
            await fetch('/api/claude/sessions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'invite_to_channel',
                pid: participant.pid,
                channelId: activeChannel.id,
                channelName: activeChannel.name,
              }),
            });
          } catch (inviteErr) {
            console.warn('Could not notify wrapper:', inviteErr);
          }
        }
      }
    } catch (error) {
      console.error('Failed to re-invite participant:', error);
    }
  };

  // Detach agent to external terminal
  const handleDetachAgent = async (participant: CollabParticipant) => {
    if (!activeChannel) return;

    try {
      const res = await fetch('/api/claude/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'detach_pty',
          channelId: activeChannel.id,
          participantId: participant.id,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        // Show success message or notification
        console.log('Agent detached to terminal:', data.terminalCommand);
        // Could open a modal with the command to run
      }
    } catch (error) {
      console.error('Failed to detach agent:', error);
    }
  };

  // Doc panel — open PROJECT.md for the channel's working directory
  const handleOpenDocPanel = useCallback(async () => {
    if (!activeChannel) return;
    setShowDocPanel(true);
    setDocPanelLoading(true);
    try {
      const res = await fetch(`/api/collab/project-doc?channelId=${activeChannel.id}`);
      const data = await res.json();
      setDocPanelProjectPath(data.projectPath ?? null);
      setDocPanelContent(data.content ?? null);
      setDocPanelExists(data.exists ?? false);
      setDocPanelNotice(data.message ?? null);
    } catch {
      setDocPanelContent(null);
      setDocPanelExists(false);
      setDocPanelNotice(null);
    } finally {
      setDocPanelLoading(false);
    }
  }, [activeChannel]);

  const handleSaveDocPath = useCallback(async (pathInput: string) => {
    if (!activeChannel || !pathInput.trim()) return;
    try {
      const res = await fetch('/api/collab/project-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: activeChannel.id, projectPath: pathInput.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setDocPanelLoading(true);
        const res2 = await fetch(`/api/collab/project-doc?channelId=${activeChannel.id}`);
        const data2 = await res2.json();
        setDocPanelProjectPath(data2.projectPath ?? null);
        setDocPanelContent(data2.content ?? null);
        setDocPanelExists(data2.exists ?? false);
        setDocPanelNotice(data2.message ?? null);
      } else {
        throw new Error(data.error ?? 'Failed to save path');
      }
    } finally {
      setDocPanelLoading(false);
    }
  }, [activeChannel]);


  // Agent color presets (matches collab-utils.ts)
  const AGENT_COLORS = [
    '#8B5CF6', '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
    '#EC4899', '#6366F1', '#14B8A6', '#F97316', '#84CC16',
  ];

  // Teams: Save (create or update)
  const handleSaveTeam = async () => {
    if (!teamFormName.trim()) return;
    try {
      if (editingTeam) {
        // Update team metadata
        await fetch('/api/teams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update',
            teamId: editingTeam.id,
            name: teamFormName.trim(),
            description: teamFormDescription.trim() || undefined,
            projectId: teamFormProjectId || undefined,
          }),
        });

        // Sync agents: remove deleted, update existing, add new
        const existingIds = new Set(editingTeam.agents.map(a => a.id));
        const formIds = new Set(teamFormAgents.filter(a => a.id).map(a => a.id));

        // Remove agents no longer in form
        for (const agent of editingTeam.agents) {
          if (!formIds.has(agent.id)) {
            await fetch('/api/teams', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'remove_agent', teamId: editingTeam.id, agentId: agent.id }),
            });
          }
        }

        // Update existing + add new
        for (const agent of teamFormAgents) {
          if (agent.id && existingIds.has(agent.id)) {
            await fetch('/api/teams', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'update_agent',
                teamId: editingTeam.id,
                agentId: agent.id,
                name: agent.name,
                workingDirectory: agent.workingDirectory,
                color: agent.color,
                autoResume: agent.autoResume,
                useCollabWrapper: agent.useCollabWrapper,
                dangerouslySkipPermissions: agent.dangerouslySkipPermissions,
              }),
            });
          } else {
            await fetch('/api/teams', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'add_agent',
                teamId: editingTeam.id,
                name: agent.name,
                workingDirectory: agent.workingDirectory,
                color: agent.color,
                autoResume: agent.autoResume,
                useCollabWrapper: agent.useCollabWrapper,
                dangerouslySkipPermissions: agent.dangerouslySkipPermissions,
              }),
            });
          }
        }
      } else {
        // Create team
        const createRes = await fetch('/api/teams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            name: teamFormName.trim(),
            description: teamFormDescription.trim() || undefined,
            projectId: teamFormProjectId || undefined,
          }),
        });
        const createData = await createRes.json();

        if (createData.success && createData.data?.team) {
          const teamId = createData.data.team.id;
          // Add agents
          for (const agent of teamFormAgents) {
            await fetch('/api/teams', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'add_agent',
                teamId,
                name: agent.name,
                workingDirectory: agent.workingDirectory,
                color: agent.color,
                autoResume: agent.autoResume,
                useCollabWrapper: agent.useCollabWrapper,
                dangerouslySkipPermissions: agent.dangerouslySkipPermissions,
              }),
            });
          }
        }
      }
    } catch (error) {
      console.error('Failed to save team:', error);
    }

    setShowCreateTeam(false);
    setEditingTeam(null);
    fetchTeams();
  };

  // Teams: Delete
  const handleDeleteTeam = async (teamId: string) => {
    try {
      await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', teamId }),
      });
      setDeletingTeamId(null);
      fetchTeams();
    } catch (error) {
      console.error('Failed to delete team:', error);
    }
  };

  // Teams: Launch
  const handleLaunchTeam = async () => {
    if (!launchingTeam) return;
    setLaunchInProgress(true);

    try {
      const payload: Record<string, unknown> = {
        action: 'launch',
        teamId: launchingTeam.id,
      };
      if (launchMode === 'new' && launchChannelName.trim()) {
        payload.channelName = launchChannelName.trim();
      }
      if (launchMode === 'existing' && launchChannelId) {
        payload.channelId = launchChannelId;
      }

      const res = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (data.success && data.data?.channelId) {
        // Refresh channels and switch to the new channel
        setLaunchingTeam(null);
        await fetchData();
        await fetchTeams();

        // Find and switch to the created/used channel
        const res2 = await fetch(`/api/collab?participantId=${encodeURIComponent(BROWSER_PARTICIPANT_ID)}`);
        if (res2.ok) {
          const channelsData = await res2.json();
          const launchedChannel = (channelsData.channels || []).find((c: CollabChannel) => c.id === data.data.channelId);
          if (launchedChannel) {
            setActiveChannel(launchedChannel);
            setActiveView('chat');
          }
        }
      }
    } catch (error) {
      console.error('Failed to launch team:', error);
    } finally {
      setLaunchInProgress(false);
    }
  };

  // Teams: Open create form
  const openCreateTeamForm = () => {
    setEditingTeam(null);
    setTeamFormName('');
    setTeamFormDescription('');
    setTeamFormProjectId('');
    setTeamFormAgents([]);
    setShowCreateTeam(true);
  };

  // Teams: Open edit form
  const openEditTeamForm = (team: Team) => {
    setEditingTeam(team);
    setTeamFormName(team.name);
    setTeamFormDescription(team.description || '');
    setTeamFormProjectId(team.projectId || '');
    setTeamFormAgents(team.agents.map(a => ({
      id: a.id,
      name: a.name,
      workingDirectory: a.workingDirectory,
      color: a.color,
      autoResume: a.autoResume,
      useCollabWrapper: a.useCollabWrapper,
      dangerouslySkipPermissions: a.dangerouslySkipPermissions,
    })));
    setShowCreateTeam(true);
  };

  // Teams: Open launch modal
  const openLaunchModal = (team: Team) => {
    setLaunchingTeam(team);
    setLaunchMode('new');
    setLaunchChannelName('');
    setLaunchChannelId('');
  };


  // Roster: Kill agent
  const handleRosterKill = async (agentId: string) => {
    if (!activeChannel) return;
    try {
      // Optimistic: show stopped immediately
      setActiveChannel(prev => {
        if (!prev?.roster?.agents) return prev;
        return {
          ...prev,
          roster: {
            ...prev.roster,
            agents: prev.roster.agents.map(a => a.id === agentId ? { ...a, status: 'stopped' as const } : a),
          },
        };
      });
      await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'roster_kill',
          channelId: activeChannel.id,
          agentId,
        }),
      });
      fetchData();
    } catch (error) {
      console.error('Failed to kill agent:', error);
      fetchData(); // Revert optimistic update
    }
  };

  // Roster: Respawn agent (with debounce guard to prevent multiple spawns)
  const [respawningAgentId, setRespawningAgentId] = useState<string | null>(null);
  const handleRosterRespawn = async (agentId: string, fresh = true, rehydrate = false) => {
    if (!activeChannel) return;
    if (respawningAgentId === agentId) return; // Prevent double-click / multiple calls
    setRespawningAgentId(agentId);
    try {
      // Optimistic: show starting immediately
      setActiveChannel(prev => {
        if (!prev?.roster?.agents) return prev;
        return {
          ...prev,
          roster: {
            ...prev.roster,
            agents: prev.roster.agents.map(a => a.id === agentId ? { ...a, status: 'starting' as const } : a),
          },
        };
      });
      await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'roster_respawn',
          channelId: activeChannel.id,
          agentId,
          fresh,
          ...(rehydrate ? { rehydrate: true } : {}),
        }),
      });
      setTimeout(() => fetchData(), 2000);
    } catch (error) {
      console.error('Failed to respawn agent:', error);
      fetchData(); // Revert optimistic update
    } finally {
      // Clear guard after a delay to allow the spawn to register
      setTimeout(() => setRespawningAgentId(null), 5000);
    }
  };

  // Roster: Open terminal
  const handleRosterOpenTerminal = async (agentId: string) => {
    if (!activeChannel) return;
    await requestRosterTerminal(fetch, activeChannel.id, agentId, toast.error);
  };

  // Roster: ask the agent's harness to compact its context (/compact, /compress for Gemini)
  const handleRosterCompact = async (agentId: string) => {
    if (!activeChannel) return;
    const agentName = activeChannel.roster?.agents.find(a => a.id === agentId)?.name || 'agent';
    try {
      const res = await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'roster_compact', channelId: activeChannel.id, agentId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) toast.success(`${data.command || 'Compact'} sent to ${agentName}`);
      else toast.error(data.error || `Could not compact ${agentName}`);
    } catch {
      toast.error('Network error: compact request failed');
    }
  };

  // Roster: Remove agent from roster
  const handleRosterRemove = async (agentId: string) => {
    if (!activeChannel) return;
    try {
      const res = await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'roster_remove',
          channelId: activeChannel.id,
          agentId,
        }),
      });
      if (res.ok) {
        // Optimistic update: remove from local state immediately
        setActiveChannel(prev => {
          if (!prev?.roster?.agents) return prev;
          return {
            ...prev,
            roster: {
              ...prev.roster,
              agents: prev.roster.agents.filter(a => a.id !== agentId),
            },
          };
        });
      }
      fetchData();
    } catch (error) {
      console.error('Failed to remove agent from roster:', error);
    }
  };

  // Get roster agent for a participant
  const getRosterAgent = (participantId: string): AgentRosterEntry | undefined => {
    const roster = activeChannel?.roster?.agents;
    if (!roster) return undefined;
    // Primary: match by participantId
    const byId = roster.find(a => a.participantId === participantId);
    if (byId) return byId;
    // Fallback: match by participant name (handles cases where roster participantId
    // is a placeholder like "roster-xxx" but the actual participant joined with a new UUID)
    const participant = activeChannel?.participants?.find(p => p.id === participantId);
    if (participant) {
      return roster.find(a => a.name === participant.name);
    }
    return undefined;
  };


  // Discuss task - post task reference to channel and switch to chat.
  // Cascade @mention: assignee → Team Lead → any non-user agent. Never broadcast.
  const handleDiscussTask = async (task: CollabTask) => {
    if (!activeChannel || !participantId) return;

    const assigneeName = task.assigneeId
      ? (activeChannel.participants || []).find(p => p.id === task.assigneeId)?.name || 'Unknown'
      : 'Unassigned';

    const statusLabel = task.status === 'todo' ? 'To Do'
      : task.status === 'in_progress' ? 'In Progress'
      : 'Done';

    // Resolve mention target: assignee first, then Team Lead, then any non-user agent
    let mention = '';
    if (task.assigneeId && assigneeName !== 'Unknown') {
      mention = `@${assigneeName} `;
    } else if (activeChannel.teamLeadId) {
      const teamLead = (activeChannel.participants || []).find(p => p.id === activeChannel.teamLeadId);
      if (teamLead) mention = `@${teamLead.name} `;
    }
    if (!mention) {
      const anyAgent = (activeChannel.participants || []).find(p => p.type !== 'user');
      if (anyAgent) mention = `@${anyAgent.name} `;
    }

    const content = [
      `${mention}**Task Discussion:** ${task.title}`,
      task.description ? `> ${task.description}` : '',
      `Status: ${statusLabel} | Priority: ${task.priority} | Assigned: ${assigneeName}`,
    ].filter(Boolean).join('\n');

    try {
      await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'message',
          channelId: activeChannel.id,
          participantId,
          content,
        }),
      });

      // Switch to chat view and focus input
      setActiveView('chat');
      setTimeout(() => inputRef.current?.focus(), 100);
    } catch (err) {
      console.error('Failed to post task discussion:', err);
    }
  };

  // Extract @mention names from message text with smart detection:
  // - Only matches @ at start of text or after whitespace (not inside emails like user@example.com)
  // - Supports @Name and @"Name With Spaces"
  // - Ignores bare @ with no name
  // - Skips @-signs inside code blocks (``` ``` or ` `) to avoid false-positives on npm packages
  const extractMentionNames = (text: string): string[] => {
    // Strip fenced code blocks (```...```) and inline code (`...`) before parsing
    const stripped = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '');
    const names: string[] = [];
    const pattern = /(?:^|(?<=\s))@(?:"([^"]+)"|([A-Za-z][\w'-]*))/g;
    let match;
    while ((match = pattern.exec(stripped)) !== null) {
      const name = (match[1] || match[2]).replace(/[.,!?;:)\]]+$/, '');
      if (name) names.push(name);
    }
    return names;
  };

  // Validate mentions against channel participants, returns invalid names or empty array
  const validateMentions = (text: string): string[] => {
    if (!activeChannel) return [];
    const mentionNames = extractMentionNames(text);
    const participants = activeChannel.participants || [];
    return mentionNames.filter(name =>
      !participants.some(p => p.name.toLowerCase() === name.toLowerCase())
    );
  };

  // Spellcheck function — auto-corrects to best match, skips /commands and @mentions
  const runSpellcheck = async (text: string) => {
    if (!text.trim() || text.trim().split(/\s+/).length < 2) {
      setSpellcheckResults([]);
      return;
    }
    try {
      const res = await fetch('/api/spellcheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const data = await res.json();
        const incorrect = (data.results || []).filter((r: { word: string; isCorrect: boolean; suggestions: string[] }) => !r.isCorrect && r.suggestions?.length > 0);
        if (incorrect.length > 0) {
          // Auto-apply best correction inline; skip if user has typed more since the API call
          setInputValue(current => {
            if (current !== text) return current;
            let corrected = current;
            for (const result of incorrect) {
              if (result.suggestions.length > 0) {
                corrected = corrected.replace(new RegExp(`\\b${result.word}\\b`, 'gi'), result.suggestions[0]);
              }
            }
            return corrected;
          });
        }
        setSpellcheckResults([]);
      }
    } catch { /* silently ignore */ }
  };

  // Direct send for voice mode — bypasses the inputValue state/closure timing issue.
  // Skips mention validation + broadcast confirmation (voice msgs are always targeted).
  const sendVoiceMessage = useCallback(async (text: string) => {
    if (!text.trim() || !activeChannel) return;
    let pid = participantId;
    if (!pid) {
      pid = await rejoinChannel(activeChannel.id);
      if (!pid) return;
    }
    const content = text.trim();
    const ts = new Date().toISOString();
    const sender = activeChannel.participants?.find(p => p.id === pid) || {
      id: pid!, type: 'user' as const, name: 'You', source: 'Browser', joinedAt: ts, lastSeen: ts,
    };
    const optId = `voice-${Date.now()}`;
    setMessages(prev => [...prev, {
      id: optId, channelId: activeChannel.id, from: sender,
      content, timestamp: ts,
      metadata: { deliveryMode: 'broadcast' as const },
    } as CollabMessage]);
    fetch('/api/collab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'message', channelId: activeChannel.id, participantId: pid, content }),
    }).catch(err => console.error('[voice-send]', err));
  }, [activeChannel, participantId, rejoinChannel, setMessages]);

  // Send message
  const handleSend = async () => {
    if (pendingAttachmentReads > 0) {
      toast.warning('Wait for the attachment to finish loading');
      return;
    }
    const rawContent = inputValue.trim();
    const nonAttachmentContent = stripAttachmentReferences(rawContent).trim();
    if ((!rawContent && pendingImages.length === 0) || !activeChannel) return;

    const claudeDesignCommand = parseClaudeDesignAgentChatCommand(rawContent);
    if (claudeDesignCommand) {
      if (pendingImages.length > 0) {
        toast.warning('Claude Design commands cannot include attachments');
        return;
      }

      const cwd = claudeDesignCommand.action === 'sync'
        ? claudeDesignCommand.path || activeChannelProjectDirectory
        : activeChannelProjectDirectory || getDevflowHome();
      if (!cwd) {
        toast.error('Link this channel to a project or supply /design-sync /absolute/path');
        return;
      }

      try {
        const response = await fetch('/api/claude-design', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: claudeDesignCommand.action, cwd }),
        });
        const result = await response.json().catch(() => null) as {
          success?: boolean;
          message?: string;
          error?: string;
        } | null;
        if (!response.ok || !result?.success) {
          throw new Error(result?.error || `Claude Design launch failed (${response.status})`);
        }

        setInputValue('');
        setSlashSuggestions([]);
        localStorage.removeItem(`devflow-draft-${activeChannel.id}`);
        broadcastTypingStatus('idle');
        toast.success(result.message || 'Claude Design opened');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Claude Design launch failed');
      }
      return;
    }

    // Auto-rejoin if session expired (participantId lost from React state)
    let sendAsId = participantId;
    if (!sendAsId) {
      // Try localStorage fallback first
      sendAsId = localStorage.getItem('devflow-collab-participantId');
      if (sendAsId) setParticipantId(sendAsId);

      // Rejoin to ensure the session is valid server-side
      const rejoinedId = await rejoinChannel(activeChannel.id);
      if (rejoinedId) {
        sendAsId = rejoinedId;
      } else if (!sendAsId) {
        // Both localStorage and rejoin failed — can't send
        logCollabError('send message', new Error('Session expired and rejoin failed'), { channelId: activeChannel.id });
        return;
      }
    }

    setSpellcheckResults([]);

    // Validate @mentions - block if any mention doesn't match a channel participant
    if (nonAttachmentContent) {
      const bypass = skipMentionValidationRef.current;
      skipMentionValidationRef.current = false;
      const invalid = bypass ? [] : validateMentions(rawContent);
      if (invalid.length > 0) {
        setInvalidMentions(invalid);
        setBroadcastConfirmPending(false);
        return;
      }
      setInvalidMentions([]);

      // Check for broadcast (no @mentions) - require confirmation
      // Skip confirmation if replying to a specific message (reply context implies recipient)
      // Skip confirmation on mobile (warning would push input off-screen)
      const mentionNames = extractMentionNames(rawContent);
      if (mentionNames.length === 0 && !broadcastConfirmPending && !replyingTo && !isMobile) {
        setBroadcastConfirmPending(true);
        return;
      }
      setBroadcastConfirmPending(false);
    }

    // Convert emoji shortcodes like :smile: to actual emojis. The old
    // send-time "Structure prompt" transform (T3.1) is superseded by the
    // pre-send DeepSeek enhancement in ColabInput — the draft is already
    // final by the time it reaches handleSend.
    const content = convertEmojiShortcodes(rawContent);

    const imagesToSend = pendingImages.length > 0 ? pendingImages : undefined;
    const capturedReplyTo = replyingTo;
    const replyToId = replyingTo?.id;
    const capturedCrossChannelTarget = crossChannelTarget;
    setCrossChannelTarget(null);
    setInputValue('');
    setCodeSuggestion(null);
    // Clear draft from localStorage when message is sent
    if (activeChannel?.id) {
      localStorage.removeItem(`devflow-draft-${activeChannel.id}`);
    }
    // The attachments leave with this channel's draft; drafts in other channels keep theirs.
    if (activeChannel?.id) draftAttachments.clear(activeChannel.id);
    setReplyingTo(null);
    setEmojiSuggestions([]);
    setSlashSuggestions([]);
    // Clear typing status when message is sent
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    broadcastTypingStatus('idle');

    // Optimistic update — show message instantly before server confirms
    const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const senderParticipant = activeChannel.participants.find(p => p.id === sendAsId) || {
      id: sendAsId!,
      type: 'user' as const,
      name: 'You',
      source: 'Browser',
      joinedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    const optimisticMessage: CollabMessage = {
      id: optimisticId,
      channelId: activeChannel.id,
      from: senderParticipant,
      content: content || (imagesToSend ? `[${imagesToSend.length} file${imagesToSend.length > 1 ? 's' : ''}]` : ''),
      timestamp: new Date().toISOString(),
      images: imagesToSend,
      replyTo: capturedReplyTo ? {
        id: capturedReplyTo.id,
        from: capturedReplyTo.from,
        content: capturedReplyTo.content?.slice(0, 150),
      } : undefined,
      metadata: {
        deliveryMode: extractMentionNames(content).length > 0 ? 'targeted' : 'broadcast',
        _optimistic: true,
      },
    };
    setMessages(prev => [...prev, optimisticMessage]);

    try {
      // route-audit: captures visible channel name vs state id to diagnose cross-channel routing bug
      const _routeAudit = {
        ts: new Date().toISOString(),
        visibleChannelName: activeChannel?.name,
        activeChannelId: activeChannel?.id,
        sendAsId,
        contentPreview: (content || '').slice(0, 60),
      };
      console.log('[route-audit] send', _routeAudit);
      fetch('/api/logs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'tools', severity: 'info', title: 'route-audit', metadata: { tag: 'route-audit', ..._routeAudit } })
      }).catch(() => {});

      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'message',
          channelId: activeChannel.id,
          participantId: sendAsId,
          ...(capturedCrossChannelTarget && { crossChannelTarget: { channelId: capturedCrossChannelTarget.channelId, participantId: capturedCrossChannelTarget.participantId } }),
          content: content || (imagesToSend ? `[${imagesToSend.length} file${imagesToSend.length > 1 ? 's' : ''}]` : ''),
          images: imagesToSend,
          replyTo: replyToId,
        }),
      });

      if (!res.ok) {
        // If send failed with 404 (participant not found), try rejoin + retry once
        if (res.status === 404) {
          const rejoinedId = await rejoinChannel(activeChannel.id);
          if (rejoinedId) {
            const retryRes = await fetch('/api/collab', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'message',
                channelId: activeChannel.id,
                participantId: rejoinedId,
                ...(capturedCrossChannelTarget && { crossChannelTarget: { channelId: capturedCrossChannelTarget.channelId, participantId: capturedCrossChannelTarget.participantId } }),
                content: content || (imagesToSend ? `[${imagesToSend.length} file${imagesToSend.length > 1 ? 's' : ''}]` : ''),
                images: imagesToSend,
                replyTo: replyToId,
              }),
            });
            if (retryRes.ok) {
              // Success after rejoin — fall through to reconcile + poll
            } else {
              setMessages(prev => prev.filter(m => m.id !== optimisticId));
              await logFailedResponse('send message (after rejoin)', retryRes);
              return;
            }
          }
        } else {
          setMessages(prev => prev.filter(m => m.id !== optimisticId));
          await logFailedResponse('send message', res);
        }
      } else {
        // Reconcile optimistic message: replace optimistic ID with server-assigned ID
        const responseData = await res.json().catch(() => null);
        if (responseData?.messageId) {
          setMessages(prev => prev.map(m =>
            m.id === optimisticId
              ? { ...m, id: responseData.messageId, metadata: { ...m.metadata, _optimistic: undefined } }
              : m
          ));
        }

        // Fix 2: Only force-poll if SSE is disconnected — SSE delivers the message within ~100ms
        if (!eventStream.isSSE) {
          const pollRes = await fetch(
            `/api/collab?channelId=${activeChannel.id}&since=${encodeURIComponent(lastPollTime.current || new Date().toISOString())}&slim=1`
          );
          if (pollRes.ok) {
            const data = await pollRes.json();
            if (data.messages && data.messages.length > 0) {
              const resolvedMsgs = resolveSlimMessages(data.messages, data.participants || []);
              setMessages(prev => {
                const updated = [...prev];
                for (const msg of resolvedMsgs) {
                  if (!updated.some(m => m.id === msg.id)) {
                    updated.push(msg);
                  }
                }
                return updated;
              });
            }
            lastPollTime.current = data.timestamp;
          }
        }
      }
    } catch (err) {
      // Remove optimistic message on failure
      setMessages(prev => prev.filter(m => m.id !== optimisticId));
      logCollabError('send message', err, { channelId: activeChannel?.id });
    }
  };

  // Toggle emoji reaction on a message
  const toggleReaction = async (messageId: string, emoji: string) => {
    if (!activeChannel || !participantId) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'react',
          channelId: activeChannel.id,
          messageId,
          participantId,
          emoji,
        }),
      });

      if (res.ok) {
        // Update local state optimistically
        setMessages(prev => prev.map(msg => {
          if (msg.id !== messageId) return msg;
          const reactions = msg.reactions ? { ...msg.reactions } : {};
          if (!reactions[emoji]) {
            reactions[emoji] = [participantId];
          } else if (reactions[emoji].includes(participantId)) {
            reactions[emoji] = reactions[emoji].filter(id => id !== participantId);
            if (reactions[emoji].length === 0) delete reactions[emoji];
          } else {
            reactions[emoji] = [...reactions[emoji], participantId];
          }
          return { ...msg, reactions };
        }));
      }
    } catch (err) {
      console.error('Failed to toggle reaction:', err);
    }
  };

  // Emoji shortcode map for autocomplete
  const EMOJI_MAP: Record<string, string> = {
    smile: '😄', grin: '😁', joy: '😂', rofl: '🤣', wink: '😉',
    heart: '❤️', heart_eyes: '😍', fire: '🔥', thumbsup: '👍', thumbsdown: '👎',
    clap: '👏', wave: '👋', pray: '🙏', muscle: '💪', ok_hand: '👌',
    thinking: '🤔', sob: '😭', angry: '😠', scream: '😱', eyes: '👀',
    rocket: '🚀', star: '⭐', sparkles: '✨', tada: '🎉', party: '🥳',
    check: '✅', x: '❌', warning: '⚠️', question: '❓', exclamation: '❗',
    bulb: '💡', gear: '⚙️', wrench: '🔧', hammer: '🔨', bug: '🐛',
    coffee: '☕', pizza: '🍕', beer: '🍺', cake: '🎂', cookie: '🍪',
    sun: '☀️', moon: '🌙', cloud: '☁️', rain: '🌧️', snow: '❄️',
    dog: '🐕', cat: '🐈', unicorn: '🦄', poop: '💩', ghost: '👻',
    skull: '💀', alien: '👽', robot: '🤖', zap: '⚡', boom: '💥',
    100: '💯', cool: '😎', nerd: '🤓', money: '💰', gem: '💎',
    lock: '🔒', key: '🔑', link: '🔗', memo: '📝', book: '📚',
    phone: '📱', laptop: '💻', desktop: '🖥️', keyboard: '⌨️', mouse: '🖱️',
  };

  // State for emoji autocomplete
  const [emojiSuggestions, setEmojiSuggestions] = useState<Array<{code: string, emoji: string}>>([]);
  const [emojiSelectedIndex, setEmojiSelectedIndex] = useState(0);

  // State for slash command autocomplete
  const [slashSuggestions, setSlashSuggestions] = useState<Array<{name: string, description: string, type: string, argumentHint?: string}>>([]);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [allSkills, setAllSkills] = useState<Array<{name: string, description: string, type: string, argumentHint?: string}>>(
    [...CLAUDE_DESIGN_AGENTCHAT_COMMANDS],
  );

  // State for message editing
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  // Toggle pin on a message
  const togglePin = async (messageId: string) => {
    if (!activeChannel || !participantId) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'pin',
          channelId: activeChannel.id,
          messageId,
          participantId,
        }),
      });

      if (res.ok) {
        // Update local state optimistically
        setMessages(prev => prev.map(msg => {
          if (msg.id !== messageId) return msg;
          if (msg.pinnedAt) {
            // Unpin
            const { pinnedAt, pinnedBy, ...rest } = msg;
            return rest as CollabMessage;
          } else {
            // Pin
            return {
              ...msg,
              pinnedAt: new Date().toISOString(),
              pinnedBy: participantId,
            };
          }
        }));
      }
    } catch (err) {
      console.error('Failed to toggle pin:', err);
    }
  };

  // Start editing a message
  const startEditing = (msg: CollabMessage) => {
    setEditingMessageId(msg.id);
    setEditContent(msg.content);
  };

  // Cancel editing
  const cancelEditing = () => {
    setEditingMessageId(null);
    setEditContent('');
  };

  // Save edited message
  const saveEdit = async (messageId: string) => {
    if (!activeChannel || !participantId || !editContent.trim()) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit',
          channelId: activeChannel.id,
          messageId,
          participantId,
          content: editContent.trim(),
        }),
      });

      if (res.ok) {
        // Update local state
        setMessages(prev => prev.map(msg =>
          msg.id === messageId
            ? { ...msg, content: editContent.trim(), editedAt: new Date().toISOString() }
            : msg
        ));
        cancelEditing();
      }
    } catch (err) {
      console.error('Failed to edit message:', err);
    }
  };

  // Delete a message (own messages only)
  const deleteMessage = async (messageId: string) => {
    if (!activeChannel || !participantId) return;

    // Confirm deletion
    if (!window.confirm('Delete this message? This cannot be undone.')) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete_message',
          channelId: activeChannel.id,
          messageId,
          participantId,
        }),
      });

      if (res.ok) {
        // Remove from local state
        setMessages(prev => prev.filter(msg => msg.id !== messageId));
      }
    } catch (err) {
      logCollabError('delete message', err, { channelId: activeChannel?.id });
    }
  };

  // Handle input change with emoji autocomplete detection and typing indicator
  // Fired by the WYSIWYG editor with serialized markdown (the canonical mirror).
  // The editor grows itself via CSS, so no manual auto-grow here.
  const handleEditorChange = (value: string) => {
    setInputValue(value);

    // Clear send validation states when user edits message
    setBroadcastConfirmPending(false);
    setInvalidMentions([]);

    // Broadcast typing status (debounced - clears after 2s of no typing)
    if (value.trim()) {
      broadcastTypingStatus('typing');
      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      // Set idle after 2 seconds of no typing
      typingTimeoutRef.current = setTimeout(() => {
        broadcastTypingStatus('idle');
      }, 2000);
    } else {
      // Input is empty, clear typing status
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      broadcastTypingStatus('idle');
    }

    // Detect @mention pattern
    const mentionMatch = value.match(/@([\w']*)$/);
    if (mentionMatch && activeChannel) {
      const query = mentionMatch[1].toLowerCase();
      const matches = activeChannel.participants
        .filter(p => p.name.toLowerCase().startsWith(query))
        .slice(0, 6);
      setMentionSuggestions(matches);
      setMentionSelectedIndex(0);
    } else {
      setMentionSuggestions([]);
    }

    // Detect emoji shortcode pattern :something
    const match = value.match(/:(\w{2,})$/);
    if (match) {
      const query = match[1].toLowerCase();
      const matches = Object.entries(EMOJI_MAP)
        .filter(([code]) => code.startsWith(query))
        .slice(0, 6)
        .map(([code, emoji]) => ({ code, emoji }));
      setEmojiSuggestions(matches);
      setEmojiSelectedIndex(0);
    } else {
      setEmojiSuggestions([]);
    }

    // Detect slash command pattern (/ at beginning of input or after newline)
    const slashMatch = value.match(/(?:^|\n)\/([\w-]*)$/);
    if (slashMatch && allSkills.length > 0) {
      const query = slashMatch[1].toLowerCase();
      const matches = allSkills
        .filter(s => s.name.toLowerCase().startsWith(query))
        .slice(0, 8);
      setSlashSuggestions(matches);
      setSlashSelectedIndex(0);
    } else {
      setSlashSuggestions([]);
    }

    // Spellcheck debounce
    if (spellcheckEnabled) {
      if (spellcheckDebounceRef.current) clearTimeout(spellcheckDebounceRef.current);
      spellcheckDebounceRef.current = setTimeout(() => runSpellcheck(value), 600);
    }
  };

  // Insert selected mention
  const insertMention = (name: string) => {
    const newValue = inputValue.replace(/@[\w']*$/, `@${name} `);
    setInputValue(newValue);
    setMentionSuggestions([]);
    inputRef.current?.focus();
  };

  // Insert selected emoji
  const insertEmoji = (code: string, emoji: string) => {
    const newValue = inputValue.replace(new RegExp(`:${code}$`, 'i'), emoji);
    setInputValue(newValue);
    setEmojiSuggestions([]);
    inputRef.current?.focus();
  };

  // Insert selected slash command
  const insertSlashCommand = (name: string) => {
    const newValue = inputValue.replace(/(?:^|\n)\/([\w-]*)$/, (match) => {
      const prefix = match.startsWith('\n') ? '\n' : '';
      return `${prefix}/${name} `;
    });
    setInputValue(newValue);
    setSlashSuggestions([]);
    inputRef.current?.focus();
  };

  // Convert all emoji shortcodes in text before sending
  const convertEmojiShortcodes = (text: string): string => {
    return text.replace(/:(\w+):/g, (match, code) => {
      return EMOJI_MAP[code.toLowerCase()] || match;
    });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    // Handle @mention autocomplete navigation
    if (mentionSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionSelectedIndex(i => (i + 1) % mentionSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionSelectedIndex(i => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const selected = mentionSuggestions[mentionSelectedIndex];
        if (selected) {
          insertMention(selected.name);
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const selected = mentionSuggestions[mentionSelectedIndex];
        if (selected) {
          insertMention(selected.name);
        }
        return;
      }
      if (e.key === 'Escape') {
        setMentionSuggestions([]);
        return;
      }
    }

    // Handle emoji autocomplete navigation
    if (emojiSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setEmojiSelectedIndex(i => (i + 1) % emojiSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setEmojiSelectedIndex(i => (i - 1 + emojiSuggestions.length) % emojiSuggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const selected = emojiSuggestions[emojiSelectedIndex];
        if (selected) {
          insertEmoji(selected.code, selected.emoji);
        }
        return;
      }
      if (e.key === 'Escape') {
        setEmojiSuggestions([]);
        return;
      }
    }

    // Handle slash command autocomplete navigation
    if (slashSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelectedIndex(i => (i + 1) % slashSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIndex(i => (i - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const selected = slashSuggestions[slashSelectedIndex];
        if (selected) {
          insertSlashCommand(selected.name);
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const selected = slashSuggestions[slashSelectedIndex];
        if (selected) {
          insertSlashCommand(selected.name);
        }
        return;
      }
      if (e.key === 'Escape') {
        setSlashSuggestions([]);
        return;
      }
    }

    // Up arrow with empty input: load last sent message for editing, and
    // stop the @mentioned agents from processing it (recall-interrupt sends
    // ESC to their tmux, then clears any prompt the interrupt restored).
    // Own messages are stored under the canonical participantId (e.g.
    // user-<owner>), not this browser's local id — match either.
    if (e.key === 'ArrowUp' && !inputValue.trim()) {
      const myMessages = messages
        .filter(m => (m.from.id === participantId || m.from.id === BROWSER_PARTICIPANT_ID) && m.content?.trim())
        .reverse();
      if (myMessages.length > 0) {
        e.preventDefault();
        const recalled = myMessages[0];
        setInputValue(recalled.content);
        if (activeChannel && recalled.mentions && recalled.mentions.length > 0) {
          fetch('/api/collab/recall-interrupt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channelId: activeChannel.id,
              participantIds: recalled.mentions,
              messageTimestamp: recalled.timestamp,
            }),
          })
            .then(r => r.json())
            .then(d => console.log('[recall-interrupt]', d.results ?? d))
            .catch(err => console.warn('[recall-interrupt] failed:', err));
        }
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      if (isMobile) return; // Mobile: Enter creates a new line; only the Send button submits
      // Inside a list or code block, Enter is structural — return WITHOUT
      // preventDefault so ProseMirror's own keymap handles it (next list item,
      // empty item exits the list, newline in a code block). Slack/Notion
      // standard; the Send button still sends, and Enter sends again once the
      // cursor leaves the block.
      if (editor?.isActive('bulletList') || editor?.isActive('orderedList') || editor?.isActive('codeBlock')) return;
      e.preventDefault();
      handleSend();
    }
  };

  const insertAttachmentReferencesAtCursor = useCallback((references: Array<{ label: string; clientId: string }>, point?: { x: number; y: number }) => {
    if (references.length === 0) return;
    const joined = references
      .map(reference => createAttachmentReference(reference.label, reference.clientId))
      .join(' ');
    const activeEditor = editorRef.current;
    if (!activeEditor) {
      setInputValue(current => current ? `${current} ${joined} ` : `${joined} `);
      return;
    }

    let from = activeEditor.state.selection.from;
    let to = activeEditor.state.selection.to;
    if (point) {
      const rect = activeEditor.view.dom.getBoundingClientRect();
      if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
        const droppedAt = activeEditor.view.posAtCoords({ left: point.x, top: point.y });
        if (droppedAt) from = to = droppedAt.pos;
      }
    }

    const before = from > 1 ? activeEditor.state.doc.textBetween(from - 1, from, '\n', '\n') : '';
    const after = to < activeEditor.state.doc.content.size
      ? activeEditor.state.doc.textBetween(to, to + 1, '\n', '\n')
      : '';
    const leading = before && !/\s/.test(before) ? ' ' : '';
    const trailing = !after || !/\s/.test(after) ? ' ' : '';
    const richContent: Array<Record<string, unknown>> = [];
    if (leading) richContent.push({ type: 'text', text: leading });
    references.forEach((reference, index) => {
      if (index > 0) richContent.push({ type: 'text', text: ' ' });
      richContent.push({
        type: 'text',
        text: reference.label,
        marks: [{ type: 'link', attrs: { href: `attachment:${reference.clientId}` } }],
      });
    });
    if (trailing) richContent.push({ type: 'text', text: trailing });
    activeEditor.chain().focus().setTextSelection({ from, to }).insertContent(richContent).run();
  }, []);

  const queuePendingFiles = useCallback((files: File[], point?: { x: number; y: number }) => {
    // These files belong to the draft of the channel they are added in, even if the user switches channels while they load.
    const draftChannelId = activeChannel?.id;
    if (!draftChannelId) return;
    const MAX_SIZE = 25 * 1024 * 1024;
    const capacity = Math.max(0, 10 - pendingImages.length);
    const validFiles = files.filter(file => file.size <= MAX_SIZE).slice(0, capacity);
    if (validFiles.length === 0) return;
    if (validFiles.length < files.length) {
      toast.warning('AgentChat accepts up to 10 attachments of 25 MB each');
    }

    const queued = validFiles.map(file => {
      const ordinal = draftAttachments.nextOrdinal(draftChannelId);
      const clientId = globalThis.crypto?.randomUUID?.()
        ?? `attachment-${Date.now()}-${ordinal}-${Math.random().toString(36).slice(2, 8)}`;
      const label = attachmentReferenceLabel(file.type, ordinal);
      return {
        file,
        clientId,
        label,
      };
    });

    // Put the reference into the draft immediately, at the active cursor/drop
    // position. FileReader completion order must not move it elsewhere later.
    insertAttachmentReferencesAtCursor(queued.map(item => ({
      label: item.label,
      clientId: item.clientId,
    })), point);

    draftAttachments.beginReads(draftChannelId, queued.length);
    Promise.allSettled(queued.map(item => new Promise<PendingChatAttachment>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = event => resolve({
        data: event.target?.result as string,
        name: item.file.name,
        type: item.file.type || 'application/octet-stream',
        size: item.file.size,
        clientId: item.clientId,
      });
      reader.onerror = () => reject(new Error(`Unable to read ${item.file.name}`));
      reader.readAsDataURL(item.file);
    }))).then(results => {
      const loaded = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const failedIds = results.flatMap((result, index) => result.status === 'rejected' ? [queued[index].clientId] : []);
      if (loaded.length > 0) draftAttachments.update(draftChannelId, current => [...current, ...loaded]);
      if (failedIds.length > 0) {
        if (activeChannelRef.current?.id === draftChannelId) {
          setInputValue(current => failedIds.reduce(removeAttachmentReference, current));
        } else {
          // The user has moved on: the draft is saved text now, so take the unreadable references out of that.
          const key = `devflow-draft-${draftChannelId}`;
          const saved = localStorage.getItem(key);
          if (saved) localStorage.setItem(key, failedIds.reduce(removeAttachmentReference, saved));
        }
        toast.error(`Could not read ${failedIds.length} attachment${failedIds.length > 1 ? 's' : ''}`);
      }
      draftAttachments.endReads(draftChannelId, queued.length);
    });
  }, [activeChannel?.id, draftAttachments, insertAttachmentReferencesAtCursor, pendingImages.length, toast]);

  // Handle clipboard file paste (images and documents).
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    // Non-destructive code detection — runs on the pasted text WITHOUT
    // preventDefault, so the native paste still lands. We only surface a
    // suggestion the user can accept or ignore; prose is never auto-wrapped.
    const pastedText = e.clipboardData?.getData('text') ?? '';
    if (pastedText.trim().length >= 10) {
      const det = detectCodeSnippet(pastedText);
      if (det.isCode && !det.alreadyFenced && det.confidence >= 0.5) {
        setCodeSuggestion({
          language: typeof det.language === 'string' ? det.language : null,
          snippet: pastedText,
        });
      }
    }

    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }

    if (pastedFiles.length === 0) return;
    e.preventDefault();
    queuePendingFiles(pastedFiles);
  }, [queuePendingFiles]);

  // Replace a pending image with its marked-up PNG, keeping its attachment reference.
  const replacePendingImage = useCallback((index: number, dataUrl: string) => {
    setPendingImages(prev => prev.map((item, i) => i !== index ? item : {
      ...item,
      data: dataUrl,
      type: 'image/png',
      name: item.name.replace(/\.[^.]+$/, '') + '.png',
      size: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4),
    }));
  }, [setPendingImages]);

  // Remove pending image by index
  const removePendingImage = useCallback((index: number) => {
    const target = pendingImages[index];
    if (target?.clientId) {
      setInputValue(current => removeAttachmentReference(current, target.clientId));
    }
    setPendingImages(prev => prev.filter((_, i) => i !== index));
  }, [pendingImages, setPendingImages]);

  // Accept the code suggestion: wrap the pasted snippet in a fenced block.
  // Match against the editor's RAW text (getText) — the markdown mirror escapes
  // specials (my_var -> my\_var), so a mirror-only match would miss most code.
  // Re-feeding raw text through setInputValue lets tiptap-markdown parse the fence.
  const acceptCodeSuggestion = useCallback(() => {
    if (!codeSuggestion) return;
    const fenced = fenceWithLanguage(codeSuggestion.snippet, codeSuggestion.language);
    const raw = editorRef.current?.getText({ blockSeparator: '\n' }) ?? inputValue;
    if (raw.includes(codeSuggestion.snippet)) {
      setInputValue(raw.replace(codeSuggestion.snippet, fenced));
    } else if (inputValue.includes(codeSuggestion.snippet)) {
      setInputValue(inputValue.replace(codeSuggestion.snippet, fenced));
    }
    setCodeSuggestion(null);
  }, [codeSuggestion, inputValue]);

  const dismissCodeSuggestion = useCallback(() => setCodeSuggestion(null), []);

  // Post an Ask-Owner answer. Rides on metadata.client so the server hook
  // force-hides it + routes it to the asking agent. No optimistic bubble (it's
  // hidden); the card collapses optimistically on its own when the owner clicks.
  const postStructuredAnswer = useCallback(async (answer: StructuredAnswer) => {
    if (!activeChannel) return;
    let sendAsId = participantId || localStorage.getItem('devflow-collab-participantId');
    if (!sendAsId) sendAsId = await rejoinChannel(activeChannel.id);
    if (!sendAsId) return;
    try {
      await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'message',
          channelId: activeChannel.id,
          participantId: sendAsId,
          // Non-empty content required by the messaging validator; the server's
          // ask-owner hook overrides it with the routed human line for known questions.
          content: answer.selectedLabels.join(', ') || '[Ask-Owner answer]',
          metadata: { client: { kind: ASK_OWNER_ANSWER_KIND, payload: answer }, isHidden: true },
        }),
      });
    } catch (err) {
      logCollabError('post ask-owner answer', err as Error, { channelId: activeChannel.id });
    }
  }, [activeChannel, participantId]);

  // Post a visual reference decision. The server validates it against the
  // stored board, hides the envelope, and targets the creating agent.
  const postDesignReferenceSelection = useCallback(async (selection: DesignReferenceSelection) => {
    if (!activeChannel) throw new Error('No active channel for design reference selection');
    let sendAsId = participantId || localStorage.getItem('devflow-collab-participantId');
    if (!sendAsId) sendAsId = await rejoinChannel(activeChannel.id);
    if (!sendAsId) throw new Error('Unable to resolve the browser participant');
    const routedSelection: DesignReferenceSelection = {
      ...selection,
      answeredBy: sendAsId,
    };
    try {
      const response = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'message',
          channelId: activeChannel.id,
          participantId: sendAsId,
          content: routedSelection.action === 'refine'
            ? routedSelection.note || 'Refine the design reference search'
            : `${routedSelection.action}: ${routedSelection.candidateIds.join(', ')}`,
          metadata: {
            client: { kind: DESIGN_REFERENCE_SELECTION_KIND, payload: routedSelection },
            isHidden: true,
          },
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `Design reference selection failed (${response.status})`);
      }
    } catch (err) {
      logCollabError('post design reference selection', err as Error, { channelId: activeChannel.id });
      throw err;
    }
  }, [activeChannel, participantId]);

  // Format file size for display
  const formatFileSize = useCallback((bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }, []);

  // Get icon component for a file based on MIME type
  const getFileIcon = useCallback((mimeType: string) => {
    if (mimeType.startsWith('video/')) return Film;
    if (mimeType.startsWith('audio/')) return Music;
    if (mimeType === 'application/pdf') return FileText;
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType === 'text/csv') return FileSpreadsheet;
    if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return FileArchive;
    if (mimeType.includes('word') || mimeType.includes('document') || mimeType === 'text/plain') return FileText;
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return FileText;
    if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return FileCode;
    return File;
  }, []);

  // Handle file picker change
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    queuePendingFiles(Array.from(files));

    // Reset input so the same file can be selected again
    e.target.value = '';
  }, [queuePendingFiles]);

  // Drag-drop state
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  // Prevent browser default file-open behavior when dragging files anywhere on the page
  // Without this, dropping a file outside the chat area navigates the browser to the file
  useEffect(() => {
    const preventDefaults = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('dragover', preventDefaults);
    window.addEventListener('drop', preventDefaults);
    return () => {
      window.removeEventListener('dragover', preventDefaults);
      window.removeEventListener('drop', preventDefaults);
    };
  }, []);

  // Handle drag events for file upload
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer?.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    queuePendingFiles(Array.from(files), { x: e.clientX, y: e.clientY });
  }, [queuePendingFiles]);

  // Get type icon
  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'claude-terminal':
        return <Terminal className="w-3 h-3" />;
      case 'claude-browser':
        return <Bot className="w-3 h-3" />;
      case 'gemini':
      case 'gemini-powershell':
        return <Sparkles className="w-3 h-3" />;
      case 'grok':
        return <Zap className="w-3 h-3" />;
      default:
        return <User className="w-3 h-3" />;
    }
  };

  if (!isOpen) return null;

  // Participants for the navbar's avatar stack and "Show messages from" filter.
  const navMembers: NavMember[] = (activeChannel?.participants || [])
    .filter(participant => participant.id !== 'system')
    .map(participant => {
      const agent = getRosterAgent(participant.id);
      const name = participantLabel(participant);
      return {
        id: participant.id,
        name,
        initial: name.charAt(0).toUpperCase(),
        model: agent?.model,
        state: participant.status !== 'online' ? 'offline' as const : participant.type !== 'user' && participant.activityStatus === 'working' ? 'working' as const : 'ready' as const,
        where: agent ? (agent.runLocation === 'server' ? 'Remote' : 'Local') : participant.source || 'Participant',
      };
    });

  return (
    <div className={mode === 'modal' || isMobile ? 'fixed inset-0 z-50' : 'w-full h-screen overflow-hidden'}>
      {/* Full-screen Panel */}
      <div
        className="collab-panel relative overflow-hidden flex w-full h-full"
      >
        {/* Mobile sidebar backdrop overlay */}
        {isMobile && isMobileSidebarOpen && (
          <div
            className="absolute inset-0 bg-black/60 z-20 backdrop-blur-sm"
            onClick={() => setIsMobileSidebarOpen(false)}
          />
        )}
        {/* Mobile right panel (participants + roster) backdrop */}
        {isMobile && isMobileRightPanelOpen && (
          <div
            className="absolute inset-0 bg-black/60 z-20 backdrop-blur-sm"
            onClick={() => setIsMobileRightPanelOpen(false)}
          />
        )}

        {/* Sidebar - Channels (collapsible on desktop, slide-over on mobile) */}
        <ColabSidebar
          isMobile={isMobile}
          isMobileSidebarOpen={isMobileSidebarOpen}
          isSidebarCollapsed={isSidebarCollapsed}
          isExpanded={isExpanded}
          channels={channels}
          activeChannel={activeChannel}
          commanderChannel={commanderChannel}
          parentChannels={parentChannels}
          subChannelsByParent={subChannelsByParent}
          channelGroups={channelGroups}
          onGroupAction={groupAction}
          onPinChannel={pinChannel}
          unreadCounts={unreadCounts}
          collapsedParents={collapsedParents}
          loading={loading}
          projects={projects}
          showCreateChannel={showCreateChannel}
          newChannelName={newChannelName}
          newChannelProjectId={newChannelProjectId}
          isCreatingProject={isCreatingProject}
          newProjectName={newProjectName}
          newProjectPath={newProjectPath}
          newProjectError={newProjectError}
          newProjectSaving={newProjectSaving}
          archivedExpanded={archivedExpanded}
          archivedChannels={archivedChannels}
          loadingArchived={loadingArchived}
          roles={roles}
          dndSensors={dndSensors}
          dragActiveId={dragActiveId}
          dragOverId={dragOverId}
          toggleSidebar={toggleSidebar}
          fetchData={fetchData}
          setShowCreateChannel={setShowCreateChannel}
          setNewChannelProjectId={setNewChannelProjectId}
          setNewChannelName={setNewChannelName}
          setIsCreatingProject={setIsCreatingProject}
          setNewProjectName={setNewProjectName}
          setNewProjectPath={setNewProjectPath}
          setNewProjectError={setNewProjectError}
          handleCreateChannel={handleCreateChannel}
          handleCreateNewProject={handleCreateNewProject}
          setActiveChannel={setActiveChannel}
          handleMobileChannelSelect={handleMobileChannelSelect}
          setChannelContextMenu={setChannelContextMenu}
          toggleParentCollapsed={toggleParentCollapsed}
          openSubChannelModal={openSubChannelModal}
          handleDeleteChannel={handleDeleteChannel}
          handleToggleArchived={handleToggleArchived}
          handleRestoreChannel={handleRestoreChannel}
          handlePermanentlyDeleteChannel={handlePermanentlyDeleteChannel}
          setShowRolesModal={setShowRolesModal}
          fetchRoles={fetchRoles}
          handleChannelDragStart={handleChannelDragStart}
          handleChannelDragOver={handleChannelDragOver}
          handleChannelDragEnd={handleChannelDragEnd}
        />
        {pendingDelete && (
          <ChannelDeleteDialog
            channelId={pendingDelete.channelId}
            channelName={pendingDelete.name}
            mode={pendingDelete.mode}
            busy={deleteBusy}
            error={deleteError}
            onCancel={() => { if (!deleteBusy) setPendingDelete(null); }}
            onConfirm={confirmPendingDelete}
          />
        )}

        {/* Main Content */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Header: Midnight Glass chat navbar (components/ChatNavbar.tsx) */}
          <div className={isMobile ? 'collab-header-fixed' : 'relative z-10 flex-shrink-0'}>
            {activeChannel ? (
              <ChatNavbar
                channelName={activeChannel.name}
                view={activeView === 'tasks' ? 'sprints' : activeView}
                onView={(view) => {
                  handleSetActiveView(view);
                  if (view === 'teams') { fetchTeams(); fetchProjects(); }
                }}
                isMobile={isMobile}
                mode={mode === 'page' ? 'page' : 'modal'}
                onClose={onClose}
                onOpenChannels={() => (isMobile ? setIsMobileSidebarOpen(true) : toggleSidebar())}
                onOpenTeam={() => setIsMobileRightPanelOpen(true)}
                onChannelSettings={openChannelSettings}
                onChatSettings={() => setShowChatSettings(v => !v)}
                chatSettingsOpen={showChatSettings}
                members={navMembers}
                hiddenIds={hiddenParticipants}
                onToggleMember={(id) => setHiddenParticipants(prev => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  return next;
                })}
                onShowAllMembers={() => setHiddenParticipants(new Set())}
                search={{
                  open: showSearch,
                  onToggle: () => setShowSearch(v => !v),
                  query: searchQuery,
                  onQuery: setSearchQuery,
                  resultCount: filteredMessages.length,
                  resultIndex: searchResultIndex,
                  onStep: goToSearchResult,
                  onClose: () => { setSearchQuery(''); setShowSearch(false); },
                }}
                pins={{ count: pinnedMessages.length, open: showPinnedPanel, onToggle: () => setShowPinnedPanel(v => !v) }}
                mentionsOnly={mentionsOnlyMode}
                onToggleMentions={() => setMentionsOnlyMode(v => !v)}
                soundOn={soundEnabled}
                onToggleSound={toggleSound}
                docOpen={showDocPanel}
                onDoc={handleOpenDocPanel}
                spellcheckOn={spellcheckEnabled}
                onToggleSpellcheck={() => { setSpellcheckEnabled(v => !v); setSpellcheckResults([]); }}
                computerUse={{ running: computerUseEnabled ? activeComputerUseSessions : 0, stopping: killSwitchLoading, onStop: handleKillAllComputerUse }}
                voice={activeChannel.name === 'Commander' && activeView === 'chat' ? <RileyVoiceControl /> : undefined}
              />
            ) : (
              <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-white/5" style={{ backgroundColor: 'rgba(10,10,20,0.8)', backdropFilter: 'blur(20px)' }}>
                <div className="flex items-center gap-3">
                  {isMobile && (
                    <button
                      onClick={() => setIsMobileSidebarOpen(true)}
                      className="p-1.5 rounded-lg hover:bg-white/10 text-muted transition-colors"
                      title="Open channels"
                    >
                      <PanelLeftOpen className="w-5 h-5" />
                    </button>
                  )}
                  <div className="text-muted">Select a channel to start collaborating</div>
                </div>
                {mode === 'page' ? (
                  <Link href="/operations" className="p-2 rounded-lg hover:bg-white/10 text-muted transition-colors flex items-center gap-1.5" title="Operations hub: systems, services and health" aria-label="Operations hub">
                    <Server className="w-5 h-5" />
                    {!isMobile && <span className="text-sm">Operations</span>}
                  </Link>
                ) : (
                  <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 text-muted transition-colors" aria-label="Close">
                    <X className="w-5 h-5" />
                  </button>
                )}
              </div>
            )}
          </div>
          {/* Fixed header spacer on mobile — compensates for position:fixed removing header from flow */}
          {isMobile && <div className="collab-header-spacer flex-shrink-0" />}

          {/* Chat Settings Modal — tabbed: General / Alignment Files / Sync */}
          {showChatSettings && (
            <ChatSettingsModal
              onClose={() => setShowChatSettings(false)}
              chatSettingsTab={chatSettingsTab}
              setChatSettingsTab={setChatSettingsTab}
              spellcheckEnabled={spellcheckEnabled}
              setSpellcheckEnabled={setSpellcheckEnabled}
              setSpellcheckResults={setSpellcheckResults}
              soundEnabled={soundEnabled}
              toggleSound={toggleSound}
              showSilentMessages={showSilentMessages}
              toggleSilentMessages={toggleSilentMessages}
            />
          )}

          {/* Doc Panel — PROJECT.md viewer */}
          {activeChannel && (
            <DocPanelModal
              show={showDocPanel}
              activeChannel={activeChannel}
              onClose={() => setShowDocPanel(false)}
              docPanelLoading={docPanelLoading}
              docPanelContent={docPanelContent}
              docPanelProjectPath={docPanelProjectPath}
              docPanelExists={docPanelExists}
              docPanelNotice={docPanelNotice}
              onSavePath={handleSaveDocPath}
            />
          )}

          {/* Pinned Messages Dropdown */}
          {showPinnedPanel && activeChannel && pinnedMessages.length > 0 && (
            <PinnedMessagesDropdown
              pinnedMessages={pinnedMessages}
              onClose={() => setShowPinnedPanel(false)}
              getRelativeTime={getRelativeTime}
              togglePin={togglePin}
            />
          )}


          {/* Channel Settings Modal */}
          {showChannelSettings && activeChannel && (
            <ChannelSettingsModal
              activeChannel={activeChannel}
              onClose={() => setShowChannelSettings(false)}
              editChannelName={editChannelName}
              setEditChannelName={setEditChannelName}
              editChannelDescription={editChannelDescription}
              setEditChannelDescription={setEditChannelDescription}
              editChannelProjectPath={editChannelProjectPath}
              setEditChannelProjectPath={setEditChannelProjectPath}
              handleSaveChannelSettings={handleSaveChannelSettings}
              error={channelSettingsError}
              saving={channelSettingsSaving}
            />
          )}
          {/* Context Menu for Participants */}
          {contextMenu && (
            <ParticipantContextMenu
              contextMenu={contextMenu}
              onClose={() => setContextMenu(null)}
              activeChannel={activeChannel}
              respawningAgentId={respawningAgentId}
              keepAliveAgentIds={keepAliveAgentIds}
              getRosterAgent={getRosterAgent}
              handleRosterKill={handleRosterKill}
              handleRosterRespawn={handleRosterRespawn}
              handleRosterOpenTerminal={handleRosterOpenTerminal}
              handleRosterCompact={handleRosterCompact}
              setKeepAliveParticipant={setKeepAliveParticipant}
              handleMakeTeamLead={handleMakeTeamLead}
              setRenamingParticipantId={setRenamingParticipantId}
              setRenameValue={setRenameValue}
              handleRemoveParticipant={handleRemoveParticipant}
              handleRosterRemove={handleRosterRemove}
              setActiveChannel={setActiveChannel}
              fetchData={fetchData}
              handleRecallAgent={handleRecallAgent}
              handleDetachAgent={handleDetachAgent}
              setConfigModalAgentId={setConfigModalAgentId}
              onShowAgentDetails={(roster) => {
                const copyText = buildAgentDetailsText({
                  roster,
                  participantName: contextMenu.participant.name,
                  channelName: activeChannel?.name,
                  roles,
                });
                if (navigator.clipboard) {
                  navigator.clipboard.writeText(copyText)
                    .then(() => toast.success('Agent details copied'))
                    .catch(() => toast.error('Could not copy agent details'));
                } else {
                  toast.error('Clipboard access is unavailable');
                }
                setAgentDetailsRoster({ roster, participantName: contextMenu.participant.name });
                setContextMenu(null);
              }}
            />
          )}

          {/* Agent Details Modal — resolve the live roster entry so poll-driven
              status updates (e.g. per-message session Responding/Ready) reach the
              open modal; falls back to the right-click snapshot if the agent left */}
          {agentDetailsRoster && (
            <AgentDetailsModal
              roster={activeChannel?.roster?.agents?.find(a => a.id === agentDetailsRoster.roster.id) ?? agentDetailsRoster.roster}
              participantName={agentDetailsRoster.participantName}
              channelName={activeChannel?.name}
              roles={roles}
              onClose={() => setAgentDetailsRoster(null)}
            />
          )}

          {/* Context Menu for Channels — Midnight Glass menu (opaque, floats above the glass sidebar) */}
          {channelContextMenu && (() => {
            const menuChannel = channelContextMenu.channel;
            const currentGroupId = getChannelGroupId(menuChannel, channelGroups);
            const currentGroup = channelGroups.find(group => group.id === currentGroupId);
            const watching = riley.available && riley.watches(menuChannel.id);
            const close = () => setChannelContextMenu(null);
            return (
              <>
                <div className="fixed inset-0 z-30" onClick={close} onContextMenu={e => { e.preventDefault(); close(); }} />
                <div
                  className="mg-scope mg-menu"
                  role="menu"
                  style={{
                    left: Math.max(8, Math.min(channelContextMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1920) - 292)),
                    top: Math.max(8, Math.min(channelContextMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 1080) - 460)),
                  }}
                >
                  <div className="mg-menu__head">
                    <b title={menuChannel.name}>{menuChannel.name}</b>
                    {currentGroup && <small>{currentGroup.name}</small>}
                  </div>
                  {/* Create Subchannel - only for top-level channels */}
                  {!menuChannel.parentChannelId && (
                    <button role="menuitem" className="mg-mi" onClick={() => { openSubChannelModal(menuChannel.id); close(); }}>
                      <span className="mg-ti"><MessageSquarePlus size={16} strokeWidth={1.5} /></span>
                      <span className="mg-tx">Create Subchannel</span>
                    </button>
                  )}
                  {/* Make Top-Level - only for subchannels */}
                  {menuChannel.parentChannelId && (
                    <button role="menuitem" className="mg-mi" onClick={() => { handleMakeTopLevel(menuChannel.id); close(); }}>
                      <span className="mg-ti"><ArrowLeft size={16} strokeWidth={1.5} /></span>
                      <span className="mg-tx">Make Top-Level</span>
                    </button>
                  )}
                  {/* Move to group — sub-channels follow their parent */}
                  {!menuChannel.parentChannelId && menuChannel.id !== COMMANDER_CHANNEL_ID && (
                    <>
                      <div className="mg-label">Move to group</div>
                      <div className="mg-chips">
                        {channelGroups.map(tab => {
                          const isCurrent = currentGroupId === tab.id;
                          return (
                            <button
                              key={tab.id}
                              disabled={isCurrent}
                              aria-pressed={isCurrent}
                              className={`mg-chip ${isCurrent ? 'mg-chip--on' : ''}`}
                              onClick={() => {
                                void groupAction('move_channel_to_group', { channelId: menuChannel.id, groupId: tab.id }).catch(err => toast.error(err.message));
                                close();
                              }}
                            >
                              {tab.name}
                            </button>
                          );
                        })}
                      </div>
                      <hr />
                    </>
                  )}
                  {/* Pin/Unpin */}
                  <button role="menuitem" className="mg-mi" onClick={() => { void pinChannel(menuChannel).catch(err => toast.error(err.message)); close(); }}>
                    <span className="mg-ti"><Pin size={16} strokeWidth={1.5} /></span>
                    <span className="mg-tx">{menuChannel.pinnedAt ? 'Unpin channel' : 'Pin channel'}</span>
                  </button>
                  {/* Riley Voice watching this channel — offered whenever this browser can reach the PC voice server */}
                  {riley.available && (
                    <button
                      role="menuitemcheckbox"
                      aria-checked={watching}
                      className="mg-mi"
                      title={watching ? 'Riley Voice is reading this channel. Click to stop.' : 'Click to have Riley Voice read this channel and tell you what needs you.'}
                      onClick={() => {
                        void riley.setWatching({ id: menuChannel.id, name: menuChannel.name }, !watching)
                          .then(() => toast.success(watching ? `Riley Voice stopped watching ${menuChannel.name}` : `Riley Voice is watching ${menuChannel.name}`))
                          .catch(err => toast.error(err.message));
                        close();
                      }}
                    >
                      <span className="mg-ti">{watching ? <span className="mg-voice" aria-hidden><i /><i /><i /><i /><i /></span> : <AudioLines size={16} strokeWidth={1.5} />}</span>
                      <span className="mg-tx">Riley Voice<small>{watching ? 'Watching this channel' : 'Not watching'}</small></span>
                      <span className={`mg-switch ${watching ? 'mg-switch--on' : ''}`} aria-hidden />
                    </button>
                  )}
                  {/* Rename */}
                  <button
                    role="menuitem"
                    className="mg-mi"
                    onClick={() => {
                      setEditChannelName(menuChannel.name);
                      setEditChannelDescription(menuChannel.description || '');
                      setActiveChannel(menuChannel);
                      setShowChannelSettings(true);
                      close();
                    }}
                  >
                    <span className="mg-ti"><Pencil size={16} strokeWidth={1.5} /></span>
                    <span className="mg-tx">Rename</span>
                  </button>
                  {!menuChannel.protected && (
                    <>
                      <hr />
                      {/* Archive (the dialog explains what happens to the project folder) */}
                      <button
                        role="menuitem"
                        className="mg-mi mg-mi--danger"
                        onClick={(e) => { handleDeleteChannel(menuChannel.id, e as unknown as React.MouseEvent); close(); }}
                      >
                        <span className="mg-ti"><Trash2 size={16} strokeWidth={1.5} /></span>
                        <span className="mg-tx">Archive Channel</span>
                      </button>
                    </>
                  )}
                </div>
              </>
            );
          })()}

          {/* Sub-Channel Creation Modal */}
          {showSubChannelModal && subChannelParentId && (
            <SubChannelModal
              showSubChannelModal={showSubChannelModal}
              setShowSubChannelModal={setShowSubChannelModal}
              subChannelParentId={subChannelParentId}
              setSubChannelParentId={setSubChannelParentId}
              channels={channels}
              browserParticipantId={BROWSER_PARTICIPANT_ID}
              selectedSubChannelMembers={selectedSubChannelMembers}
              setSelectedSubChannelMembers={setSelectedSubChannelMembers}
              handleCreateSubChannel={handleCreateSubChannel}
            />
          )}

          {/* Messages + Sidebar wrapper */}
          <div className="flex-1 flex overflow-hidden min-h-0">
            <AnimatePresence mode="wait">
            {/* Task Board View */}
            {activeView === 'tasks' && activeChannel && participantId && (
              <motion.div
                key="tasks"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex-1 overflow-hidden"
              >
                <TaskBoard
                  channelId={activeChannel.id}
                  participantId={participantId}
                  participants={activeChannel.participants || []}
                />
              </motion.div>
            )}

            {/* Sprints View (Hierarchical Task Board) */}
            {activeView === 'sprints' && activeChannel && participantId && (
              <motion.div
                key="sprints"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex-1 overflow-y-auto"
              >
                <HierarchicalTaskBoard
                  channelId={activeChannel.id}
                  participantId={participantId}
                  participants={activeChannel.participants || []}
                  isTeamLead={activeChannel.teamLeadId === participantId}
                  onDiscussTask={handleDiscussTask}
                />
              </motion.div>
            )}

            {/* Teams View */}
            {activeView === 'teams' && (
              <motion.div
                key="teams"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex-1 overflow-y-auto p-6"
              >
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h2 className="text-lg font-semibold text-white/90 flex items-center gap-2">
                      <UsersRound className="w-5 h-5 text-blue-400" />
                      Team Templates
                    </h2>
                    <p className="text-xs text-muted mt-1">Reusable agent configurations. Launch a team to create a channel with all agents pre-configured.</p>
                  </div>
                  <button
                    onClick={openCreateTeamForm}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 border border-blue-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
                  >
                    <Plus className="w-4 h-4" />
                    Create Team
                  </button>
                </div>

                {/* Loading */}
                {teamsLoading && teams.length === 0 && (
                  <div className="flex items-center justify-center py-16">
                    <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
                  </div>
                )}

                {/* Empty State */}
                {!teamsLoading && teams.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center mb-4">
                      <UsersRound className="w-8 h-8 text-blue-400/60" />
                    </div>
                    <h3 className="text-sm font-medium text-white/70 mb-1">No teams yet</h3>
                    <p className="text-xs text-muted max-w-xs">
                      Create a team template to save agent configurations. Launch it anytime to spin up a channel with all your agents.
                    </p>
                    <button
                      onClick={openCreateTeamForm}
                      className="mt-4 flex items-center gap-2 px-4 py-2 rounded-xl text-sm bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 border border-blue-500/20 transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      Create Your First Team
                    </button>
                  </div>
                )}

                {/* Team Cards */}
                <div className="grid gap-4">
                  {teams.map((team) => (
                    <div
                      key={team.id}
                      className="group relative bg-[#0a1628]/80 backdrop-blur border border-white/[0.06] rounded-2xl p-5 hover:border-blue-500/20 transition-all hover:shadow-[0_8px_32px_-8px_rgba(59,130,246,0.1)]"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h3 className="text-base font-semibold text-white/90 truncate">{team.name}</h3>
                          {team.description && (
                            <p className="text-xs text-muted mt-1 line-clamp-2">{team.description}</p>
                          )}
                          {team.projectId && (() => {
                            const proj = projects.find(p => p.id === team.projectId);
                            return proj ? (
                              <span className="inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded-md text-[10px] font-medium bg-blue-500/10 text-blue-400 border border-blue-500/15">
                                <Folder className="w-2.5 h-2.5" />
                                {proj.name}
                              </span>
                            ) : null;
                          })()}
                          <div className="flex items-center gap-4 mt-3">
                            {/* Agent avatars */}
                            <div className="flex items-center">
                              <div className="flex -space-x-1.5">
                                {team.agents.slice(0, 5).map((agent) => (
                                  <div
                                    key={agent.id}
                                    className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold border-2 border-[#0a1628] ring-1 ring-white/[0.06]"
                                    style={{ backgroundColor: agent.color + '30', color: agent.color }}
                                    title={agent.name}
                                  >
                                    {agent.name.charAt(0).toUpperCase()}
                                  </div>
                                ))}
                                {team.agents.length > 5 && (
                                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-medium bg-white/10 text-muted border-2 border-[#0a1628]">
                                    +{team.agents.length - 5}
                                  </div>
                                )}
                              </div>
                              <span className="text-[11px] text-muted ml-2">{team.agents.length} agent{team.agents.length !== 1 ? 's' : ''}</span>
                            </div>
                            {/* Launch count */}
                            {team.launchCount > 0 && (
                              <span className="text-[11px] text-muted flex items-center gap-1">
                                <Rocket className="w-3 h-3" />
                                {team.launchCount}x launched
                              </span>
                            )}
                            {/* Last launched */}
                            {team.lastLaunchedAt && (
                              <span className="text-[11px] text-muted flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {new Date(team.lastLaunchedAt).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 ml-4">
                          <button
                            onClick={() => openLaunchModal(team)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
                          >
                            <Rocket className="w-3.5 h-3.5" />
                            Launch
                          </button>
                          <button
                            onClick={() => openEditTeamForm(team)}
                            className="p-2 rounded-lg hover:bg-white/[0.06] text-muted hover:text-white transition-colors"
                            title="Edit team"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {deletingTeamId === team.id ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleDeleteTeam(team.id)}
                                className="p-2 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                                title="Confirm delete"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setDeletingTeamId(null)}
                                className="p-2 rounded-lg hover:bg-white/[0.06] text-muted transition-colors"
                                title="Cancel"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setDeletingTeamId(team.id)}
                              className="p-2 rounded-lg hover:bg-red-500/10 text-muted hover:text-red-400 transition-colors"
                              title="Delete team"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Create/Edit Team Modal */}
                {showCreateTeam && (
                  <>
                    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => { setShowCreateTeam(false); setEditingTeam(null); }} />
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                      <div className="bg-[#0a1628] border border-white/[0.08] rounded-2xl shadow-[0_24px_80px_-20px_rgba(0,0,0,0.6)] w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
                        {/* Modal Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-gradient-to-r from-blue-500/[0.06] to-transparent">
                          <h3 className="text-lg font-semibold flex items-center gap-2">
                            <UsersRound className="w-5 h-5 text-blue-400" />
                            {editingTeam ? 'Edit Team' : 'Create Team'}
                          </h3>
                          <button onClick={() => { setShowCreateTeam(false); setEditingTeam(null); }} className="p-2 rounded-lg hover:bg-white/[0.06] text-muted">
                            <X className="w-4 h-4" />
                          </button>
                        </div>

                        {/* Modal Body */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-5">
                          {/* Team Name */}
                          <div>
                            <label className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">Team Name</label>
                            <input
                              type="text"
                              value={teamFormName}
                              onChange={(e) => setTeamFormName(e.target.value)}
                              placeholder="e.g. Video Production"
                              className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 transition-colors"
                              autoFocus
                            />
                          </div>

                          {/* Description */}
                          <div>
                            <label className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">Description (optional)</label>
                            <input
                              type="text"
                              value={teamFormDescription}
                              onChange={(e) => setTeamFormDescription(e.target.value)}
                              placeholder="What does this team do?"
                              className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 transition-colors"
                            />
                          </div>

                          {/* Project */}
                          <div>
                            <label className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">Project (optional)</label>
                            <select
                              value={teamFormProjectId}
                              onChange={(e) => {
                                setTeamFormProjectId(e.target.value);
                                // Auto-fill working directory for agents that don't have one yet
                                const proj = projects.find(p => p.id === e.target.value);
                                if (proj) {
                                  setTeamFormAgents(prev => prev.map(a =>
                                    !a.workingDirectory ? { ...a, workingDirectory: proj.path } : a
                                  ));
                                }
                              }}
                              className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500/30 transition-colors"
                            >
                              <option value="">No project linked</option>
                              {projects.map(p => (
                                <option key={p.id} value={p.id}>{p.name} — {p.path}</option>
                              ))}
                            </select>
                          </div>

                          {/* Agents Section */}
                          <div>
                            <label className="text-xs font-medium text-muted uppercase tracking-wider mb-3 block">
                              Agents ({teamFormAgents.length})
                            </label>
                            <div className="space-y-3">
                              {teamFormAgents.map((agent, idx) => (
                                <div
                                  key={idx}
                                  className="bg-black/20 border border-white/[0.06] rounded-xl p-4 space-y-3"
                                >
                                  <div className="flex items-start gap-3">
                                    {/* Color picker */}
                                    <div className="flex flex-col items-center gap-1.5 pt-0.5">
                                      <div
                                        className="w-8 h-8 rounded-lg cursor-pointer border-2 border-white/10 hover:border-white/30 transition-colors flex items-center justify-center text-xs font-bold"
                                        style={{ backgroundColor: agent.color + '30', color: agent.color, borderColor: agent.color + '40' }}
                                        title="Click to change color"
                                        onClick={() => {
                                          const currentIdx = AGENT_COLORS.indexOf(agent.color);
                                          const nextColor = AGENT_COLORS[(currentIdx + 1) % AGENT_COLORS.length];
                                          const updated = [...teamFormAgents];
                                          updated[idx] = { ...agent, color: nextColor };
                                          setTeamFormAgents(updated);
                                        }}
                                      >
                                        {agent.name ? agent.name.charAt(0).toUpperCase() : '?'}
                                      </div>
                                    </div>

                                    {/* Name + directory inputs */}
                                    <div className="flex-1 space-y-2">
                                      <input
                                        type="text"
                                        value={agent.name}
                                        onChange={(e) => {
                                          const updated = [...teamFormAgents];
                                          updated[idx] = { ...agent, name: e.target.value };
                                          setTeamFormAgents(updated);
                                        }}
                                        placeholder="Agent name..."
                                        className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 transition-colors"
                                      />
                                      <DirectoryAutocomplete
                                        value={agent.workingDirectory}
                                        onChange={(val) => {
                                          const updated = [...teamFormAgents];
                                          updated[idx] = { ...agent, workingDirectory: val };
                                          setTeamFormAgents(updated);
                                        }}
                                        className="w-full bg-black/20 border border-white/[0.06] rounded-lg px-3 py-1.5 text-xs text-white/70 placeholder:text-white/15 focus:outline-none focus:border-blue-500/30 transition-colors font-mono"
                                        iconClassName="w-3.5 h-3.5 text-muted flex-shrink-0"
                                      />
                                    </div>

                                    {/* Remove button */}
                                    <button
                                      onClick={() => {
                                        const updated = teamFormAgents.filter((_, i) => i !== idx);
                                        setTeamFormAgents(updated);
                                      }}
                                      className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted hover:text-red-400 transition-colors"
                                    >
                                      <X className="w-4 h-4" />
                                    </button>
                                  </div>

                                  {/* Toggle options */}
                                  <div className="flex items-center gap-2 pl-11">
                                    <button
                                      onClick={() => {
                                        const updated = [...teamFormAgents];
                                        updated[idx] = { ...agent, autoResume: !agent.autoResume };
                                        setTeamFormAgents(updated);
                                      }}
                                      className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md transition-colors ${agent.autoResume ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-white/[0.03] text-muted/50 border border-white/[0.04]'}`}
                                    >
                                      <RotateCcw className="w-2.5 h-2.5" />
                                      Resume
                                    </button>
                                    <button
                                      onClick={() => {
                                        const updated = [...teamFormAgents];
                                        updated[idx] = { ...agent, useCollabWrapper: !agent.useCollabWrapper };
                                        setTeamFormAgents(updated);
                                      }}
                                      className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md transition-colors ${agent.useCollabWrapper ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' : 'bg-white/[0.03] text-muted/50 border border-white/[0.04]'}`}
                                    >
                                      <Zap className="w-2.5 h-2.5" />
                                      Wrapper
                                    </button>
                                    <button
                                      onClick={() => {
                                        const updated = [...teamFormAgents];
                                        updated[idx] = { ...agent, dangerouslySkipPermissions: !agent.dangerouslySkipPermissions };
                                        setTeamFormAgents(updated);
                                      }}
                                      className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md transition-colors ${agent.dangerouslySkipPermissions ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-white/[0.03] text-muted/50 border border-white/[0.04]'}`}
                                    >
                                      <Shield className="w-2.5 h-2.5" />
                                      Skip Perms
                                    </button>
                                  </div>
                                </div>
                              ))}

                              {/* Add Agent Button */}
                              <button
                                onClick={() => {
                                  const proj = projects.find(p => p.id === teamFormProjectId);
                                  setTeamFormAgents([...teamFormAgents, {
                                    name: '',
                                    workingDirectory: proj?.path || getHomeDir(),
                                    color: AGENT_COLORS[teamFormAgents.length % AGENT_COLORS.length],
                                    autoResume: true,
                                    useCollabWrapper: true,
                                    dangerouslySkipPermissions: true,
                                  }]);
                                }}
                                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm border border-dashed border-white/[0.08] hover:border-blue-500/20 text-muted hover:text-blue-400 transition-colors hover:bg-blue-500/[0.04]"
                              >
                                <Plus className="w-4 h-4" />
                                Add Agent
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Modal Footer */}
                        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-white/[0.06] bg-black/20">
                          <button
                            onClick={() => { setShowCreateTeam(false); setEditingTeam(null); }}
                            className="px-4 py-2 rounded-xl text-sm text-muted hover:bg-white/[0.06] transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSaveTeam}
                            disabled={!teamFormName.trim() || teamFormAgents.length === 0 || teamFormAgents.some(a => !a.name.trim())}
                            className="px-5 py-2 rounded-xl text-sm bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-40 disabled:hover:bg-blue-500"
                          >
                            {editingTeam ? 'Save Changes' : 'Create Team'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* Launch Team Modal */}
                {launchingTeam && (
                  <>
                    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => setLaunchingTeam(null)} />
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                      <div className="bg-[#0a1628] border border-white/[0.08] rounded-2xl shadow-[0_24px_80px_-20px_rgba(0,0,0,0.6)] w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
                        {/* Header */}
                        <div className="px-6 py-4 border-b border-white/[0.06] bg-gradient-to-r from-green-500/[0.06] to-transparent">
                          <h3 className="text-lg font-semibold flex items-center gap-2">
                            <Rocket className="w-5 h-5 text-green-400" />
                            Launch &ldquo;{launchingTeam.name}&rdquo;
                          </h3>
                          <p className="text-xs text-muted mt-1">
                            {launchingTeam.agents.length} agent{launchingTeam.agents.length !== 1 ? 's' : ''} will be spawned
                          </p>
                        </div>

                        <div className="p-6 space-y-4">
                          {/* Agent preview */}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {launchingTeam.agents.map((agent) => (
                              <span
                                key={agent.id}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border"
                                style={{
                                  backgroundColor: agent.color + '15',
                                  borderColor: agent.color + '30',
                                  color: agent.color,
                                }}
                              >
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: agent.color }} />
                                {agent.name}
                                {agent.lastClaudeSessionId && (
                                  <span title="Will resume previous session"><RotateCcw className="w-2.5 h-2.5 opacity-60" /></span>
                                )}
                              </span>
                            ))}
                          </div>

                          {/* Channel selection */}
                          <div className="space-y-3">
                            <label
                              className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                                launchMode === 'new'
                                  ? 'border-green-500/30 bg-green-500/[0.06]'
                                  : 'border-white/[0.06] hover:border-white/[0.12]'
                              }`}
                              onClick={() => setLaunchMode('new')}
                            >
                              <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${launchMode === 'new' ? 'border-green-400' : 'border-white/20'}`}>
                                {launchMode === 'new' && <div className="w-2 h-2 rounded-full bg-green-400" />}
                              </div>
                              <div className="flex-1">
                                <div className="text-sm text-white/80">Create new channel</div>
                                {launchMode === 'new' && (
                                  <input
                                    type="text"
                                    value={launchChannelName}
                                    onChange={(e) => setLaunchChannelName(e.target.value)}
                                    placeholder="Channel name (auto-generated if empty)"
                                    className="mt-2 w-full bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-green-500/30 transition-colors"
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                )}
                              </div>
                            </label>

                            <label
                              className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                                launchMode === 'existing'
                                  ? 'border-green-500/30 bg-green-500/[0.06]'
                                  : 'border-white/[0.06] hover:border-white/[0.12]'
                              }`}
                              onClick={() => setLaunchMode('existing')}
                            >
                              <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${launchMode === 'existing' ? 'border-green-400' : 'border-white/20'}`}>
                                {launchMode === 'existing' && <div className="w-2 h-2 rounded-full bg-green-400" />}
                              </div>
                              <div className="flex-1">
                                <div className="text-sm text-white/80">Use existing channel</div>
                                {launchMode === 'existing' && (
                                  <select
                                    value={launchChannelId}
                                    onChange={(e) => setLaunchChannelId(e.target.value)}
                                    className="mt-2 w-full bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-green-500/30 transition-colors"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <option value="">Select channel...</option>
                                    {channels.filter(c => !c.parentChannelId).map(c => (
                                      <option key={c.id} value={c.id}>{c.name}</option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            </label>
                          </div>
                        </div>

                        {/* Footer */}
                        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-white/[0.06] bg-black/20">
                          <button
                            onClick={() => setLaunchingTeam(null)}
                            className="px-4 py-2 rounded-xl text-sm text-muted hover:bg-white/[0.06] transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleLaunchTeam}
                            disabled={launchInProgress || (launchMode === 'existing' && !launchChannelId)}
                            className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/20 transition-colors disabled:opacity-40"
                          >
                            {launchInProgress ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Rocket className="w-4 h-4" />
                            )}
                            {launchInProgress ? 'Launching...' : 'Launch Team'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* Roles Section */}
                <div className="mt-8 border-t border-white/[0.06] pt-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-sm font-semibold text-white/80 flex items-center gap-2">
                        <Shield className="w-4 h-4 text-indigo-400" />
                        Agent Roles
                      </h3>
                      <p className="text-[10px] text-muted mt-0.5">Define roles with .md instructions. Assigned agents receive role-specific system prompts at spawn.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          fetch('/api/folder', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: `${getDevflowHome()}/data/roles` }),
                          });
                        }}
                        className="p-1.5 rounded-lg hover:bg-white/[0.06] text-white/30 hover:text-indigo-400/70 transition-colors"
                        title="Open roles folder in Explorer"
                      >
                        <FolderOpen className="w-4 h-4" />
                      </button>
                      <button
                        onClick={async () => {
                          const name = prompt('Role name (e.g. "Backend Dev", "Researcher"):');
                          if (!name?.trim()) return;
                          const desc = prompt('Short description (optional):') || '';
                          try {
                            const res = await fetch('/api/roles', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ action: 'create', name: name.trim(), description: desc.trim() }),
                            });
                            const data = await res.json();
                            if (data.success) {
                              fetchRoles();
                            } else {
                              alert(data.error || 'Failed to create role');
                            }
                          } catch { alert('Network error'); }
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/15 transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        New Role
                      </button>
                    </div>
                  </div>

                  {roles.length === 0 ? (
                    <div className="text-center py-8 text-muted text-xs">
                      No roles defined yet. Create a role to assign specialized instructions to agents.
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {roles.map(role => (
                        <div key={role.id} className="group flex items-center gap-3 p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.04] hover:border-indigo-500/15 transition-all">
                          <div className="w-8 h-8 rounded-lg bg-indigo-500/15 flex items-center justify-center flex-shrink-0">
                            <Shield className="w-4 h-4 text-indigo-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-white/80">{role.name}</div>
                            {role.description && <div className="text-[10px] text-muted truncate">{role.description}</div>}
                            <div className="text-[9px] text-white/20 mt-0.5">{role.mdPath}</div>
                          </div>
                          <button
                            onClick={async () => {
                              if (!confirm(`Delete role "${role.name}"? This will not unassign agents.`)) return;
                              try {
                                await fetch('/api/roles', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ action: 'delete', roleId: role.id }),
                                });
                                fetchRoles();
                              } catch { /* ignore */ }
                            }}
                            className="p-1.5 rounded-md hover:bg-red-500/15 text-white/20 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                            title="Delete role"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {/* Ideas View */}
            {activeView === 'ideas' && (
              <motion.div
                key="ideas"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex-1 overflow-y-auto p-6"
              >
                <IdeaBoard onDiscuss={(channelId) => {
                  // Find the linked channel and switch to it
                  const target = channels.find(c => c.id === channelId);
                  if (target) {
                    setActiveChannel(target);
                    setActiveView('chat');
                  }
                }} />
              </motion.div>
            )}

            {/* Chat View */}
            {activeView === 'chat' && (
            <motion.div
              key="chat"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex-1 flex flex-col min-h-0 min-w-0"
            >
            <ColabChatView
              accountDisplayName={account?.profile.displayName}
              setMessagesContainerRef={setMessagesContainerRef}
              messagesEndRef={messagesEndRef}
              inputRef={inputRef}
              activeChannel={activeChannel}
              participantId={participantId}
              messages={dedupedMessages}
              filteredMessages={filteredMessages}
              roles={roles}
              isMobile={isMobile}
              searchQuery={searchQuery}
              activeSearchMessageId={activeSearchMessageId}
              hasMoreMessages={hasMoreMessages}
              loadingOlderMessages={loadingOlderMessages}
              showScrollToBottom={showScrollToBottom}
              loadOlderMessages={loadOlderMessages}
              scrollToBottom={scrollToBottom}
              pinnedMessages={pinnedMessages}
              firstUnreadMessageId={firstUnreadMessageId}
              typingParticipants={typingParticipants}
              streamingMessageId={streamingMessageId}
              editingMessageId={editingMessageId}
              editContent={editContent}
              setEditContent={setEditContent}
              saveEdit={saveEdit}
              cancelEditing={cancelEditing}
              copiedMessageId={copiedMessageId}
              isDragging={isDragging}
              handleDragEnter={handleDragEnter}
              handleDragLeave={handleDragLeave}
              handleDragOver={handleDragOver}
              handleDrop={handleDrop}
              toggleReaction={toggleReaction}
              togglePin={togglePin}
              copyMessage={copyMessage}
              setLightboxImage={setLightboxImage}
              setReplyingTo={setReplyingTo}
              setInputValue={setInputValue}
              onCrossChannelReply={(target) => {
                setCrossChannelTarget(target);
                inputRef.current?.focus();
              }}
              postStructuredAnswer={postStructuredAnswer}
              postDesignReferenceSelection={postDesignReferenceSelection}
              getRelativeTime={getRelativeTime}
              getReadBy={getReadBy}
              highlightMatch={highlightMatch}
              applySearchHighlight={applySearchHighlight}
              getFileIcon={getFileIcon}
              formatFileSize={formatFileSize}
            />
            </motion.div>
            )}
            </AnimatePresence>

            {/* Participants Sidebar — desktop inline, mobile slide-over from right */}
            <ColabRightPanel
              activeChannel={activeChannel}
              participantId={participantId}
              isMobile={isMobile}
              isMobileRightPanelOpen={isMobileRightPanelOpen}
              setIsMobileRightPanelOpen={setIsMobileRightPanelOpen}
              kickedParticipants={kickedParticipants}
              setKickedParticipants={setKickedParticipants}
              typingParticipants={typingParticipants}
              agentUsage={agentUsage}
              keepAliveAgentIds={keepAliveAgentIds}
              roles={roles}
              projects={projects}
              respawningAgentId={respawningAgentId}
              renamingParticipantId={renamingParticipantId}
              setRenamingParticipantId={setRenamingParticipantId}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              editingMyName={editingMyName}
              setEditingMyName={setEditingMyName}
              myNewName={myNewName}
              setMyNewName={setMyNewName}
              showRosterSpawn={showRosterSpawn}
              setShowRosterSpawn={setShowRosterSpawn}
              modelRegistry={modelRegistry}
              setConfigModalAgentId={setConfigModalAgentId}
              frozenParticipantIds={frozenParticipantIds}
              onParticipantContextMenu={(e, p, isAgent) => {
                if (isAgent) {
                  e.preventDefault();
                  fetchRoles();
                  setContextMenu({ x: e.clientX, y: e.clientY, participant: p });
                }
              }}
              rosterActionButtons={activeChannel ? <>
                <StartRosterButton channelId={activeChannel.id} onComplete={fetchData} />
                {activeChannel.roster?.agents?.some(a => a.status === 'running') && (
                  <>
                    <GracefulRestartButton channelId={activeChannel.id} />
                    <GracefulShutdownButton channelId={activeChannel.id} />
                  </>
                )}
              </> : null}
              fetchData={fetchData}
              fetchRoles={fetchRoles}
              getRosterAgent={getRosterAgent}
              handleRemoveParticipant={handleRemoveParticipant}
              handleRecallAgent={handleRecallAgent}
              handleMakeTeamLead={handleMakeTeamLead}
              handleRenameMyself={handleRenameMyself}
              handleRenameParticipant={handleRenameParticipant}
              handleReinviteParticipant={handleReinviteParticipant}
              handleDetachAgent={handleDetachAgent}
              handleRosterKill={handleRosterKill}
              handleRosterRespawn={handleRosterRespawn}
              handleRosterOpenTerminal={handleRosterOpenTerminal}
              handleRosterRemove={handleRosterRemove}
            />
          </div>

          {/* Roster Config Modal */}
          {configModalAgentId && activeChannel?.roster?.agents && (() => {
            const configAgent = activeChannel.roster.agents.find(a => a.id === configModalAgentId);
            if (!configAgent) return null;
            return (
              <RosterConfigModal
                agent={configAgent}
                channelId={activeChannel.id}
                roles={roles}
                modelRegistry={modelRegistry}
                onClose={() => setConfigModalAgentId(null)}
                onSaved={() => { setConfigModalAgentId(null); fetchData(); }}
              />
            );
          })()}

          {/* Voice Mode Overlay — floats above the input when active */}
          {activeChannel && isVoiceModeOpen && (
            <div className="px-3 pb-2">
              <VoiceModeOverlay
                isOpen={isVoiceModeOpen}
                onClose={() => setIsVoiceModeOpen(false)}
                sendMessage={sendVoiceMessage}
                messages={messages}
                teamLeadId={activeChannel.teamLeadId}
              />
            </div>
          )}

          {/* Input */}
          {activeChannel && (
            <ColabInput
              activeChannel={activeChannel}
              isMobile={isMobile}
              isReconnecting={isReconnecting}
              typingUsers={typingUsers}
              replyingTo={replyingTo}
              setReplyingTo={setReplyingTo}
              crossChannelTarget={crossChannelTarget}
              setCrossChannelTarget={setCrossChannelTarget}
              pendingImages={pendingImages}
              removePendingImage={removePendingImage}
              replacePendingImage={replacePendingImage}
              formatFileSize={formatFileSize}
              getFileIcon={getFileIcon}
              mentionSuggestions={mentionSuggestions}
              mentionSelectedIndex={mentionSelectedIndex}
              insertMention={insertMention}
              emojiSuggestions={emojiSuggestions}
              emojiSelectedIndex={emojiSelectedIndex}
              insertEmoji={insertEmoji}
              slashSuggestions={slashSuggestions}
              slashSelectedIndex={slashSelectedIndex}
              insertSlashCommand={insertSlashCommand}
              fileInputRef={fileInputRef}
              handleFileSelect={handleFileSelect}
              invalidMentions={invalidMentions}
              skipMentionValidationRef={skipMentionValidationRef}
              setInvalidMentions={setInvalidMentions}
              broadcastConfirmPending={broadcastConfirmPending}
              inputValue={inputValue}
              onChange={handleEditorChange}
              editor={editor}
              onEditorReady={handleEditorReady}
              handleKeyDown={handleKeyDown}
              handlePaste={handlePaste}
              onFilesAdded={queuePendingFiles}
              handleSend={handleSend}
              showDraftIndicator={!!inputValue.trim()}
              codeSuggestion={codeSuggestion}
              onAcceptCodeSuggestion={acceptCodeSuggestion}
              onDismissCodeSuggestion={dismissCodeSuggestion}
              onVoiceModeOpen={() => setIsVoiceModeOpen(true)}
            />
          )}
        </div>
      </div>

      {/* Roles Modal */}
      <RolesModal
        show={showRolesModal}
        onClose={() => setShowRolesModal(false)}
        roles={roles}
        fetchRoles={fetchRoles}
      />

      {/* Image Lightbox Modal */}
      <ImageLightboxModal
        lightboxImage={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />


      {/* Keep Alive Modal */}
      {keepAliveParticipant && activeChannel && (() => {
        const roster = getRosterAgent(keepAliveParticipant.id);
        return roster ? (
          <KeepAliveModal
            participant={keepAliveParticipant}
            channelId={activeChannel.id}
            agentId={roster.id}
            onClose={() => setKeepAliveParticipant(null)}
            onStarted={() => {
              setKeepAliveAgentIds(prev => new Set([...prev, roster.id]));
            }}
            onStopped={() => {
              setKeepAliveAgentIds(prev => {
                const next = new Set(prev);
                next.delete(roster.id);
                return next;
              });
            }}
          />
        ) : null;
      })()}
    </div>
  );
}

/**
 * ColabTrigger - Button to open the collaboration panel
 */
interface ColabTriggerProps {
  onClick: () => void;
  hasActiveChannel?: boolean;
  participantCount?: number;
}

export function ColabTrigger({ onClick, hasActiveChannel, participantCount }: ColabTriggerProps) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
        hasActiveChannel
          ? 'bg-blue-500/20 text-blue-400'
          : 'bg-white/5 text-muted hover:bg-white/10 hover:text-white'
      }`}
      title="Open Projects Panel"
    >
      <Users className="w-4 h-4" />
      <span>Colab</span>
      {participantCount && participantCount > 0 && (
        <span className="bg-blue-500/30 px-1.5 py-0.5 rounded-full text-[10px] font-medium">
          {participantCount}
        </span>
      )}
    </button>
  );
}
