'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  Plus,
  Trash2,
  ArrowLeftRight,
  Zap,
} from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/brand';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SlackStatus {
  configured: boolean;
  connected: boolean;
  workspaceName?: string;
  botName?: string;
  socketMode?: boolean;
  webhookUrl?: string;
  activeMappings: number;
  lastEventAt?: string;
}

interface SlackMapping {
  id: string;
  slackChannelName: string;
  devflowChannelName: string;
  syncEnabled: boolean;
}

interface DevflowChannel {
  id: string;
  name: string;
}

interface SlackBridgePanelProps {
  onSetup: () => void;
  onRefresh: () => void;
}

type ViewState = 'loading' | 'not_configured' | 'connected' | 'error';

// ─── Slack Icon ───────────────────────────────────────────────────────────────

function SlackIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
    </svg>
  );
}

// ─── Add Mapping Form ─────────────────────────────────────────────────────────

function AddMappingForm({
  onAdd,
  onCancel,
}: {
  onAdd: (slackChannel: string, devflowChannelName: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [slackChannel, setSlackChannel] = useState('');
  const [devflowChannel, setDevflowChannel] = useState('');
  const [devflowChannels, setDevflowChannels] = useState<DevflowChannel[]>([]);
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
  }, []);

  const handleSubmit = async () => {
    if (!slackChannel.trim() || !devflowChannel.trim()) return;
    setSaving(true);
    setError('');
    try {
      await onAdd(slackChannel.trim(), devflowChannel.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add mapping');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 p-4 rounded-xl border border-violet-500/20 bg-violet-500/5">
      <p className="text-xs font-medium text-white/70 mb-3">Add Channel Mapping</p>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-white/50 mb-1">Slack Channel</label>
          <input
            type="text"
            value={slackChannel}
            onChange={(e) => setSlackChannel(e.target.value)}
            placeholder="#general"
            className="w-full px-3 py-2 rounded-lg text-sm text-white/80 placeholder:text-white/20 outline-none"
            style={{ background: 'rgba(10,20,40,0.5)', border: '1px solid rgba(139,92,246,0.2)' }}
          />
        </div>
        <div>
          <label className="block text-xs text-white/50 mb-1">{PRODUCT_NAME} Channel</label>
          {devflowChannels.length > 0 ? (
            <select
              value={devflowChannel}
              onChange={(e) => setDevflowChannel(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm text-white/80 outline-none"
              style={{ background: 'rgba(10,20,40,0.8)', border: '1px solid rgba(139,92,246,0.2)' }}
            >
              <option value="">Select channel...</option>
              {devflowChannels.map((c) => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={devflowChannel}
              onChange={(e) => setDevflowChannel(e.target.value)}
              placeholder="SG-1"
              className="w-full px-3 py-2 rounded-lg text-sm text-white/80 placeholder:text-white/20 outline-none"
              style={{ background: 'rgba(10,20,40,0.5)', border: '1px solid rgba(139,92,246,0.2)' }}
            />
          )}
        </div>
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
            disabled={saving || !slackChannel.trim() || !devflowChannel.trim()}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
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

export function SlackBridgePanel({ onSetup, onRefresh }: SlackBridgePanelProps) {
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [mappings, setMappings] = useState<SlackMapping[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bridges/slack/status');
      if (!res.ok) {
        setViewState('not_configured');
        setStatus(null);
        return;
      }
      const json: SlackStatus = await res.json();
      setStatus(json);
      setViewState(json.configured && json.connected ? 'connected' : 'not_configured');
    } catch {
      setViewState('not_configured');
      setStatus(null);
    }
  }, []);

  const fetchMappings = useCallback(async () => {
    try {
      const res = await fetch('/api/bridges/slack/mappings');
      if (!res.ok) return;
      const json: SlackMapping[] = await res.json();
      setMappings(Array.isArray(json) ? json : []);
    } catch {/* non-fatal */}
  }, []);

  const refresh = useCallback(async () => {
    await fetchStatus();
    await fetchMappings();
    onRefresh();
  }, [fetchStatus, fetchMappings, onRefresh]);

  useEffect(() => {
    fetchStatus();
    fetchMappings();
    pollRef.current = setInterval(fetchStatus, 30000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus, fetchMappings]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/bridges/slack/test', { method: 'POST' });
      const json = await res.json() as { success?: boolean; message?: string };
      setTestResult({ ok: !!json.success, message: json.message ?? (json.success ? 'Connection OK' : 'Test failed') });
    } catch {
      setTestResult({ ok: false, message: 'Request failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Slack? This will remove the bridge configuration.')) return;
    setDisconnecting(true);
    try {
      await fetch('/api/bridges/slack/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }),
      });
      await refresh();
    } catch {
      setErrorMessage('Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleAddMapping = async (slackChannelName: string, devflowChannelName: string) => {
    const res = await fetch('/api/bridges/slack/mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slackChannelName, devflowChannelName }),
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
      await fetch('/api/bridges/slack/mappings', {
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
        <p className="text-sm text-white/40">Checking Slack status...</p>
      </div>
    );
  }

  // ── Not Configured ──
  if (viewState === 'not_configured') {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 px-6 text-center">
        <div className="p-4 rounded-2xl bg-violet-500/10 border border-violet-500/20 mb-5">
          <SlackIcon className="w-12 h-12 text-violet-400" />
        </div>
        <h3 className="text-xl font-semibold text-white mb-2">Slack Bridge</h3>
        <p className="text-sm text-white/60 mb-7 max-w-xs leading-relaxed">
          Connect your Slack workspace so agents can send and receive messages in your channels.
        </p>
        <button
          onClick={onSetup}
          className="px-6 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white
            text-sm font-medium transition-all shadow-lg shadow-violet-500/20"
        >
          Set Up Slack
        </button>
      </div>
    );
  }

  // ── Error (fallback, shouldn't normally show) ──
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
            onClick={() => { setViewState('loading'); fetchStatus(); }}
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
        <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-500/15 border border-violet-500/20">
                <CheckCircle2 className="w-5 h-5 text-violet-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">{status?.workspaceName ?? 'Slack'}</p>
                {status?.botName && (
                  <p className="text-xs text-white/50">Bot: {status.botName}</p>
                )}
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
              bg-green-500/20 text-green-300 border border-green-500/30 text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              Connected
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 mb-4">
            <div className="px-3 py-2 rounded-lg bg-black/20 border border-white/5">
              <p className="text-[10px] text-white/40 uppercase tracking-wider mb-0.5">Socket Mode</p>
              <p className={`text-xs font-medium ${status?.socketMode ? 'text-violet-300' : 'text-white/50'}`}>
                {status?.socketMode ? 'Enabled' : 'Disabled'}
              </p>
            </div>
            <div className="px-3 py-2 rounded-lg bg-black/20 border border-white/5">
              <p className="text-[10px] text-white/40 uppercase tracking-wider mb-0.5">Mappings</p>
              <p className="text-xs font-medium text-white">
                {status?.activeMappings ?? mappings.length} active
              </p>
            </div>
          </div>

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
                border border-violet-500/30 text-violet-300 hover:bg-violet-500/15 transition-all
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
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs
                border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-all
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {disconnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Disconnect
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
                bg-violet-600/20 border border-violet-500/30 text-violet-300
                hover:bg-violet-600/30 transition-all"
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
              <p className="text-xs text-white/20 mt-1">Map a Slack channel to a {PRODUCT_NAME} collab channel</p>
            </div>
          ) : (
            <div className="space-y-1.5 mt-3">
              {mappings.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]"
                >
                  <span className="text-xs text-violet-300 font-medium truncate flex-1">
                    #{m.slackChannelName}
                  </span>
                  <ArrowLeftRight className="w-3.5 h-3.5 text-white/25 flex-shrink-0" />
                  <span className="text-xs text-white/70 truncate flex-1">{m.devflowChannelName}</span>
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

        {/* Last event */}
        {status?.lastEventAt && (
          <p className="text-xs text-white/30">
            Last event: {new Date(status.lastEventAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}
