'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Loader2,
  Crown,
  Plug,
  Check,
  Activity,
  Undo2,
  UserMinus,
  Monitor,
  RotateCcw,
  ExternalLink,
  UserPlus,
  Plus,
  Radio,
  Settings,
  Square,
  Trash2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Minimize2,
  Replace,
  Play,
} from 'lucide-react';
import { AgentStreamDrawer } from './collab/agent-stream';
import { buildContextHealthMap, selectLiveHealth, type ContextHealth } from '@/lib/context-health/merge';
import { getPlatformLogo } from '@/lib/platform-logos';
import { ModelEmblem } from './ModelEmblem';
import { emblemState, emblemFamily, type EmblemState } from '@/lib/model-emblem';
import { useLaptopAgents } from './useLaptopAgents';
import { laptopTooltip, type LaptopMode } from '@/lib/laptop-agents';
import { HarnessSignInModal } from './modals/HarnessSignInModal';
import { healthBadgeText, isHealthFresh, type HarnessHealth } from '@/lib/harness-auth';
import { selectSwitchTargets } from '@/lib/model-switch/selectable';
import type {
  CollabChannel,
  CollabParticipant,
  AgentRosterEntry,
  AgentRole,
  Project,
} from '@/lib/types';
import type { ModelEntry } from './colab-types';
import { useToast } from '@/lib/contexts/ToastContext';
import { resolveActivityLabel } from '@/lib/activity-label';
import { getModelLabel, isReasoningOnlyModel } from '@/lib/model-label';
import { AddAgentModal } from './modals/AddAgentModal';
import { PRODUCT_NAME } from '@/lib/brand';

export interface ColabRightPanelProps {
  activeChannel: CollabChannel | null;
  participantId: string | null;
  isMobile: boolean;
  isMobileRightPanelOpen: boolean;
  setIsMobileRightPanelOpen: (open: boolean) => void;
  kickedParticipants: CollabParticipant[];
  setKickedParticipants: React.Dispatch<React.SetStateAction<CollabParticipant[]>>;
  typingParticipants: Array<{ participantId: string; participantName: string; startedAt: number; activity?: 'typing' | 'working'; activityDetail?: string | null }>;
  agentUsage: Record<string, { total: number; input: number; output: number; thinking: number }>;
  keepAliveAgentIds: Set<string>;
  roles: AgentRole[];
  projects: Project[];
  respawningAgentId: string | null;
  renamingParticipantId: string | null;
  setRenamingParticipantId: (id: string | null) => void;
  renameValue: string;
  setRenameValue: (val: string) => void;
  editingMyName: boolean;
  setEditingMyName: (val: boolean) => void;
  myNewName: string;
  setMyNewName: (val: string) => void;
  showRosterSpawn: boolean;
  setShowRosterSpawn: (val: boolean) => void;
  modelRegistry: ModelEntry[];
  setConfigModalAgentId: (id: string | null) => void;
  frozenParticipantIds: Set<string>;
  onParticipantContextMenu: (e: React.MouseEvent, p: CollabParticipant, isAgent: boolean) => void;
  rosterActionButtons: React.ReactNode;
  fetchData: () => void;
  fetchRoles: () => void;
  getRosterAgent: (participantId: string) => AgentRosterEntry | undefined;
  handleRemoveParticipant: (pId: string) => void;
  handleRecallAgent: (pId: string) => void;
  handleMakeTeamLead: (pId: string) => void;
  handleRenameMyself: (newName: string) => void;
  handleRenameParticipant: (pId: string, newName: string) => void;
  handleReinviteParticipant: (participant: CollabParticipant) => void;
  handleDetachAgent: (participant: CollabParticipant) => void;
  handleRosterKill: (agentId: string) => void;
  handleRosterRespawn: (agentId: string, fresh?: boolean, rehydrate?: boolean) => void;
  handleRosterOpenTerminal: (agentId: string) => void;
  handleRosterRemove: (agentId: string) => void;
}


// Context meter (Midnight Glass bar plus the number). Blue normally; red from 80% so a nearly-full agent is obvious.
function ContextHealthBar({ health }: { health: { percent: number; turnCount: number; model: string; reportedAt: string } }) {
  const pct = Math.min(100, Math.max(0, Math.round(health.percent)));
  return (
    <div className="mg-agent__ctx" title={`Context window ${pct}% used (turn ${health.turnCount})`}>
      <div className={`mg-bar ${pct >= 80 ? 'mg-bar--hot' : ''}`}><i style={{ width: `${pct}%` }} /></div>
      <span className="mg-agent__pct">ctx {pct}%</span>
    </div>
  );
}

// "Remote" tag for agents that run on the DevFlow server. Nothing is shown for desktop agents.
function LaptopBadge({ mode }: { mode: LaptopMode | null }) {
  return <span className="mg-tag" title={laptopTooltip(mode)}>Remote</span>;
}

// Badge for an agent whose harness login is broken or at its limit. Clicking opens the sign-in dialog for that login.
function HealthBadge({ health, onOpen }: { health: HarnessHealth; onOpen: (credentialId: string) => void }) {
  // If the watcher stops reporting, nothing else would clear the badge: hide a report older than 15 minutes.
  if (!isHealthFresh(health)) return null;
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onOpen(health.credentialId); }}
      className="mg-tag mg-tag--danger"
      title={`${health.detail || healthBadgeText(health)}. Click for details.`}
    >
      {healthBadgeText(health)}
    </button>
  );
}

// Same row when the agent hasn't reported yet, so a card keeps its height.
function ContextUnknown() {
  return (
    <div className="mg-agent__ctx" title="No context reading yet">
      <div className="mg-bar" />
      <span className="mg-agent__pct">ctx —</span>
    </div>
  );
}

type CardState = 'ready' | 'working' | 'offline' | 'starting' | 'frozen' | 'away';
const PIP: Record<CardState, string> = { ready: 'online', working: 'working', offline: 'offline', starting: 'offline', frozen: 'frozen', away: 'offline' };

// Colour family for the model tag: the kit has blue, indigo and sky.
function modelTint(model: string | null | undefined): '' | 'indigo' | 'sky' {
  const family = emblemFamily(model);
  return family === 'openai' || family === 'grok' ? 'indigo' : family === 'gemini' || family === 'deepseek' ? 'sky' : '';
}

// Status text rolls up and swaps when an agent changes between ready, thinking, using a tool and so on.
function StatusRoll({ k, children }: { k: string; children: React.ReactNode }) {
  const [shown, setShown] = useState<{ k: string; node: React.ReactNode }>({ k, node: children });
  const [roll, setRoll] = useState<{ from: React.ReactNode; to: React.ReactNode } | null>(null);
  const latest = React.useRef(children);
  latest.current = children;
  useEffect(() => {
    if (k === shown.k) { setShown(prev => (prev.node === children ? prev : { k, node: children })); return; }
    const calm = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (calm) { setShown({ k, node: children }); return; }
    setRoll({ from: shown.node, to: children });
    const timer = setTimeout(() => { setShown({ k, node: latest.current }); setRoll(null); }, 560);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k, children]);
  if (roll) return <span className="mg-roll"><span className="mg-roll__in"><span>{roll.from}</span><span>{roll.to}</span></span></span>;
  return <>{shown.k === k ? children : shown.node}</>;
}

interface CardTool { key: string; tip: string; icon: React.ReactNode; onClick: (e: React.MouseEvent) => void; disabled?: boolean; danger?: boolean; on?: boolean }

interface AgentCardProps {
  cardKey: string;
  name: string;
  state: CardState;
  statusText: string;
  statusTitle: string;
  role: string;
  model: string | null | undefined;
  modelLabel: string;
  emblem: EmblemState;
  lead?: boolean;
  integration?: boolean;
  keepAlive?: boolean;
  nameNode?: React.ReactNode;
  nameBadges?: React.ReactNode;
  badges?: React.ReactNode;
  ctx?: React.ReactNode;
  tools: CardTool[];
  mobileActions?: React.ReactNode;
  onContextMenu?: (e: React.MouseEvent) => void;
}

function AgentCard(c: AgentCardProps) {
  const tint = modelTint(c.model);
  const status = c.state === 'working'
    ? <span className="mg-wave" aria-label={c.statusText}>{c.statusText.replace(/(…|\.{3})$/, '')}<b aria-hidden="true">•</b><b aria-hidden="true">•</b><b aria-hidden="true">•</b></span>
    : c.state === 'ready' ? <><i className="mg-dot mg-dot--online" />{c.statusText}</>
    : c.state === 'starting' ? <><i className="mg-spin" />{c.statusText}</>
    : c.state === 'frozen' ? <><i className="mg-dot-error" />{c.statusText}</>
    : <><i className="mg-dot mg-dot--offline" />{c.statusText}</>;
  return (
    <div className={`mg-agent${c.state === 'ready' || c.state === 'working' || c.state === 'offline' ? ` mg-agent--${c.state}` : ''}${tint ? ` mg-agent--${tint}` : ''}`} onContextMenu={c.onContextMenu}>
      <div className="mg-agent__av">
        <ModelEmblem model={c.model} state={c.emblem} size={36} fallback={getPlatformLogo(c.model)} />
        <span className={`mg-pip mg-pip--${PIP[c.state]}`} title={c.statusTitle} />
      </div>
      <div className="mg-agent__body">
        <div className="mg-agent__row">
          {c.nameNode ?? (
            <span className="mg-agent__name">
              <span className="truncate">{c.name}</span>
              {c.lead && <span title="Team Lead" className="flex-shrink-0"><Crown size={16} strokeWidth={1.5} /></span>}
              {c.integration && <span title={`${PRODUCT_NAME} Integration Agent`} className="flex-shrink-0"><Plug size={14} strokeWidth={1.5} /></span>}
              {c.keepAlive && <span title="Keep Alive active" className="flex-shrink-0"><Activity size={14} strokeWidth={1.5} /></span>}
              {c.nameBadges}
            </span>
          )}
          <span className="mg-agent__status" title={c.statusTitle}><StatusRoll k={`${c.state}:${c.statusText}`}>{status}</StatusRoll></span>
        </div>
        <div className="mg-agent__meta">
          {c.role && <span className="mg-agent__role">{c.role}</span>}
          {c.badges}
          {c.modelLabel && <span className="mg-tag mg-tag--model">{c.modelLabel}</span>}
        </div>
        {c.ctx}
      </div>
      {c.tools.length > 0 && (
        <div className="mg-toolbar" role="toolbar" aria-label={`Actions for ${c.name}`}>
          {c.tools.map(tool => (
            <button
              key={tool.key}
              type="button"
              className={`mg-tool${tool.on ? ' mg-tool--on' : ''}${tool.danger ? ' mg-tool--danger' : ''}`}
              data-tip={tool.tip}
              aria-label={tool.tip}
              aria-pressed={tool.on}
              disabled={tool.disabled}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={tool.onClick}
            >
              {tool.icon}
            </button>
          ))}
        </div>
      )}
      {c.mobileActions}
    </div>
  );
}

// One line describing the row's state for the header count and the collapsed rail.
type RowState = 'working' | 'online' | 'away' | 'frozen' | 'starting' | 'stopped' | 'offline';

// ---------------------------------------------------------------------------
// Unified row model — one merged sort each render
// ---------------------------------------------------------------------------

interface UnifiedRow {
  participant: CollabParticipant | null;
  rosterAgent: AgentRosterEntry | undefined;
  sortKey: number;   // 0–5, lower = higher in the list
  isRosterOnly: boolean;
  isKicked: boolean;
}

function computeSortKey(
  p: CollabParticipant,
  ra: AgentRosterEntry | undefined,
  teamLeadId: string | undefined,
): number {
  const isHuman = p.type === 'user';
  if (isHuman) return 0;
  if (p.id === teamLeadId) return 1;
  if (ra) {
    const isOnline = ra.status === 'running' || ra.status === 'starting' || ra.status === 'shutting-down' || ra.status === 'restarting';
    return isOnline ? 2 : 3;
  }
  return 4; // agent participant without roster
}

export function ColabRightPanel({
  activeChannel,
  participantId,
  isMobile,
  isMobileRightPanelOpen,
  setIsMobileRightPanelOpen,
  kickedParticipants,
  setKickedParticipants,
  typingParticipants,
  agentUsage,
  keepAliveAgentIds,
  roles,
  projects,
  respawningAgentId,
  renamingParticipantId,
  setRenamingParticipantId,
  renameValue,
  setRenameValue,
  editingMyName,
  setEditingMyName,
  myNewName,
  setMyNewName,
  showRosterSpawn,
  setShowRosterSpawn,
  modelRegistry,
  setConfigModalAgentId,
  frozenParticipantIds,
  onParticipantContextMenu,
  rosterActionButtons,
  fetchData,
  fetchRoles,
  getRosterAgent,
  handleRemoveParticipant,
  handleRecallAgent,
  handleMakeTeamLead,
  handleRenameMyself,
  handleRenameParticipant,
  handleReinviteParticipant,
  handleDetachAgent,
  handleRosterKill,
  handleRosterRespawn,
  handleRosterOpenTerminal,
  handleRosterRemove,
}: ColabRightPanelProps) {
  const [watchedAgent, setWatchedAgent] = useState<string | null>(null);
  // T1 (Realtime Context Bar): the bar's roster value only refreshes on the
  // heavyweight 30s channel fullRefresh; poll the purpose-built endpoint on a
  // short cadence so the % is live without a restart. Keyed by agentId.
  const [liveHealth, setLiveHealth] = useState<Record<string, ContextHealth>>({});
  // P3.1 Model Switcher: which agent's switch-model picker is open, and which
  // agent is mid-switch (handover in flight).
  const [switchPicker, setSwitchPicker] = useState<{ agent: AgentRosterEntry; top: number; right: number } | null>(null);
  const [switchingAgentId, setSwitchingAgentId] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [signInCredentialId, setSignInCredentialId] = useState<string | null>(null);
  const [compactingAgentIds, setCompactingAgentIds] = useState<Set<string>>(new Set());
  const { toast } = useToast();
  // The laptop's mode only matters for the badge tooltip, so ask only when some agent runs there.
  const anyOnLaptop = (activeChannel?.roster?.agents ?? []).some(agent => agent.runLocation === 'server');
  const laptop = useLaptopAgents(anyOnLaptop);

  // T1 (Realtime Context Bar): poll the live context-health endpoint every 10s
  // and merge into the bar, so it updates without an agent/session restart.
  useEffect(() => {
    const channelId = activeChannel?.id;
    if (!channelId) {
      setLiveHealth({});
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/agent/context-health?channelId=${encodeURIComponent(channelId)}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data?.success) return;
        setLiveHealth(buildContextHealthMap(data.agents));
      } catch {
        // best-effort — the bar falls back to the roster value
      }
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeChannel?.id]);

  const handleCompactAgent = async (agentId: string, agentName: string) => {
    setCompactingAgentIds(prev => new Set(prev).add(agentId));
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'roster.compactAgent', channelId: activeChannel?.id, agentId }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`Compact sent to ${agentName}`);
      } else {
        toast.error(data.error || 'Failed to send compact');
      }
    } catch {
      toast.error('Network error — compact request failed');
    } finally {
      setCompactingAgentIds(prev => { const next = new Set(prev); next.delete(agentId); return next; });
    }
  };

  // P3.1: hot-switch a live agent to another model. Calls Worf's backend
  // (summarize → respawn on new model → handoff/primer). Picker only offers
  // valid targets, so no same-model/unregistered errors originate in the UI.
  // Open the picker anchored to the clicked button (portaled to document.body
  // so it escapes the roster's overflow/scroll clipping). Toggles closed if the
  // same agent's picker is already open.
  const openSwitchPicker = (agent: AgentRosterEntry, e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setSwitchPicker(prev =>
      prev?.agent.id === agent.id
        ? null
        : { agent, top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) },
    );
  };

  const handleSwitchModel = async (agent: AgentRosterEntry, targetModel: string) => {
    setSwitchPicker(null);
    setSwitchingAgentId(agent.id);
    try {
      const res = await fetch('/api/agent/switch-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: activeChannel?.id, agentId: agent.id, targetModel }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(`Switching ${agent.name} → ${getModelLabel(targetModel, modelRegistry)}`);
      } else {
        toast.error(data.error || `Model switch failed (HTTP ${res.status})`);
      }
    } catch {
      toast.error('Network error — model switch failed');
    } finally {
      setSwitchingAgentId(null);
    }
  };

  // Close the switch-model picker on outside click or Escape.
  useEffect(() => {
    if (!switchPicker) return;
    const close = () => setSwitchPicker(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [switchPicker]);

  useEffect(() => {
    setWatchedAgent(null);
  }, [activeChannel?.id]);

  // ── Unified merged rows ──────────────────────────────────────────────
  const unifiedRows = useMemo<UnifiedRow[]>(() => {
    const rows: UnifiedRow[] = [];
    const participants = activeChannel?.participants ?? [];
    const rosterAgents = activeChannel?.roster?.agents ?? [];
    const rosterMatchedAgentIds = new Set<string>();

    for (const p of participants) {
      if (p.source === 'Codex Desktop Bridge') continue;
      // The roster lists the team; people (you) are not shown in it.
      if (p.type === 'user') continue;
      const ra = rosterAgents.find(a => a.participantId === p.id)
        ?? (p.name ? rosterAgents.find(a => a.name === p.name) : undefined);
      if (ra) rosterMatchedAgentIds.add(ra.id);
      rows.push({
        participant: p,
        rosterAgent: ra,
        sortKey: computeSortKey(p, ra, activeChannel?.teamLeadId),
        isRosterOnly: false,
        isKicked: false,
      });
    }

    // Roster-only agents (in roster but no active participant)
    for (const agent of rosterAgents) {
      if (!rosterMatchedAgentIds.has(agent.id)) {
        rows.push({
          participant: null,
          rosterAgent: agent,
          sortKey: 5,
          isRosterOnly: true,
          isKicked: false,
        });
      }
    }

    // Kicked participants
    for (const kp of kickedParticipants) {
      rows.push({
        participant: kp,
        rosterAgent: undefined,
        sortKey: 6,
        isRosterOnly: false,
        isKicked: true,
      });
    }

    rows.sort((a, b) => {
      if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
      const aName = a.participant?.name ?? a.rosterAgent?.name ?? '';
      const bName = b.participant?.name ?? b.rosterAgent?.name ?? '';
      return aName.localeCompare(bName);
    });

    return rows;
  }, [activeChannel, kickedParticipants]);

  if (!activeChannel) return null;

  const hasRoster = (activeChannel?.roster?.agents?.length ?? 0) > 0;
  const activeProject = activeChannel.projectId
    ? projects.find((project) => project.id === activeChannel.projectId)
    : null;
  const projectDirectory = activeChannel.projectPath?.trim() || activeProject?.path?.trim() || '';

  // One state per agent row, shared by the header summary and the collapsed rail.
  const stateOfRow = (row: UnifiedRow): RowState | null => {
    if (row.isKicked) return null;
    if (row.isRosterOnly && row.rosterAgent) {
      const st = row.rosterAgent.status;
      if (st === 'running') return 'online';
      if (st === 'starting' || st === 'shutting-down' || st === 'restarting') return 'starting';
      return 'stopped';
    }
    const part = row.participant;
    if (!part || part.type === 'user') return null;
    const entry = typingParticipants.find(t => t.participantId === part.id);
    const active = entry?.activity === 'typing' || entry?.activity === 'working';
    const rs = row.rosterAgent?.status;
    if (rs === 'stopped' || rs === 'crashed') return active ? 'working' : 'stopped';
    if (rs === 'starting' || rs === 'shutting-down' || rs === 'restarting') return 'starting';
    if (part.status === 'away' && part.awayInChannelId) return 'away';
    if (active) return 'working';
    const st = part.status || (Date.now() - new Date(part.lastSeen).getTime() < 900000 ? 'online' : 'offline');
    if (st !== 'online') return 'offline';
    return frozenParticipantIds.has(part.id) ? 'frozen' : 'online';
  };
  const rowStates = unifiedRows.map(stateOfRow);
  const workingCount = rowStates.filter(st => st === 'working').length;
  const onlineCount = rowStates.filter(st => st === 'working' || st === 'online' || st === 'frozen').length;
  // ── Cards ──────────────────────────────────────────────────────────────
  const roleLabel = (agent: AgentRosterEntry | undefined) => (agent?.roleId ? roles.find(r => r.id === agent.roleId)?.name || 'Unknown' : '');
  const reasoningBadge = (agent: AgentRosterEntry | undefined) => (agent?.model && isReasoningOnlyModel(agent.model, modelRegistry)
    ? <span className="mg-tag" title="Reasoning-only model — no tool use or streaming">reasoning-only</span> : null);
  const iconProps = { size: 16, strokeWidth: 1.5 } as const;

  const renderRow = (row: UnifiedRow): { group: 'online' | 'offline' | 'removed'; node: React.ReactNode } => {
    // ── Kicked rows (removed from the channel): name, re-invite, dismiss ──
    if (row.isKicked) {
      const p = row.participant!;
      return {
        group: 'removed',
        node: (
          <div key={`kicked-${p.id}`} className="mg-agent mg-agent--offline">
            <div className="mg-agent__av">{getPlatformLogo(null)}<span className="mg-pip mg-pip--offline" title="Removed" /></div>
            <div className="mg-agent__body">
              <div className="mg-agent__row"><span className="mg-agent__name"><span className="truncate">{p.displayName || p.name}</span></span></div>
              <div className="mg-agent__meta"><span className="mg-agent__role">{p.source}</span></div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => handleReinviteParticipant(p)} className="mg-btn mg-btn--ghost mg-btn--sm"><UserPlus size={14} strokeWidth={1.5} />Re-invite</button>
                <button onClick={() => setKickedParticipants(prev => prev.filter(kp => kp.id !== p.id))} className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Dismiss ${p.displayName || p.name}`}><X size={14} strokeWidth={1.5} /></button>
              </div>
            </div>
          </div>
        ),
      };
    }

    // ── Roster-only rows (in the roster, no participant in this channel) ──
    if (row.isRosterOnly && row.rosterAgent) {
      const agent = row.rosterAgent;
      const isRunning = agent.status === 'running';
      const isStopped = agent.status === 'stopped' || agent.status === 'crashed';
      const isStarting = agent.status === 'starting';
      const isTransitioning = agent.status === 'shutting-down' || agent.status === 'restarting';
      const state: CardState = isRunning ? 'ready' : (isStarting || isTransitioning) ? 'starting' : 'offline';
      const statusLabel = isRunning ? 'Ready' : isTransitioning ? (agent.status === 'shutting-down' ? 'Shutting down…' : 'Restarting…') : isStarting ? 'Starting…' : 'Offline';
      const tools: CardTool[] = [];
      if (isRunning) {
        tools.push({ key: 'stop', tip: 'Stop', icon: <Square {...iconProps} />, onClick: () => handleRosterKill(agent.id) });
        tools.push({ key: 'respawn', tip: 'Respawn', icon: <RotateCcw {...iconProps} className={respawningAgentId === agent.id ? 'animate-spin' : ''} />, onClick: () => handleRosterRespawn(agent.id), disabled: respawningAgentId === agent.id });
        tools.push({ key: 'terminal', tip: agent.runLocation === 'server' ? 'Open a window on this PC that connects to the agent on the remote server' : 'Open terminal', icon: <Monitor {...iconProps} />, onClick: () => handleRosterOpenTerminal(agent.id) });
        tools.push({ key: 'logs', tip: watchedAgent === agent.name ? 'Close live feed' : 'View live logs', icon: <Radio {...iconProps} />, onClick: () => setWatchedAgent(watchedAgent === agent.name ? null : agent.name), on: watchedAgent === agent.name });
        tools.push({ key: 'switch', tip: 'Switch model', icon: switchingAgentId === agent.id ? <Loader2 {...iconProps} className="animate-spin" /> : <Replace {...iconProps} />, onClick: (e) => { e.stopPropagation(); openSwitchPicker(agent, e); }, disabled: switchingAgentId === agent.id });
      } else {
        tools.push({ key: 'start', tip: isStopped ? `Start ${agent.name}` : 'Respawn', icon: respawningAgentId === agent.id ? <Loader2 {...iconProps} className="animate-spin" /> : <Play {...iconProps} />, onClick: (e) => { e.stopPropagation(); handleRosterRespawn(agent.id); }, disabled: respawningAgentId === agent.id });
        tools.push({ key: 'rehydrate', tip: 'Respawn & Rehydrate', icon: <RefreshCw {...iconProps} className={respawningAgentId === agent.id ? 'animate-spin' : ''} />, onClick: () => handleRosterRespawn(agent.id, true, true), disabled: respawningAgentId === agent.id });
      }
      tools.push({ key: 'config', tip: 'Settings', icon: <Settings {...iconProps} />, onClick: (e) => { e.stopPropagation(); setConfigModalAgentId(agent.id); } });
      tools.push({ key: 'remove', tip: 'Remove from roster', icon: <Trash2 {...iconProps} />, danger: true, onClick: () => { if (confirm(`Remove ${agent.name} from roster?`)) { handleRosterRemove(agent.id); } } });
      const health = isRunning ? selectLiveHealth(liveHealth[agent.id], agent.lastContextHealth) : null;
      return {
        group: state === 'offline' ? 'offline' : 'online',
        node: (
          <AgentCard
            key={`ro-${agent.id}`}
            cardKey={`ro-${agent.id}`}
            name={agent.name}
            state={state}
            statusText={statusLabel}
            statusTitle={statusLabel}
            role={roleLabel(agent)}
            model={agent.model}
            modelLabel={agent.model ? getModelLabel(agent.model, modelRegistry) : ''}
            emblem="idle"
            nameBadges={agent.runLocation === 'server' ? <LaptopBadge mode={laptop.mode} /> : null}
            badges={<>{agent.harnessHealth && <HealthBadge health={agent.harnessHealth} onOpen={setSignInCredentialId} />}{reasoningBadge(agent)}</>}
            ctx={isRunning ? (health ? <ContextHealthBar health={health} /> : <ContextUnknown />) : null}
            tools={tools}
            mobileActions={isMobile ? (
              <div className="mg-agent__mobile">
                {!isRunning && <button type="button" onClick={(e) => { e.stopPropagation(); handleRosterRespawn(agent.id); }} disabled={respawningAgentId === agent.id} className="mg-btn mg-btn--ghost mg-btn--sm"><Play size={14} strokeWidth={1.5} />Start</button>}
                {isRunning && <button type="button" onClick={() => setWatchedAgent(watchedAgent === agent.name ? null : agent.name)} aria-pressed={watchedAgent === agent.name} className="mg-btn mg-btn--ghost mg-btn--sm"><Radio size={14} strokeWidth={1.5} />Live</button>}
                <button type="button" onClick={(e) => { e.stopPropagation(); setConfigModalAgentId(agent.id); }} className="mg-btn mg-btn--ghost mg-btn--sm"><Settings size={14} strokeWidth={1.5} />Config</button>
              </div>
            ) : null}
          />
        ),
      };
    }

    // ── Participant rows (with or without roster) ──────────────────────
    const p = row.participant!;
    const ra = row.rosterAgent;
    const typingEntry = typingParticipants.find(t => t.participantId === p.id);
    const isTyping = typingEntry?.activity === 'typing';
    const isWorking = typingEntry?.activity === 'working';
    const activityLabel = resolveActivityLabel(typingEntry?.activityDetail, isTyping || isWorking);
    const status = p.status || (Date.now() - new Date(p.lastSeen).getTime() < 900000 ? 'online' : 'offline');
    const isPtyManaged = p.source?.includes('PTY') || p.type === 'claude-browser';
    const isAgent = p.type !== 'user';
    const isFrozen = isAgent && status === 'online' && !isTyping && !isWorking && frozenParticipantIds.has(p.id);
    const isAway = p.status === 'away' && !!p.awayInChannelId;
    const rosterStatus = ra?.status;
    const isStopped = rosterStatus === 'stopped' || rosterStatus === 'crashed';
    const isStarting = rosterStatus === 'starting';
    const isShuttingDown = rosterStatus === 'shutting-down' || rosterStatus === 'restarting';
    const isRunning = rosterStatus === 'running';
    const isActivelyWorking = (isWorking || isTyping) && isAgent;
    const compact = isStopped && !(isWorking || isTyping);
    const hasRosterRunning = !!ra && isRunning;
    const hasRosterStopped = !!ra && (isStopped || isStarting || isShuttingDown);

    const state: CardState = compact ? 'offline'
      : isFrozen ? 'frozen'
      : isActivelyWorking ? 'working'
      : isAway ? 'away'
      : (isStarting || isShuttingDown) ? 'starting'
      : (isAgent && status === 'offline') ? 'offline'
      : 'ready';
    const frozenTitle = `Unresponsive — has unread @mentions${p.lastRead ? `, last read ${Math.round((Date.now() - new Date(p.lastRead).getTime()) / 60000)}m ago` : ''}`;
    const awayTitle = `Away${p.awayInChannelName ? ` in ${p.awayInChannelName}` : ''}`;
    const transitionText = rosterStatus === 'shutting-down' ? 'Shutting down…' : rosterStatus === 'restarting' ? 'Restarting…' : 'Starting…';
    const statusText = state === 'working' ? (activityLabel || 'Working…') : state === 'frozen' ? 'Frozen' : state === 'away' ? 'Away' : state === 'starting' ? transitionText : state === 'offline' ? 'Offline' : 'Ready';
    const statusTitle = state === 'frozen' ? frozenTitle : state === 'away' ? awayTitle : state === 'ready' ? 'Online and waiting for work' : statusText;

    const tools: CardTool[] = [];
    if (isAway) tools.push({ key: 'recall', tip: 'Bring back', icon: <Undo2 {...iconProps} />, onClick: () => handleRecallAgent(p.id) });
    if (hasRosterRunning) {
      tools.push({ key: 'stop', tip: 'Stop', icon: <Square {...iconProps} />, onClick: () => handleRosterKill(ra!.id) });
      tools.push({ key: 'switch', tip: 'Switch model', icon: switchingAgentId === ra!.id ? <Loader2 {...iconProps} className="animate-spin" /> : <Replace {...iconProps} />, onClick: (e) => { e.stopPropagation(); openSwitchPicker(ra!, e); }, disabled: switchingAgentId === ra!.id });
    }
    if (hasRosterStopped) {
      if (compact) tools.push({ key: 'start', tip: `Start ${p.displayName || p.name}`, icon: respawningAgentId === ra!.id ? <Loader2 {...iconProps} className="animate-spin" /> : <Play {...iconProps} />, onClick: (e) => { e.stopPropagation(); handleRosterRespawn(ra!.id); }, disabled: respawningAgentId === ra!.id });
      else tools.push({ key: 'respawn', tip: 'Respawn', icon: <RotateCcw {...iconProps} className={respawningAgentId === ra!.id ? 'animate-spin' : ''} />, onClick: () => handleRosterRespawn(ra!.id), disabled: respawningAgentId === ra!.id });
      tools.push({ key: 'rehydrate', tip: 'Respawn & Rehydrate', icon: <RefreshCw {...iconProps} className={respawningAgentId === ra!.id ? 'animate-spin' : ''} />, onClick: () => handleRosterRespawn(ra!.id, true, true), disabled: respawningAgentId === ra!.id });
    }
    if (ra && ra.tmuxSessionName) tools.push({ key: 'terminal', tip: ra.runLocation === 'server' ? 'Open a window on this PC that connects to the agent on the remote server' : 'Open terminal', icon: <Monitor {...iconProps} />, onClick: () => handleRosterOpenTerminal(ra!.id) });
    if (isPtyManaged && !ra) tools.push({ key: 'detach', tip: 'Detach agent', icon: <ExternalLink {...iconProps} />, onClick: () => handleDetachAgent(p) });
    if (ra) tools.push({ key: 'config', tip: 'Settings', icon: <Settings {...iconProps} />, onClick: (e) => { e.stopPropagation(); setConfigModalAgentId(ra.id); } });
    if (isAgent) tools.push({ key: 'logs', tip: watchedAgent === p.name ? 'Close live feed' : 'View live logs', icon: <Radio {...iconProps} />, onClick: (e) => { e.stopPropagation(); setWatchedAgent(watchedAgent === p.name ? null : p.name); }, on: watchedAgent === p.name });
    tools.push({ key: 'remove', tip: 'Remove from channel', icon: <UserMinus {...iconProps} />, danger: true, onClick: () => handleRemoveParticipant(p.id) });

    const health = ra && !compact ? selectLiveHealth(liveHealth[ra.id], ra.lastContextHealth) : null;
    const role = roleLabel(ra) || (isAgent && status !== 'online' ? '' : p.source || '');
    const renaming = renamingParticipantId === p.id;
    const nameNode = renaming ? (
      <span className="mg-agent__name">
        <input
          type="text" value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleRenameParticipant(p.id, renameValue); else if (e.key === 'Escape') { setRenamingParticipantId(null); setRenameValue(''); } }}
          autoFocus
          aria-label={`New name for ${p.displayName || p.name}`}
          className="mg-rename"
          placeholder="New name"
        />
        <button onClick={() => handleRenameParticipant(p.id, renameValue)} className="mg-tool" aria-label="Save name" title="Save"><Check size={16} strokeWidth={1.5} /></button>
        <button onClick={() => { setRenamingParticipantId(null); setRenameValue(''); }} className="mg-tool" aria-label="Cancel rename" title="Cancel"><X size={16} strokeWidth={1.5} /></button>
      </span>
    ) : undefined;

    return {
      group: state === 'offline' ? 'offline' : 'online',
      node: (
        <AgentCard
          key={p.id}
          cardKey={p.id}
          name={p.displayName || p.name}
          nameNode={nameNode}
          state={state}
          statusText={statusText}
          statusTitle={statusTitle}
          role={role}
          model={ra?.model}
          modelLabel={ra?.model ? getModelLabel(ra.model, modelRegistry) : ''}
          emblem={isActivelyWorking ? emblemState(typingEntry?.activity === 'typing' ? 'typing' : 'working', typingEntry?.activityDetail) : 'idle'}
          lead={activeChannel.teamLeadId === p.id}
          integration={p.name === 'DevFlow Integration'}
          keepAlive={!!ra && keepAliveAgentIds.has(ra.id)}
          nameBadges={ra?.runLocation === 'server' ? <LaptopBadge mode={laptop.mode} /> : null}
          badges={<>{ra?.harnessHealth && <HealthBadge health={ra.harnessHealth} onOpen={setSignInCredentialId} />}{isPtyManaged && <span className="mg-tag">PTY</span>}{reasoningBadge(ra)}</>}
          ctx={ra && !compact ? (health ? <ContextHealthBar health={health} /> : <ContextUnknown />) : null}
          tools={tools}
          onContextMenu={(e) => onParticipantContextMenu(e, p, isAgent)}
          mobileActions={isMobile && (isAgent || ra) ? (
            <div className="mg-agent__mobile">
              {compact && ra && <button type="button" onClick={(e) => { e.stopPropagation(); handleRosterRespawn(ra.id); }} disabled={respawningAgentId === ra.id} className="mg-btn mg-btn--ghost mg-btn--sm"><Play size={14} strokeWidth={1.5} />Start</button>}
              {isAgent && <button type="button" onClick={(e) => { e.stopPropagation(); setWatchedAgent(watchedAgent === p.name ? null : p.name); }} aria-pressed={watchedAgent === p.name} className="mg-btn mg-btn--ghost mg-btn--sm"><Radio size={14} strokeWidth={1.5} />{watchedAgent === p.name ? 'Close' : 'Live'}</button>}
              {ra && <button type="button" onClick={(e) => { e.stopPropagation(); setConfigModalAgentId(ra.id); }} className="mg-btn mg-btn--ghost mg-btn--sm"><Settings size={14} strokeWidth={1.5} />Config</button>}
            </div>
          ) : null}
        />
      ),
    };
  };

  const cards = unifiedRows.map(renderRow);
  const onlineCards = cards.filter(c => c.group === 'online').map(c => c.node);
  const offlineCards = cards.filter(c => c.group === 'offline').map(c => c.node);
  const removedCards = cards.filter(c => c.group === 'removed').map(c => c.node);

  return (
    <div key={activeChannel.id} className={`mg-scope mg-team transition-all duration-300 ease-in-out ${
      isMobile
        ? 'absolute inset-y-0 right-0 z-30 w-[88vw] max-w-[23rem] flex flex-col'
        : isCollapsed
          ? 'relative hidden md:flex flex-col items-center w-12 overflow-hidden pt-3 gap-3 flex-shrink-0'
          : 'relative hidden md:flex flex-col w-[18rem] flex-shrink-0'
    } ${isMobile && !isMobileRightPanelOpen ? 'translate-x-full' : ''} ${isMobile && isMobileRightPanelOpen ? 'translate-x-0' : ''}`}>
      <div className="mg-orbs" aria-hidden="true"><i /><i /><i /><i /></div>

      {/* Desktop collapsed — expand arrow, then one avatar per agent with its state pip */}
      {!isMobile && isCollapsed && (
        <>
          <button onClick={() => setIsCollapsed(false)} className="mg-iconbtn" title="Expand roster" aria-label="Expand roster">
            <ChevronLeft size={16} strokeWidth={1.5} />
          </button>
          <div className="mg-rail">
            {unifiedRows.map((row, idx) => {
              const st = rowStates[idx];
              if (!st) return null;
              const name = row.participant?.displayName || row.participant?.name || row.rosterAgent?.name || '';
              const typing = typingParticipants.find(t => t.participantId === row.participant?.id);
              const railState: CardState = st === 'working' ? 'working' : st === 'frozen' ? 'frozen' : (st === 'stopped' || st === 'offline' || st === 'away') ? 'offline' : st === 'starting' ? 'starting' : 'ready';
              return (
                <button
                  key={row.participant?.id ?? row.rosterAgent?.id ?? name}
                  onClick={() => setIsCollapsed(false)}
                  title={`${name} — ${st}`}
                  aria-label={`${name}, ${st}`}
                  className={`mg-rail__item mg-agent--${railState === 'working' ? 'working' : railState === 'offline' ? 'offline' : 'ready'}`}
                >
                  <span className="mg-agent__av">
                    <ModelEmblem model={row.rosterAgent?.model} state={st === 'working' ? emblemState(typing?.activity ?? 'working', typing?.activityDetail) : 'idle'} size={22} fallback={getPlatformLogo(row.rosterAgent?.model)} />
                    <span className={`mg-pip mg-pip--${PIP[railState]}`} />
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* ── Main panel content — hidden when desktop collapsed ── */}
      {(isMobile || !isCollapsed) && <>

      {/* ── Header: title and summary pill, Add and collapse, then the team controls ── */}
      <div className="mg-panel__top">
        <div className="mg-title">
          <div>
            <h1>Team</h1>
            <div className="mg-pill" role="status">
              {rowStates.every(st => st === null)
                ? 'No agents yet'
                : <><i className="mg-dot mg-dot--online" />{onlineCount} online · {workingCount} working</>}
            </div>
          </div>
          <div>
            <button
              onClick={() => { fetchRoles(); setShowRosterSpawn(true); }}
              className="mg-iconbtn"
              title="Add agent"
              aria-label="Add agent"
            >
              <Plus size={14} strokeWidth={1.5} />
            </button>
            {!isMobile && (
              <button onClick={() => setIsCollapsed(true)} className="mg-iconbtn" title="Collapse roster" aria-label="Collapse roster">
                <ChevronRight size={14} strokeWidth={1.5} />
              </button>
            )}
            {isMobile && (
              <button onClick={() => setIsMobileRightPanelOpen(false)} className="mg-iconbtn" title="Close roster" aria-label="Close roster">
                <X size={14} strokeWidth={1.5} />
              </button>
            )}
          </div>
        </div>
        {hasRoster && <div className="tm-bulk">{rosterActionButtons}</div>}
      </div>

      {/* Role-first Add Agent modal */}
      {showRosterSpawn && (
        <AddAgentModal
          channel={activeChannel}
          roles={roles}
          modelRegistry={modelRegistry}
          projectDirectory={projectDirectory}
          onClose={() => setShowRosterSpawn(false)}
          onRosterChanged={fetchData}
        />
      )}

      {/* ── Roster: Online and Offline groups ── */}
      <div className="tm-list">
        {onlineCards.length > 0 && <div className="mg-group mg-group--online"><i className="mg-dot mg-dot--online" />Online<em>{onlineCards.length}</em></div>}
        {onlineCards}
        {offlineCards.length > 0 && <div className="mg-group"><i className="mg-dot mg-dot--offline" />Offline<em>{offlineCards.length}</em></div>}
        {offlineCards}
        {removedCards.length > 0 && <div className="mg-group"><i className="mg-dot mg-dot--offline" />Removed<em>{removedCards.length}</em></div>}
        {removedCards}
        {unifiedRows.length === 0 && (
          <p className="mg-more">{hasRoster ? 'All roster agents are active above.' : 'No agents in roster. Use + to add one.'}</p>
        )}
      </div>

      {signInCredentialId && (
        <HarnessSignInModal credentialId={signInCredentialId} onClose={() => setSignInCredentialId(null)} onChanged={fetchData} />
      )}

      {/* Agent Live-Feed drawer */}
      <AgentStreamDrawer
        agent={watchedAgent}
        channelId={activeChannel.id}
        open={watchedAgent !== null}
        onClose={() => setWatchedAgent(null)}
      />

      {/* Switch-Model picker — portaled to document.body so it escapes the roster's overflow/scroll clipping; positioned off the button's rect. */}
      {switchPicker && createPortal(
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{ top: switchPicker.top, right: switchPicker.right }}
          className="mg-scope mg-menu mg-menu--compact mg-menu--float mg-menu--switch"
          role="menu"
          aria-label="Switch model"
        >
          <div className="mg-menu__head"><b>Switch model</b><small>{switchPicker.agent.name}</small></div>
          {(() => {
            const groups = selectSwitchTargets(modelRegistry, switchPicker.agent.model);
            if (groups.length === 0) {
              return <p className="mg-more">No other models available</p>;
            }
            return groups.map((group) => (
              <div key={group.agentType}>
                <div className="mg-label">{group.agentType}</div>
                {group.models.map((mdl) => (
                  <button
                    key={mdl.id}
                    role="menuitem"
                    onClick={() => handleSwitchModel(switchPicker.agent, mdl.id)}
                    className="mg-mi"
                  >
                    <span className="mg-tx">{mdl.label}</span>
                    {mdl.reasoningOnly && <span className="mg-tag">reasoning</span>}
                  </button>
                ))}
              </div>
            ));
          })()}
        </div>,
        document.body,
      )}

      </> /* end main panel content */}
    </div>
  );
}
