'use client';

/**
 * ColabButton - Collaboration controls for multi-agent chat
 *
 * Features:
 * - List/create collaboration channels
 * - Show available agents (from /api/claude/sessions)
 * - Invite agents to channels
 * - Show channel participants
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Users,
  Plus,
  ChevronDown,
  Circle,
  Terminal,
  Globe,
  Sparkles,
  Loader2,
  X,
  Check,
  RefreshCw,
  Trash2,
  UserMinus,
} from 'lucide-react';
import type {
  CollabChannel,
  CollabParticipant,
  ClaudeSession,
} from '@/lib/types';

interface ColabButtonProps {
  onChannelSelect?: (channel: CollabChannel) => void;
  onParticipantInvited?: (participant: CollabParticipant) => void;
  onSpawnAgent?: () => void;
  activeChannelId?: string;
}

type DropdownView = 'main' | 'agents' | 'create';

export function ColabButton({
  onChannelSelect,
  onParticipantInvited,
  onSpawnAgent,
  activeChannelId,
}: ColabButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<DropdownView>('main');
  const [channels, setChannels] = useState<CollabChannel[]>([]);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [isSpawning, setIsSpawning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch channels and sessions
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [channelsRes, sessionsRes] = await Promise.all([
        fetch('/api/collab'),
        fetch('/api/claude/sessions'),
      ]);

      if (channelsRes.ok) {
        const data = await channelsRes.json();
        setChannels(data.channels || []);
      }

      if (sessionsRes.ok) {
        const data = await sessionsRes.json();
        setSessions(data.sessions || []);
      }
    } catch (error) {
      console.error('Failed to fetch collab data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount and when dropdown opens
  useEffect(() => {
    if (isOpen) {
      fetchData();
    }
  }, [isOpen, fetchData]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setView('main');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Create a new channel
  const handleCreateChannel = async () => {
    if (!newChannelName.trim()) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          name: newChannelName.trim(),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.channel) {
          setChannels(prev => [...prev, data.channel]);
          onChannelSelect?.(data.channel);
          setNewChannelName('');
          setView('main');
        }
      }
    } catch (error) {
      console.error('Failed to create channel:', error);
    }
  };

  // Delete a channel
  const handleDeleteChannel = async (channelId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't select channel when deleting
    if (!confirm('Delete this channel and all messages?')) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          channelId,
        }),
      });

      if (res.ok) {
        setChannels(prev => prev.filter(c => c.id !== channelId));
        // If we deleted the active channel, clear it
        if (channelId === activeChannelId) {
          onChannelSelect?.(null as unknown as CollabChannel);
        }
      }
    } catch (error) {
      console.error('Failed to delete channel:', error);
    }
  };

  // Remove a participant from the active channel
  const handleRemoveParticipant = async (participantId: string) => {
    if (!activeChannelId) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'leave',
          channelId: activeChannelId,
          participantId,
        }),
      });

      if (res.ok) {
        fetchData(); // Refresh to show updated participants
      }
    } catch (error) {
      console.error('Failed to remove participant:', error);
    }
  };

  // Invite an agent to the active channel
  const handleInviteAgent = async (session: ClaudeSession) => {
    if (!activeChannelId) {
      alert('Select or create a channel first');
      return;
    }

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'join',
          channelId: activeChannelId,
          participant: {
            id: session.sessionId,
            type: 'claude-terminal',
            name: session.displayName || `Agent-${session.pid}`,
            source: 'Terminal',
            pid: session.pid,
            projectPath: session.projectPath,
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          // Find the participant in the response
          const channel = data.channel;
          const participant = channel?.participants?.find(
            (p: CollabParticipant) => p.id === session.sessionId
          );
          if (participant) {
            onParticipantInvited?.(participant);
          }
          fetchData(); // Refresh
        }
      }
    } catch (error) {
      console.error('Failed to invite agent:', error);
    }
  };

  // Spawn a new Claude agent in a new terminal
  const handleSpawnAgent = async () => {
    if (!activeChannelId) {
      alert('Select or create a channel first');
      return;
    }

    setIsSpawning(true);
    try {
      // Open Claude in a new terminal with the collab context
      const res = await fetch('/api/claude/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'spawn',
          channelId: activeChannelId,
          channelName: activeChannel?.name || 'Collaboration',
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          // Callback to parent
          onSpawnAgent?.();
          setIsOpen(false);
        }
      }
    } catch (error) {
      console.error('Failed to spawn agent:', error);
    } finally {
      setIsSpawning(false);
    }
  };

  // Get participant count for active channel
  const activeChannel = channels.find(c => c.id === activeChannelId);
  const participantCount = activeChannel?.participants?.length || 0;

  // Get status color for session
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'text-green-400';
      case 'busy':
        return 'text-yellow-400';
      case 'idle':
        return 'text-gray-400';
      default:
        return 'text-red-400';
    }
  };

  // Get icon for participant type
  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'claude-terminal':
        return <Terminal className="w-3 h-3" />;
      case 'claude-browser':
        return <Globe className="w-3 h-3" />;
      case 'gemini':
        return <Sparkles className="w-3 h-3" />;
      default:
        return <Users className="w-3 h-3" />;
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
          isOpen || activeChannelId
            ? 'bg-purple-500/20 text-purple-400'
            : 'bg-white/5 text-muted hover:bg-white/10 hover:text-white'
        }`}
        title="Collaboration"
      >
        <Users className="w-3.5 h-3.5" />
        <span>Colab</span>
        {participantCount > 0 && (
          <span className="bg-purple-500/30 px-1.5 rounded-full text-[10px]">
            {participantCount}
          </span>
        )}
        <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-72 border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden" style={{ backgroundColor: '#0a1428' }}>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}>
            <span className="text-sm font-medium">
              {view === 'main' && 'Collaboration'}
              {view === 'agents' && 'Available Agents'}
              {view === 'create' && 'New Channel'}
            </span>
            <div className="flex items-center gap-1">
              {view !== 'main' && (
                <button
                  onClick={() => setView('main')}
                  className="p-1 rounded hover:bg-white/10 text-muted"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={fetchData}
                className="p-1 rounded hover:bg-white/10 text-muted"
                title="Refresh"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* Main View */}
          {view === 'main' && (
            <div className="max-h-80 overflow-y-auto">
              {/* Active Channel */}
              {activeChannel && (
                <div className="px-3 py-2 border-b border-white/10">
                  <div className="text-xs text-muted mb-1">Current Channel</div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-purple-400">
                      {activeChannel.name}
                    </span>
                    <span className="text-xs text-muted">
                      ({activeChannel.participants?.length || 0} participants)
                    </span>
                  </div>
                  {/* Participant list with remove option */}
                  {activeChannel.participants && activeChannel.participants.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {activeChannel.participants.map((p) => (
                        <div
                          key={p.id}
                          className="group flex items-center gap-2 py-0.5"
                        >
                          <div
                            className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium flex-shrink-0"
                            style={{ backgroundColor: p.color || '#8B5CF6' }}
                          >
                            {p.name.charAt(0).toUpperCase()}
                          </div>
                          <span className="text-xs truncate flex-1">{p.name}</span>
                          <span className="text-[10px] text-muted group-hover:hidden">{p.source}</span>
                          <button
                            onClick={() => handleRemoveParticipant(p.id)}
                            className="hidden group-hover:block p-0.5 rounded hover:bg-red-500/20 text-red-400"
                            title="Remove from channel"
                          >
                            <UserMinus className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Channels List */}
              <div className="p-2">
                <div className="text-xs text-muted px-1 mb-1">Channels</div>
                {channels.length === 0 ? (
                  <div className="text-xs text-muted text-center py-4">
                    No channels yet. Create one to start collaborating.
                  </div>
                ) : (
                  channels.map((channel) => (
                    <div
                      key={channel.id}
                      className={`group flex items-center gap-1 px-2 py-1.5 rounded text-sm hover:bg-white/10 transition-colors ${
                        channel.id === activeChannelId ? 'bg-purple-500/20 text-purple-400' : ''
                      }`}
                    >
                      <button
                        onClick={() => {
                          onChannelSelect?.(channel);
                          setIsOpen(false);
                        }}
                        className="flex-1 text-left truncate"
                      >
                        {channel.name}
                      </button>
                      <span className="text-xs text-muted group-hover:hidden">
                        {channel.participants?.length || 0}
                      </span>
                      <button
                        onClick={(e) => handleDeleteChannel(channel.id, e)}
                        className="hidden group-hover:block p-1 rounded hover:bg-red-500/20 text-red-400"
                        title="Archive channel"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Actions */}
              <div className="p-2 border-t border-white/10 space-y-1">
                <button
                  onClick={() => setView('create')}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left hover:bg-white/10 transition-colors"
                >
                  <Plus className="w-4 h-4 text-green-400" />
                  <span>Create Channel</span>
                </button>
                <button
                  onClick={() => setView('agents')}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left hover:bg-white/10 transition-colors"
                >
                  <Users className="w-4 h-4 text-blue-400" />
                  <span>Add Agent</span>
                  <span className="ml-auto text-xs text-muted">
                    {sessions.length} available
                  </span>
                </button>
                <button
                  onClick={handleSpawnAgent}
                  disabled={!activeChannelId || isSpawning}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left hover:bg-white/10 transition-colors disabled:opacity-50"
                >
                  <Sparkles className="w-4 h-4 text-purple-400" />
                  <span>{isSpawning ? 'Spawning...' : 'Spawn New Agent'}</span>
                  {isSpawning && <Loader2 className="w-3 h-3 animate-spin ml-auto" />}
                </button>
              </div>
            </div>
          )}

          {/* Agents View */}
          {view === 'agents' && (
            <div className="max-h-80 overflow-y-auto">
              {!activeChannelId && (
                <div className="px-3 py-2 bg-yellow-500/10 text-yellow-400 text-xs">
                  Select a channel first to invite agents
                </div>
              )}
              <div className="p-2">
                {loading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-5 h-5 animate-spin text-muted" />
                  </div>
                ) : sessions.length === 0 ? (
                  <div className="text-xs text-muted text-center py-4">
                    No active Claude sessions detected.
                    <br />
                    Start a Claude Code session in a terminal.
                  </div>
                ) : (
                  sessions.map((session) => {
                    const isInChannel = activeChannel?.participants?.some(
                      (p) => p.id === session.sessionId
                    );
                    return (
                      <button
                        key={session.sessionId}
                        onClick={() => !isInChannel && handleInviteAgent(session)}
                        disabled={!activeChannelId || isInChannel}
                        className={`w-full flex items-center gap-2 px-2 py-2 rounded text-left text-sm transition-colors ${
                          isInChannel
                            ? 'opacity-50 cursor-not-allowed'
                            : 'hover:bg-white/10'
                        }`}
                      >
                        <Circle
                          className={`w-2 h-2 fill-current ${getStatusColor(session.status)}`}
                        />
                        <Terminal className="w-4 h-4 text-purple-400" />
                        <div className="flex-1 min-w-0">
                          <div className="truncate font-medium">
                            {session.displayName || `Agent-${session.pid}`}
                          </div>
                          <div className="text-xs text-muted truncate">
                            {session.projectPath}
                          </div>
                        </div>
                        {isInChannel ? (
                          <Check className="w-4 h-4 text-green-400" />
                        ) : (
                          <Plus className="w-4 h-4 text-muted" />
                        )}
                      </button>
                    );
                  })
                )}
                {/* Spawn new agent option */}
                <div className="border-t border-white/10 mt-2 pt-2">
                  <button
                    onClick={handleSpawnAgent}
                    disabled={!activeChannelId || isSpawning}
                    className="w-full flex items-center gap-2 px-2 py-2 rounded text-sm text-left hover:bg-white/10 transition-colors disabled:opacity-50"
                  >
                    <Sparkles className="w-4 h-4 text-purple-400" />
                    <div className="flex-1">
                      <div className="font-medium">{isSpawning ? 'Spawning...' : 'Spawn New Agent'}</div>
                      <div className="text-xs text-muted">Open Claude in a new terminal</div>
                    </div>
                    {isSpawning && <Loader2 className="w-4 h-4 animate-spin" />}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Create Channel View */}
          {view === 'create' && (
            <div className="p-3">
              <input
                type="text"
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateChannel()}
                placeholder="Channel name..."
                className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded text-sm placeholder-white/40 focus:outline-none focus:border-purple-500/50"
                autoFocus
              />
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => setView('main')}
                  className="flex-1 px-3 py-1.5 rounded text-sm bg-white/5 hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateChannel}
                  disabled={!newChannelName.trim()}
                  className="flex-1 px-3 py-1.5 rounded text-sm bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors disabled:opacity-50"
                >
                  Create
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Participant pill showing who's in the current channel
 */
interface ParticipantPillsProps {
  participants: CollabParticipant[];
  maxVisible?: number;
}

export function ParticipantPills({ participants, maxVisible = 4 }: ParticipantPillsProps) {
  if (!participants || participants.length === 0) return null;

  const visible = participants.slice(0, maxVisible);
  const overflow = participants.length - maxVisible;

  return (
    <div className="flex items-center gap-0.5">
      {visible.map((p) => (
        <div
          key={p.id}
          className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium -ml-1 first:ml-0 ring-1 ring-card"
          style={{ backgroundColor: p.color || '#8B5CF6' }}
          title={`${p.name} (${p.source})`}
        >
          {p.name.charAt(0).toUpperCase()}
        </div>
      ))}
      {overflow > 0 && (
        <span className="text-[10px] text-muted ml-1">+{overflow}</span>
      )}
    </div>
  );
}
