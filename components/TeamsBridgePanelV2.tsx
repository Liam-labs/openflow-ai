'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  Plus,
  Trash2,
  ArrowLeftRight,
  Zap,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/brand';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamsBridgeStatus {
  configured: boolean;
  connected: boolean;
  botRegistered: boolean;
  tunnelUrl: string | null;
  syncEnabled: boolean;
  activeMappings: number;
  lastSyncAt: string | null;
  recentErrors: Array<{ message: string; timestamp: string }>;
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

interface TeamsTeam {
  id: string;
  displayName: string;
}

interface TeamsChannel {
  id: string;
  displayName: string;
}

interface DevflowChannel {
  id: string;
  name: string;
}

interface TeamsBridgePanelV2Props {
  onSetup: () => void;
}

type ViewState = 'loading' | 'not_configured' | 'connected' | 'error';

// ─── Teams Icon ───────────────────────────────────────────────────────────────

function TeamsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.404 4.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM20.34 5.25h-1.872a2.219 2.219 0 0 1-.534.75h2.031A2.536 2.536 0 0 1 22.5 8.534v4.216a2.535 2.535 0 0 1-2.535 2.535h-.377a5.308 5.308 0 0 1-3.088 2.965v1.5A4.252 4.252 0 0 1 12.25 24h-5.5A4.252 4.252 0 0 1 2.5 19.75V18.5h-.75A1.752 1.752 0 0 1 0 16.75v-6A1.752 1.752 0 0 1 1.75 9h6.5A1.752 1.752 0 0 1 10 10.75v6A1.752 1.752 0 0 1 8.25 18.5H4v1.25A2.753 2.753 0 0 0 6.75 22.5h5.5a2.753 2.753 0 0 0 2.75-2.75V18.5h-.75a1.752 1.752 0 0 1-1.75-1.75v-6A1.752 1.752 0 0 1 14.25 9h3.537a3.756 3.756 0 0 1-1.037-2.25h-2.5A3.754 3.754 0 0 1 10.5 3h-.25A3.754 3.754 0 0 1 6.5 6.75V9H1.75A1.752 1.752 0 0 0 0 10.75v6c0 .414.146.794.389 1.092A1.748 1.748 0 0 1 0 16.75v-6C0 9.784.784 9 1.75 9h6.5c.966 0 1.75.784 1.75 1.75v6c0 .966-.784 1.75-1.75 1.75H4v1.25A2.753 2.753 0 0 0 6.75 22.5h5.5a2.753 2.753 0 0 0 2.75-2.75V18.25c0-.414.336-.75.75-.75h.75c.966 0 1.75-.784 1.75-1.75v-6c0-.966-.784-1.75-1.75-1.75H14.25c-.966 0-1.75.784-1.75 1.75v6c0 .966.784 1.75 1.75 1.75z" />
    </svg>
  );
}

// ─── Status Item ──────────────────────────────────────────────────────────────

function StatusItem({ label, ok, value }: { label: string; ok: boolean; value?: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-black/20 border border-white/5">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ok ? 'bg-green-400' : 'bg-red-400/60'}`} />
        <span className="text-xs text-white/60">{label}</span>
      </div>
      {value && <span className="text-xs text-white/40 font-mono truncate max-w-[140px]">{value}</span>}
    </div>
  );
}

// ─── Add Mapping Form ─────────────────────────────────────────────────────────

function AddMappingForm({
  onAdd,
  onCancel,
}: {
  onAdd: (data: {
    devflowChannelId: string;
    devflowChannelName: string;
    teamsTeamId: string;
    teamsTeamName: string;
    teamsChannelId: string;
    teamsChannelName: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [devflowChannels, setDevflowChannels] = useState<DevflowChannel[]>([]);
  const [teams, setTeams] = useState<TeamsTeam[]>([]);
  const [teamsChannels, setTeamsChannels] = useState<TeamsChannel[]>([]);

  const [selectedDevflow, setSelectedDevflow] = useState('');
  const [selectedDevflowName, setSelectedDevflowName] = useState('');
  const [selectedTeam, setSelectedTeam] = useState('');
  const [selectedTeamName, setSelectedTeamName] = useState('');
  const [selectedChannel, setSelectedChannel] = useState('');
  const [selectedChannelName, setSelectedChannelName] = useState('');

  const [loadingTeams, setLoadingTeams] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/collab?action=list')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.channels)) {
          setDevflowChannels(data.channels.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })));
        }
      })
      .catch(() => {/* non-fatal */});

    setLoadingTeams(true);
    fetch('/api/collab/teams-bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list-teams' }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success && Array.isArray(data.teams)) setTeams(data.teams);
      })
      .catch(() => {/* non-fatal */})
      .finally(() => setLoadingTeams(false));
  }, []);

  const handleTeamChange = async (teamId: string) => {
    setSelectedTeam(teamId);
    setSelectedChannel('');
    setSelectedChannelName('');
    const team = teams.find((t) => t.id === teamId);
    setSelectedTeamName(team?.displayName ?? '');
    if (!teamId) return;
    setLoadingChannels(true);
    try {
      const res = await fetch('/api/collab/teams-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list-channels', teamId }),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.channels)) setTeamsChannels(data.channels);
    } catch {/* non-fatal */}
    setLoadingChannels(false);
  };

  const handleSubmit = async () => {
    if (!selectedDevflow || !selectedTeam || !selectedChannel) return;
    setSaving(true);
    setError('');
    try {
      await onAdd({
        devflowChannelId: selectedDevflow,
        devflowChannelName: selectedDevflowName,
        teamsTeamId: selectedTeam,
        teamsTeamName: selectedTeamName,
        teamsChannelId: selectedChannel,
        teamsChannelName: selectedChannelName,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add mapping');
    } finally {
      setSaving(false);
    }
  };

  const selectStyle = {
    background: 'rgba(10,20,40,0.8)',
    border: '1px solid rgba(59,130,246,0.2)',
    outline: 'none',
  };

  return (
    <div className="mt-3 p-4 rounded-xl border border-blue-500/20 bg-blue-500/5">
      <p className="text-xs font-medium text-white/70 mb-3">Add Channel Mapping</p>
      <div className="space-y-3">
        <div>
          <label htmlFor="tbridge-devflow-channel" className="block text-xs text-white/50 mb-1">{PRODUCT_NAME} Channel</label>
          {devflowChannels.length > 0 ? (
            <select
              id="tbridge-devflow-channel"
              value={selectedDevflow}
              onChange={(e) => {
                setSelectedDevflow(e.target.value);
                const ch = devflowChannels.find((c) => c.id === e.target.value);
                setSelectedDevflowName(ch?.name ?? '');
              }}
              className="w-full px-3 py-2 rounded-lg text-sm text-white/80"
              style={selectStyle}
            >
              <option value="">Select {PRODUCT_NAME} channel...</option>
              {devflowChannels.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={selectedDevflowName}
              onChange={(e) => { setSelectedDevflowName(e.target.value); setSelectedDevflow(e.target.value); }}
              placeholder="SG-1"
              className="w-full px-3 py-2 rounded-lg text-sm text-white/80 placeholder:text-white/20 outline-none"
              style={selectStyle}
            />
          )}
        </div>

        <div>
          <label htmlFor="tbridge-teams-team" className="block text-xs text-white/50 mb-1">Teams Team</label>
          {loadingTeams ? (
            <div className="flex items-center gap-2 text-xs text-white/40 py-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading teams...
            </div>
          ) : (
            <select
              id="tbridge-teams-team"
              value={selectedTeam}
              onChange={(e) => handleTeamChange(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm text-white/80"
              style={selectStyle}
            >
              <option value="">Select team...</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.displayName}</option>
              ))}
            </select>
          )}
        </div>

        {selectedTeam && (
          <div>
            <label htmlFor="tbridge-teams-channel" className="block text-xs text-white/50 mb-1">Teams Channel</label>
            {loadingChannels ? (
              <div className="flex items-center gap-2 text-xs text-white/40 py-2">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading channels...
              </div>
            ) : (
              <select
                id="tbridge-teams-channel"
                value={selectedChannel}
                onChange={(e) => {
                  setSelectedChannel(e.target.value);
                  const ch = teamsChannels.find((c) => c.id === e.target.value);
                  setSelectedChannelName(ch?.displayName ?? '');
                }}
                className="w-full px-3 py-2 rounded-lg text-sm text-white/80"
                style={selectStyle}
              >
                <option value="">Select channel...</option>
                {teamsChannels.map((c) => (
                  <option key={c.id} value={c.id}>{c.displayName}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs text-white/50 hover:text-white/70 border border-white/10 hover:bg-white/5 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !selectedDevflow || !selectedTeam || !selectedChannel}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            Add Mapping
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function TeamsBridgePanelV2({ onSetup }: TeamsBridgePanelV2Props) {
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [status, setStatus] = useState<TeamsBridgeStatus | null>(null);
  const [mappings, setMappings] = useState<ChannelMapping[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bridges/teams/status');
      if (!res.ok) {
        setViewState('not_configured');
        setStatus(null);
        return;
      }
      const json: TeamsBridgeStatus = await res.json();
      setStatus(json);
      setViewState(json.configured && json.connected ? 'connected' : 'not_configured');
    } catch {
      setViewState('not_configured');
      setStatus(null);
    }
  }, []);

  const fetchMappings = useCallback(async () => {
    try {
      const res = await fetch('/api/bridges/teams/mappings');
      if (!res.ok) return;
      const json: ChannelMapping[] = await res.json();
      setMappings(Array.isArray(json) ? json : []);
    } catch {/* non-fatal */}
  }, []);

  const refresh = useCallback(async () => {
    await fetchStatus();
    await fetchMappings();
  }, [fetchStatus, fetchMappings]);

  useEffect(() => {
    fetchStatus();
    fetchMappings();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchMappings]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/bridges/teams/test', { method: 'POST' });
      const json = await res.json() as { success?: boolean; message?: string };
      setTestResult({ ok: !!json.success, message: json.message ?? (json.success ? 'Connection OK' : 'Test failed') });
    } catch {
      setTestResult({ ok: false, message: 'Request failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleAddMapping = async (data: {
    devflowChannelId: string;
    devflowChannelName: string;
    teamsTeamId: string;
    teamsTeamName: string;
    teamsChannelId: string;
    teamsChannelName: string;
  }) => {
    const res = await fetch('/api/bridges/teams/mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? 'Failed to add mapping');
    }
    setShowAddForm(false);
    await fetchMappings();
  };

  const handleDeleteMapping = async (mappingId: string) => {
    try {
      await fetch('/api/bridges/teams/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', mappingId }),
      });
      await fetchMappings();
    } catch {/* non-fatal */}
  };

  // ── Loading ──
  if (viewState === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20">
        <Loader2 className="w-8 h-8 text-white/30 animate-spin mb-3" />
        <p className="text-sm text-white/40">Checking Teams status...</p>
      </div>
    );
  }

  // ── Not Configured ──
  if (viewState === 'not_configured') {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 px-6 text-center">
        <div className="p-4 rounded-2xl bg-blue-500/10 border border-blue-500/20 mb-5">
          <TeamsIcon className="w-12 h-12 text-blue-400" />
        </div>
        <h3 className="text-xl font-semibold text-white mb-2">Microsoft Teams Bridge</h3>
        <p className="text-sm text-white/60 mb-7 max-w-xs leading-relaxed">
          Connect your Microsoft Teams workspace to route messages through {PRODUCT_NAME} agents.
        </p>
        <button
          onClick={onSetup}
          className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white
            text-sm font-medium transition-all shadow-lg shadow-blue-500/20"
        >
          Set Up Teams
        </button>
      </div>
    );
  }

  // ── Error ──
  if (viewState === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 px-6">
        <div className="w-full max-w-sm">
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 mb-5">
            <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-300">Bridge unavailable</p>
              <p className="text-xs text-red-400/70 mt-0.5">{errorMessage}</p>
            </div>
          </div>
          <button
            onClick={() => { setViewState('loading'); refresh(); }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl
              border border-white/20 text-white/70 hover:text-white hover:bg-white/10
              text-sm transition-all"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ── Connected ──
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-6 space-y-5">

        {/* Status card */}
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/15 border border-blue-500/20">
                <TeamsIcon className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Microsoft Teams</p>
                <p className="text-xs text-white/50">{status?.activeMappings ?? mappings.length} active mappings</p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
              bg-green-500/20 text-green-300 border border-green-500/30 text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              Connected
            </span>
          </div>

          <div className="grid grid-cols-2 gap-1.5 mb-4">
            <StatusItem label="Azure AD" ok={status?.configured ?? false} />
            <StatusItem label="Bot Registered" ok={status?.botRegistered ?? false} />
            <StatusItem
              label="Tunnel URL"
              ok={!!status?.tunnelUrl}
              value={status?.tunnelUrl ? 'Active' : 'Not set'}
            />
            <StatusItem
              label="Sync"
              ok={status?.syncEnabled ?? false}
              value={status?.syncEnabled ? 'Enabled' : 'Disabled'}
            />
          </div>

          {status?.lastSyncAt && (
            <p className="text-xs text-white/30 mb-3">
              Last sync: {new Date(status.lastSyncAt).toLocaleString()}
            </p>
          )}

          {/* Test result */}
          {testResult && (
            <div className={`flex items-start gap-2.5 px-3 py-2 rounded-lg mb-3 text-xs ${
              testResult.ok
                ? 'bg-green-500/10 border border-green-500/20 text-green-300'
                : 'bg-red-500/10 border border-red-500/20 text-red-300'
            }`}>
              {testResult.ok
                ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                : <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              }
              {testResult.message}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleTest}
              disabled={testing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                border border-blue-500/30 text-blue-300 hover:bg-blue-500/15 transition-all
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Test Connection
            </button>
            <button
              onClick={() => refresh()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs
                border border-white/10 text-white/50 hover:text-white hover:bg-white/5 transition-all"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>

        {/* Channel Mappings */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-white/40">
              Channel Mappings
            </h4>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs
                bg-blue-600/20 border border-blue-500/30 text-blue-300
                hover:bg-blue-600/30 transition-all"
            >
              <Plus className="w-3 h-3" />
              Add Mapping
            </button>
          </div>

          {showAddForm && (
            <AddMappingForm
              onAdd={handleAddMapping}
              onCancel={() => setShowAddForm(false)}
            />
          )}

          {mappings.length === 0 && !showAddForm ? (
            <div className="flex flex-col items-center py-8 text-center">
              <p className="text-sm text-white/30">No channel mappings yet</p>
              <p className="text-xs text-white/20 mt-1">Map a {PRODUCT_NAME} channel to a Teams channel</p>
            </div>
          ) : (
            <div className="space-y-1.5 mt-3">
              {mappings.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]"
                >
                  <span className="text-xs text-white/70 truncate min-w-0 flex-1">
                    {PRODUCT_NAME}: <span className="text-white font-medium">{m.devflowChannelName}</span>
                  </span>
                  <ArrowLeftRight className="w-3.5 h-3.5 text-white/25 flex-shrink-0" />
                  <span className="text-xs text-blue-300 truncate min-w-0 flex-1">
                    {m.teamsTeamName} / {m.teamsChannelName}
                  </span>
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${m.syncEnabled ? 'bg-green-400' : 'bg-white/20'}`} />
                  <button
                    onClick={() => handleDeleteMapping(m.id)}
                    className="p-1 rounded hover:bg-red-500/20 text-white/30 hover:text-red-400 transition-all flex-shrink-0"
                    title="Remove mapping"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Errors */}
        {status?.recentErrors && status.recentErrors.length > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
            <button
              onClick={() => setShowErrors(!showErrors)}
              className="w-full flex items-center justify-between px-4 py-3 text-xs hover:bg-white/[0.03] transition-all"
            >
              <span className="flex items-center gap-2 text-amber-400 font-medium">
                <AlertCircle className="w-3.5 h-3.5" />
                Recent Errors ({status.recentErrors.length})
              </span>
              {showErrors ? <ChevronUp className="w-3.5 h-3.5 text-white/30" /> : <ChevronDown className="w-3.5 h-3.5 text-white/30" />}
            </button>
            {showErrors && (
              <div className="px-4 pb-3 space-y-2">
                {status.recentErrors.map((err, i) => (
                  <div key={i} className="py-2 border-t border-white/[0.05]">
                    <p className="text-[10px] text-white/30 mb-0.5">{new Date(err.timestamp).toLocaleString()}</p>
                    <p className="text-xs text-red-300/70">{err.message}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
