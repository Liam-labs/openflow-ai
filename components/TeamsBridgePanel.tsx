'use client';

/**
 * TeamsBridgePanel - Settings panel for Microsoft Teams integration
 *
 * Shows bridge status, channel mappings, and configuration for the
 * DevFlow <-> Microsoft Teams bidirectional sync.
 *
 * Used within ColabPanel channel settings or as a standalone section.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Plug,
  PlugZap,
  RefreshCw,
  Plus,
  Trash2,
  Check,
  X,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Hash,
  ArrowLeftRight,
  Wifi,
  WifiOff,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/brand';

// Microsoft Teams icon SVG component
function TeamsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.404 4.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM20.34 5.25h-1.872a2.219 2.219 0 0 1-.534.75h2.031A2.536 2.536 0 0 1 22.5 8.534v4.216a2.535 2.535 0 0 1-2.535 2.535h-.377a5.308 5.308 0 0 1-3.088 2.965v1.5A4.252 4.252 0 0 1 12.25 24h-5.5A4.252 4.252 0 0 1 2.5 19.75V18.5h-.75A1.752 1.752 0 0 1 0 16.75v-6A1.752 1.752 0 0 1 1.75 9h6.5A1.752 1.752 0 0 1 10 10.75v6A1.752 1.752 0 0 1 8.25 18.5H4v1.25A2.753 2.753 0 0 0 6.75 22.5h5.5a2.753 2.753 0 0 0 2.75-2.75V18.5h-.75a1.752 1.752 0 0 1-1.75-1.75v-6A1.752 1.752 0 0 1 14.25 9h3.537a3.756 3.756 0 0 1-1.037-2.25h-2.5A3.754 3.754 0 0 1 10.5 3h-.25A3.754 3.754 0 0 1 6.5 6.75V9H1.75A1.752 1.752 0 0 0 0 10.75v6c0 .414.146.794.389 1.092A1.748 1.748 0 0 1 0 16.75v-6C0 9.784.784 9 1.75 9h6.5c.966 0 1.75.784 1.75 1.75v6c0 .966-.784 1.75-1.75 1.75H4v1.25A2.753 2.753 0 0 0 6.75 22.5h5.5a2.753 2.753 0 0 0 2.75-2.75V18.25c0-.414.336-.75.75-.75h.75c.966 0 1.75-.784 1.75-1.75v-6c0-.966-.784-1.75-1.75-1.75H14.25c-.966 0-1.75.784-1.75 1.75v6c0 .966.784 1.75 1.75 1.75z" />
    </svg>
  );
}

interface TeamsBridgeStatus {
  configured: boolean;
  connected: boolean;
  botRegistered: boolean;
  tunnelUrl: string | null;
  syncEnabled: boolean;
  activeMappings: number;
  totalMappings: number;
  lastSyncAt: string | null;
  recentErrors: Array<{ message: string; timestamp: string; context?: string }>;
}

interface TeamsTeam {
  id: string;
  displayName: string;
  description?: string;
}

interface TeamsChannel {
  id: string;
  displayName: string;
  membershipType?: string;
}

interface ChannelMapping {
  id: string;
  devflowChannelId: string;
  devflowChannelName: string;
  teamsTeamId: string;
  teamsTeamName: string;
  teamsChannelId: string;
  teamsChannelName: string;
  syncEnabled: boolean;
  lastSyncAt?: string;
}

interface TeamsBridgePanelProps {
  channelId: string;
  channelName: string;
}

export function TeamsBridgePanel({ channelId, channelName }: TeamsBridgePanelProps) {
  const [status, setStatus] = useState<TeamsBridgeStatus | null>(null);
  const [mappings, setMappings] = useState<ChannelMapping[]>([]);
  const [teams, setTeams] = useState<TeamsTeam[]>([]);
  const [channels, setChannels] = useState<TeamsChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showMapForm, setShowMapForm] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<string>('');
  const [selectedChannel, setSelectedChannel] = useState<string>('');
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  // Use the dedicated frontend API (no token auth needed)
  const bridgeApi = useCallback(async (action: string, body: Record<string, unknown> = {}) => {
    const res = await fetch('/api/collab/teams-bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    return res.json();
  }, []);

  // Fetch bridge status and mappings via GET endpoint
  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const res = await fetch(`/api/collab/teams-bridge?channelId=${encodeURIComponent(channelId)}`);
      const data = await res.json();

      if (data.success) {
        setStatus(data.status);
        setMappings(data.mappings || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Test connection
  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await bridgeApi('test');
      if (res.success) {
        setError(null);
        await refresh();
      } else {
        setError(res.data?.error || res.error || 'Connection test failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  // Load available teams
  const loadTeams = async () => {
    try {
      const res = await bridgeApi('list-teams');
      if (res.success) {
        setTeams(res.teams || []);
      }
    } catch (err) {
      console.error('Failed to load teams:', err);
    }
  };

  // Load channels for selected team
  const loadChannels = async (teamId: string) => {
    setLoadingChannels(true);
    try {
      const res = await bridgeApi('list-channels', { teamId });
      if (res.success) {
        setChannels(res.channels || []);
      }
    } catch (err) {
      console.error('Failed to load channels:', err);
    } finally {
      setLoadingChannels(false);
    }
  };

  // Create channel mapping
  const handleMap = async () => {
    if (!selectedTeam || !selectedChannel) return;

    const team = teams.find(t => t.id === selectedTeam);
    const channel = channels.find(c => c.id === selectedChannel);

    try {
      const res = await bridgeApi('map', {
        devflowChannelId: channelId,
        devflowChannelName: channelName,
        teamsTeamId: selectedTeam,
        teamsTeamName: team?.displayName || '',
        teamsChannelId: selectedChannel,
        teamsChannelName: channel?.displayName || '',
      });

      if (res.success) {
        setShowMapForm(false);
        setSelectedTeam('');
        setSelectedChannel('');
        await refresh();
      } else {
        setError(res.error || 'Failed to create mapping');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create mapping');
    }
  };

  // Remove channel mapping
  const handleUnmap = async (mappingId: string) => {
    try {
      const res = await bridgeApi('unmap', { mappingId });
      if (res.success) {
        await refresh();
      } else {
        setError(res.error || 'Failed to remove mapping');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove mapping');
    }
  };

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center py-6 text-muted text-xs">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading Teams status...
      </div>
    );
  }

  const isConnected = status?.configured && status?.connected;
  const hasMapping = mappings.length > 0;

  return (
    <div className="space-y-3">
      {/* Header with toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 bg-[#0a1628]/50 border border-white/5 rounded-lg hover:border-white/10 transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className={`w-6 h-6 rounded-md flex items-center justify-center ${
            isConnected ? 'bg-blue-500/20' : 'bg-white/5'
          }`}>
            <Plug className={`w-3.5 h-3.5 ${isConnected ? 'text-blue-400' : 'text-muted'}`} />
          </div>
          <span className="text-xs font-medium">Microsoft Teams</span>
          {hasMapping && (
            <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-blue-500/20 text-blue-300 border border-blue-500/20">
              Synced
            </span>
          )}
          {!status?.configured && (
            <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-yellow-500/20 text-yellow-300 border border-yellow-500/20">
              Not Configured
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isConnected ? (
            <Wifi className="w-3 h-3 text-green-400" />
          ) : (
            <WifiOff className="w-3 h-3 text-muted" />
          )}
          {expanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-muted" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-muted" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 px-1">
          {/* Connection Status */}
          <div className="p-3 bg-black/20 rounded-lg border border-white/5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">Connection</span>
              <div className="flex gap-1.5">
                <button
                  onClick={handleTest}
                  disabled={testing || !status?.configured}
                  className="px-2 py-0.5 text-[10px] rounded bg-white/5 hover:bg-white/10 text-muted hover:text-white transition-colors disabled:opacity-40 flex items-center gap-1"
                >
                  {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlugZap className="w-3 h-3" />}
                  Test
                </button>
                <button
                  onClick={refresh}
                  disabled={loading}
                  className="px-2 py-0.5 text-[10px] rounded bg-white/5 hover:bg-white/10 text-muted hover:text-white transition-colors disabled:opacity-40 flex items-center gap-1"
                >
                  <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <StatusItem label="Azure AD" ok={status?.configured || false} />
              <StatusItem label="Bot Registered" ok={status?.botRegistered || false} />
              <StatusItem label="Tunnel URL" ok={!!status?.tunnelUrl} value={status?.tunnelUrl ? 'Active' : 'Not set'} />
              <StatusItem label="Sync" ok={status?.syncEnabled || false} value={status?.syncEnabled ? 'Enabled' : 'Disabled'} />
            </div>

            {status?.lastSyncAt && (
              <div className="text-[10px] text-muted">
                Last sync: {new Date(status.lastSyncAt).toLocaleString()}
              </div>
            )}
          </div>

          {/* Error display */}
          {error && (
            <div className="p-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
              <span className="text-[10px] text-red-300">{error}</span>
              <button onClick={() => setError(null)} className="ml-auto shrink-0" aria-label="Dismiss error">
                <X className="w-3 h-3 text-red-400 hover:text-red-300" />
              </button>
            </div>
          )}

          {/* Channel Mapping */}
          <div className="p-3 bg-black/20 rounded-lg border border-white/5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">Channel Mapping</span>
              {status?.configured && (
                <button
                  onClick={() => {
                    setShowMapForm(!showMapForm);
                    if (!showMapForm && teams.length === 0) loadTeams();
                  }}
                  className="px-2 py-0.5 text-[10px] rounded bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 transition-colors flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  Map
                </button>
              )}
            </div>

            {/* Existing mappings */}
            {mappings.length > 0 ? (
              <div className="space-y-1.5">
                {mappings.map(m => (
                  <div
                    key={m.id}
                    className="flex items-center gap-2 px-2 py-1.5 bg-white/3 rounded-lg border border-white/5"
                  >
                    <Hash className="w-3 h-3 text-purple-400 shrink-0" />
                    <span className="text-[11px] text-white truncate">{m.devflowChannelName || channelName}</span>
                    <ArrowLeftRight className="w-3 h-3 text-muted shrink-0" />
                    <div className="flex items-center gap-1 min-w-0">
                      <Plug className="w-3 h-3 text-blue-400 shrink-0" />
                      <span className="text-[11px] text-blue-300 truncate">{m.teamsChannelName}</span>
                    </div>
                    <div className="flex items-center gap-1 ml-auto shrink-0">
                      {m.syncEnabled ? (
                        <Check className="w-3 h-3 text-green-400" />
                      ) : (
                        <X className="w-3 h-3 text-red-400" />
                      )}
                      <button
                        onClick={() => handleUnmap(m.id)}
                        className="p-0.5 rounded hover:bg-red-500/20 text-muted hover:text-red-400 transition-colors"
                        title="Remove mapping"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-muted text-center py-2">
                {status?.configured
                  ? 'No Teams channel mapped. Click "Map" to connect.'
                  : 'Configure Azure AD credentials to enable Teams integration.'}
              </div>
            )}

            {/* Map channel form */}
            {showMapForm && (
              <div className="mt-2 p-2 bg-blue-500/5 border border-blue-500/10 rounded-lg space-y-2">
                <div>
                  <label className="block text-[10px] text-muted mb-1">Team</label>
                  <select
                    value={selectedTeam}
                    onChange={(e) => {
                      setSelectedTeam(e.target.value);
                      setSelectedChannel('');
                      if (e.target.value) loadChannels(e.target.value);
                    }}
                    className="w-full px-2 py-1.5 bg-black/40 border border-white/10 rounded text-[11px] text-white focus:border-blue-500/50 focus:outline-none"
                  >
                    <option value="">Select a team...</option>
                    {teams.map(t => (
                      <option key={t.id} value={t.id}>{t.displayName}</option>
                    ))}
                  </select>
                </div>

                {selectedTeam && (
                  <div>
                    <label className="block text-[10px] text-muted mb-1">Channel</label>
                    {loadingChannels ? (
                      <div className="flex items-center gap-1 text-[10px] text-muted py-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> Loading channels...
                      </div>
                    ) : (
                      <select
                        value={selectedChannel}
                        onChange={(e) => setSelectedChannel(e.target.value)}
                        className="w-full px-2 py-1.5 bg-black/40 border border-white/10 rounded text-[11px] text-white focus:border-blue-500/50 focus:outline-none"
                      >
                        <option value="">Select a channel...</option>
                        {channels.map(c => (
                          <option key={c.id} value={c.id}>{c.displayName}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    onClick={() => setShowMapForm(false)}
                    className="px-2 py-1 text-[10px] rounded text-muted hover:bg-white/10 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleMap}
                    disabled={!selectedTeam || !selectedChannel}
                    className="px-2 py-1 text-[10px] rounded bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-40"
                  >
                    Link Channel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Recent Errors */}
          {status?.recentErrors && status.recentErrors.length > 0 && (
            <div className="p-3 bg-black/20 rounded-lg border border-white/5 space-y-2">
              <button
                onClick={() => setShowErrors(!showErrors)}
                className="w-full flex items-center justify-between text-[10px] font-semibold text-muted uppercase tracking-wider"
              >
                <span className="flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 text-yellow-400" />
                  Recent Errors ({status.recentErrors.length})
                </span>
                {showErrors ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {showErrors && (
                <div className="space-y-1">
                  {status.recentErrors.map((err, i) => (
                    <div key={i} className="text-[10px] text-red-300/70 py-1 border-t border-white/5">
                      <div className="text-[9px] text-muted">{new Date(err.timestamp).toLocaleString()}</div>
                      {err.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Setup instructions if not configured */}
          {!status?.configured && (
            <div className="p-3 bg-yellow-500/5 border border-yellow-500/10 rounded-lg space-y-2">
              <div className="text-[10px] font-semibold text-yellow-300 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                Setup Required
              </div>
              <div className="text-[10px] text-muted space-y-1">
                <p>To enable Teams integration:</p>
                <ol className="list-decimal list-inside space-y-0.5 ml-1">
                  <li>Register an Azure AD app (Entra ID)</li>
                  <li>Create an Azure Bot Service (F0 free tier)</li>
                  <li>Add credentials to {PRODUCT_NAME} Vault or ~/.secrets</li>
                  <li>Set up an HTTPS tunnel (Dev Tunnels or ngrok)</li>
                </ol>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusItem({ label, ok, value }: { label: string; ok: boolean; value?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-green-400' : 'bg-red-400/60'}`} />
      <span className="text-[10px] text-muted">{label}</span>
      {value && <span className="text-[10px] text-white/60 ml-auto">{value}</span>}
    </div>
  );
}
