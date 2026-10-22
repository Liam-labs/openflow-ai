'use client';

import React from 'react';
import {
  Power,
  RotateCcw,
  Monitor,
  Activity,
  Crown,
  Pencil,
  UserMinus,
  Plus,
  Info,
  Trash2,
  Settings,
  Undo2,
  ExternalLink,
  Minimize2,
} from 'lucide-react';
import type { CollabChannel, CollabParticipant, AgentRosterEntry } from '@/lib/types';
import { harnessCanCompact, compactCommandFor } from '@/lib/harness-compact';

export interface ParticipantContextMenuProps {
  contextMenu: { x: number; y: number; participant: CollabParticipant };
  onClose: () => void;
  activeChannel: CollabChannel | null;
  respawningAgentId: string | null;
  keepAliveAgentIds: Set<string>;
  getRosterAgent: (participantId: string) => AgentRosterEntry | undefined;
  handleRosterKill: (agentId: string) => void;
  handleRosterRespawn: (agentId: string) => void;
  handleRosterOpenTerminal: (agentId: string) => void;
  handleRosterCompact: (agentId: string) => void;
  setKeepAliveParticipant: (participant: CollabParticipant) => void;
  handleMakeTeamLead: (participantId: string) => void;
  setRenamingParticipantId: (id: string) => void;
  setRenameValue: (v: string) => void;
  handleRemoveParticipant: (participantId: string) => void;
  handleRosterRemove: (agentId: string) => void;
  setActiveChannel: (updater: (prev: CollabChannel | null) => CollabChannel | null) => void;
  fetchData: () => void;
  onShowAgentDetails: (roster: AgentRosterEntry) => void;
  // Phase 1 — new actions
  handleRecallAgent: (pId: string) => void;
  handleDetachAgent: (participant: CollabParticipant) => void;
  setConfigModalAgentId: (id: string | null) => void;
}

export function ParticipantContextMenu({
  contextMenu,
  onClose,
  activeChannel,
  respawningAgentId,
  keepAliveAgentIds,
  getRosterAgent,
  handleRosterKill,
  handleRosterRespawn,
  handleRosterOpenTerminal,
  handleRosterCompact,
  setKeepAliveParticipant,
  handleMakeTeamLead,
  setRenamingParticipantId,
  setRenameValue,
  handleRemoveParticipant,
  handleRosterRemove,
  setActiveChannel,
  fetchData,
  onShowAgentDetails,
  handleRecallAgent,
  handleDetachAgent,
  setConfigModalAgentId,
}: ParticipantContextMenuProps) {
  const roster = getRosterAgent(contextMenu.participant.id);
  const isRunning = roster?.status === 'running';
  const isAway = contextMenu.participant.status === 'away' && !!contextMenu.participant.awayInChannelId;
  const isPtyManaged = contextMenu.participant.source?.includes('PTY') || contextMenu.participant.type === 'claude-browser';
  const hasNoRoster = !roster;

  const stateLabel = isAway ? 'Away' : roster ? (isRunning ? 'Ready' : roster.status === 'stopped' || roster.status === 'crashed' ? 'Offline' : 'Starting') : (contextMenu.participant.status === 'online' ? 'Ready' : 'Offline');
  const item = (
    key: string,
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    opts: { danger?: boolean; disabled?: boolean; title?: string; extra?: React.ReactNode; checked?: boolean } = {},
  ) => (
    <button
      key={key}
      role={opts.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={opts.checked}
      onClick={onClick}
      disabled={opts.disabled}
      title={opts.title}
      className={`mg-mi${opts.danger ? ' mg-mi--danger' : ''}`}
    >
      <span className="mg-ti">{icon}</span>
      <span className="mg-tx">{label}</span>
      {opts.extra}
    </button>
  );
  const ic = { size: 15, strokeWidth: 1.5 } as const;
  const running = !!roster && isRunning;
  const showCompact = running && roster!.spawnMode !== 'powershell' && harnessCanCompact(roster!.agentType);

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="mg-scope mg-menu mg-menu--compact mg-menu--float"
        role="menu"
        aria-label={`Actions for ${contextMenu.participant.displayName || contextMenu.participant.name}`}
        style={{
          left: Math.max(8, Math.min(contextMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1920) - 280)),
          top: Math.max(8, Math.min(contextMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 1080) - 520)),
          maxHeight: 'calc(100vh - 16px)',
          overflowY: 'auto',
        }}
      >
        <div className="mg-menu__head">
          <b title={contextMenu.participant.displayName || contextMenu.participant.name}>{contextMenu.participant.displayName || contextMenu.participant.name}</b>
          <small>{stateLabel}</small>
        </div>
        {/* Kill - only for running agents */}
        {running && item('kill', <Power {...ic} />, 'Kill Agent', () => { handleRosterKill(roster!.id); onClose(); }, { danger: true })}
        {/* Respawn - for roster agents */}
        {roster && item('respawn', <RotateCcw {...ic} className={respawningAgentId === roster.id ? 'animate-spin' : ''} />, respawningAgentId === roster.id ? 'Respawning…' : 'Respawn Agent', () => { handleRosterRespawn(roster.id); onClose(); }, { disabled: respawningAgentId === roster.id })}
        {/* Open in Terminal - for running agents */}
        {running && item('terminal', <Monitor {...ic} />, 'Open in Terminal', () => { handleRosterOpenTerminal(roster!.id); onClose(); }, { disabled: roster!.runLocation === 'server', title: roster!.runLocation === 'server' ? "Can't open a terminal for an agent running on the remote server" : undefined })}
        {/* Compact context - sends the harness's own command (/compact, or /compress for Gemini) */}
        {showCompact && item('compact', <Minimize2 {...ic} />, 'Compact Context', () => { handleRosterCompact(roster!.id); onClose(); }, { title: `Sends ${compactCommandFor(roster!.agentType)} to ${roster!.name}` })}
        {/* Keep Alive */}
        {roster && item('keep', <Activity {...ic} />, 'Keep Alive', () => { setKeepAliveParticipant(contextMenu.participant); onClose(); }, { checked: keepAliveAgentIds.has(roster.id), extra: <span className={`mg-switch${keepAliveAgentIds.has(roster.id) ? ' mg-switch--on' : ''}`} aria-hidden /> })}
        {roster && <hr />}
        {/* Bring Back — away agents */}
        {isAway && item('recall', <Undo2 {...ic} />, 'Bring Back', () => { handleRecallAgent(contextMenu.participant.id); onClose(); })}
        {/* Make Team Lead */}
        {activeChannel && activeChannel.teamLeadId !== contextMenu.participant.id && item('lead', <Crown {...ic} />, 'Make Team Lead', () => { handleMakeTeamLead(contextMenu.participant.id); onClose(); })}
        {/* Rename */}
        {item('rename', <Pencil {...ic} />, 'Rename', () => { setRenamingParticipantId(contextMenu.participant.id); setRenameValue(contextMenu.participant.name); onClose(); })}
        {/* Config — roster agents */}
        {roster && item('config', <Settings {...ic} />, 'Config', () => { setConfigModalAgentId(roster.id); onClose(); })}
        {/* Detach — PTY-managed non-roster agents */}
        {isPtyManaged && hasNoRoster && item('detach', <ExternalLink {...ic} />, 'Detach', () => { handleDetachAgent(contextMenu.participant); onClose(); })}
        {/* Remove from Channel */}
        {item('channel', <UserMinus {...ic} />, 'Remove from Channel', () => { handleRemoveParticipant(contextMenu.participant.id); onClose(); }, { danger: true })}
        {/* Add to Roster - for non-roster participants */}
        {!roster && item('add', <Plus {...ic} />, 'Add to Roster', async () => {
          try {
            const res = await fetch('/api/collab/pty', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'roster_add_from_participant',
                channelId: activeChannel!.id,
                participantId: contextMenu.participant.id,
              }),
            });
            if (res.ok) {
              const data = await res.json();
              if (data.agent) {
                setActiveChannel(prev => {
                  if (!prev) return prev;
                  const rosterData = prev.roster || { agents: [], lastUpdated: new Date().toISOString() };
                  return {
                    ...prev,
                    roster: {
                      ...rosterData,
                      agents: [...rosterData.agents, data.agent],
                      lastUpdated: new Date().toISOString(),
                    },
                  };
                });
              }
            }
            fetchData();
          } catch { /* ignore */ }
          onClose();
        })}
        {/* Agent Details - for roster agents */}
        {roster && item('details', <Info {...ic} />, 'Agent Details', () => { onShowAgentDetails(roster); onClose(); })}
        {/* Remove from Roster */}
        {roster && (
          <>
            <hr />
            {item('roster', <Trash2 {...ic} />, 'Remove from Roster', () => { handleRosterRemove(roster.id); onClose(); }, { danger: true })}
          </>
        )}
      </div>
    </>
  );
}
