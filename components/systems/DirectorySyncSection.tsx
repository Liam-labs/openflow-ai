'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  FolderSync, RefreshCw, Plus, Play, Eye, Settings, Trash2,
  CheckCircle2, XCircle, Loader2, Clock,
  ArrowRight,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────

interface SyncStats {
  filesCopied: number;
  bytesTransferred: number;
  durationMs: number;
}

interface SyncEvent {
  type: string;
  syncId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  sequence: number;
}

interface DirectorySyncPair {
  id: string;
  name: string;
  sourcePath: string;
  destPath: string;
  mode: 'watch' | 'periodic';
  intervalMinutes: number;
  enabled: boolean;
  exclusions: string[];
  status: 'idle' | 'syncing' | 'error';
  lastSync: string | null;
  lastError: string | null;
  stats: SyncStats;
}

type PathKind = 'windows' | 'wsl-mounted' | 'wsl-linux' | 'wsl-unc' | 'unknown';

// ─── Helpers ─────────────────────────────────────────────────────

function detectPathKind(path: string): PathKind {
  if (/^[A-Z]:\\/i.test(path)) return 'windows';
  if (/^\\\\wsl(\.localhost|\$)\\/i.test(path)) return 'wsl-unc';
  if (/^\/mnt\/[a-z]\//i.test(path)) return 'wsl-mounted';
  if (/^\//.test(path)) return 'wsl-linux';
  return 'unknown';
}

const PATH_KIND_LABEL: Record<PathKind, string> = {
  windows: 'Windows',
  'wsl-unc': 'Win → WSL',
  'wsl-mounted': 'WSL → Win',
  'wsl-linux': 'WSL/Linux',
  unknown: '—',
};

const PATH_KIND_CLASS: Record<PathKind, string> = {
  windows: 'ds-path-tag--win',
  'wsl-unc': 'ds-path-tag--wslunc',
  'wsl-mounted': 'ds-path-tag--wslm',
  'wsl-linux': 'ds-path-tag--wsl',
  unknown: '',
};

function formatBytes(n: number): string {
  if (!n) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

function formatDuration(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return 'Never';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function truncatePath(p: string, maxLen: number): string {
  if (p.length <= maxLen) return p;
  const keep = Math.floor((maxLen - 3) / 2);
  return p.slice(0, keep) + '…' + p.slice(p.length - keep);
}

// ─── Component ───────────────────────────────────────────────────

export function DirectorySyncSection() {
  const [pairs, setPairs] = useState<DirectorySyncPair[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showDelete, setShowDelete] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, SyncEvent[]>>({});

  // Create form state
  const [cName, setCName] = useState('');
  const [cSource, setCSource] = useState('');
  const [cDest, setCDest] = useState('');
  const [cMode, setCMode] = useState<'watch' | 'periodic'>('watch');
  const [cInterval, setCInterval] = useState(5);
  const [cExcl, setCExcl] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [cError, setCError] = useState<string | null>(null);

  // Edit form state (per expanded pair)
  const [editMode, setEditMode] = useState(false);
  const [eName, setEName] = useState('');
  const [eSource, setESource] = useState('');
  const [eDest, setEDest] = useState('');
  const [eMode, setEMode] = useState<'watch' | 'periodic'>('watch');
  const [eInterval, setEInterval] = useState(5);
  const [eExcl, setEExcl] = useState('');

  function openEdit(pair: DirectorySyncPair) {
    setEName(pair.name);
    setESource(pair.sourcePath);
    setEDest(pair.destPath);
    setEMode(pair.mode);
    setEInterval(pair.intervalMinutes);
    setEExcl(pair.exclusions.join(', '));
    setEditMode(true);
  }

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/directory-sync', { cache: 'no-store' });
      const j = await r.json();
      if (j.success) {
        setPairs((j.pairs ?? []) as DirectorySyncPair[]);
        setError(null);
      } else {
        setError(j.error ?? 'Failed to load');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  // Poll events frequently when any pair is syncing for live progress
  useEffect(() => {
    const syncingIds = pairs.filter(p => p.status === 'syncing').map(p => p.id);
    if (syncingIds.length === 0) return;
    const id = setInterval(() => {
      syncingIds.forEach(fetchEvents);
    }, 1500);
    return () => clearInterval(id);
  }, [pairs]);

  async function apiCall(action: string, body: Record<string, unknown> = {}) {
    const r = await fetch('/api/directory-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    return r.json();
  }

  async function togglePair(id: string, enabled: boolean) {
    setBusyTarget(id);
    try {
      const j = await apiCall('toggle', { id, enabled });
      if (!j.success) setError(j.error ?? 'Toggle failed');
      await refresh();
    } finally {
      setBusyTarget(null);
    }
  }

  async function runNow(id: string) {
    setBusyTarget(`run-${id}`);
    try {
      await apiCall('run-now', { id });
      await refresh();
    } finally {
      setBusyTarget(null);
    }
  }

  async function dryRun(id: string) {
    setBusyTarget(`dry-${id}`);
    try {
      const j = await apiCall('dry-run', { id });
      if (j.success && j.report) {
        alert(`Dry run for "${j.pairName ?? id}":\n${j.report}`);
      } else {
        setError(j.error ?? 'Dry run failed');
      }
      await refresh();
    } finally {
      setBusyTarget(null);
    }
  }

  async function fetchEvents(id: string) {
    try {
      // Fetch from GET endpoint — events are polled with ?since= param
      const r = await fetch(`/api/directory-sync?since=${encodeURIComponent(new Date(Date.now() - 3600000).toISOString())}`, { cache: 'no-store' });
      const j = await r.json();
      if (j.success && j.events) {
        const relevant = (j.events as SyncEvent[]).filter(e => e.syncId === id);
        setEvents(prev => ({ ...prev, [id]: relevant }));
      }
    } catch { /* silent */ }
  }

  function handleExpand(id: string) {
    if (expanded === id) {
      setExpanded(null);
      setEditMode(false);
    } else {
      setExpanded(id);
      setEditMode(false);
      fetchEvents(id);
    }
  }

  async function handleCreate() {
    setCBusy(true);
    setCError(null);
    try {
      const j = await apiCall('create', {
        name: cName,
        sourcePath: cSource,
        destPath: cDest,
        mode: cMode,
        intervalMinutes: cInterval,
        exclusions: cExcl.split(',').map(s => s.trim()).filter(Boolean),
      });
      if (j.success) {
        setShowCreate(false);
        setCName(''); setCSource(''); setCDest(''); setCMode('watch'); setCInterval(5); setCExcl('');
        refresh();
      } else {
        setCError(j.error ?? 'Create failed');
      }
    } catch {
      setCError('Network error');
    } finally {
      setCBusy(false);
    }
  }

  async function handleEditSave(id: string) {
    await apiCall('update', {
      id,
      name: eName,
      sourcePath: eSource,
      destPath: eDest,
      mode: eMode,
      intervalMinutes: eInterval,
      exclusions: eExcl.split(',').map(s => s.trim()).filter(Boolean),
    });
    setEditMode(false);
    refresh();
  }

  async function handleDelete(id: string) {
    setBusyTarget(`delete-${id}`);
    try {
      const j = await apiCall('delete', { id });
      if (!j.success) {
        setError(j.error ?? 'Delete failed');
        return;
      }
      setShowDelete(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusyTarget(null);
    }
  }

  const onlineCount = pairs.filter(p => p.enabled).length;
  const syncingCount = pairs.filter(p => p.status === 'syncing').length;
  const errorCount = pairs.filter(p => p.status === 'error').length;

  // Render helpers (inlined to stay in styled-jsx scope)

  function renderToggle(checked: boolean, onChange: (v: boolean) => void, busy?: boolean) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={busy}
        onClick={() => onChange(!checked)}
        className={`ds-toggle ${checked ? 'ds-toggle--on' : ''} ${busy ? 'ds-toggle--busy' : ''}`}
      >
        <span className="ds-toggle-knob" />
      </button>
    );
  }

  function renderPathField(label: string, value: string, onChange: (v: string) => void) {
    const kind = detectPathKind(value);
    return (
      <div className="ds-form-field">
        <label className="ds-form-label">
          {label}
          {value.length > 0 && kind !== 'unknown' && (
            <span className={`ds-path-kind-tag ${PATH_KIND_CLASS[kind]}`}>{PATH_KIND_LABEL[kind]}</span>
          )}
        </label>
        <input
          className="ds-form-input"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="/home/you/… or C:\Users\… or \\wsl.localhost\Ubuntu\…"
          spellCheck={false}
        />
        {value.length > 0 && kind === 'unknown' && (
          <div style={{ fontSize: 10, color: 'var(--df-warning)', marginTop: 2 }}>
            Path type not recognised — expected C:\, \\wsl.localhost\…, /mnt/[drive]/, or /…
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="ds-section">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="ds-header">
        <div>
          <div className="ds-eyebrow">Systems · Automation</div>
          <h1 className="ds-title"><FolderSync size={18} /> Directory Sync</h1>
          <p className="ds-sub">
            Keep folders synchronised between WSL, Windows, and project directories.
            Configure watch or periodic sync pairs with exclusions and dry-run previews.
          </p>
        </div>
        <div className="ds-header-actions">
          <button className="ds-btn-ghost" onClick={refresh} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'ds-spin' : ''} /> Refresh
          </button>
          <button className="ds-btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> New Pair
          </button>
        </div>
      </header>

      {/* ── Stat Row ───────────────────────────────────────── */}
      <div className="ds-stat-row">
        <div className="ds-stat">
          <div className="ds-stat-label">Sync pairs</div>
          <div className="ds-stat-value">{onlineCount}<span className="ds-stat-suffix">/{pairs.length} active</span></div>
        </div>
        <div className="ds-stat">
          <div className="ds-stat-label">Syncing now</div>
          <div className="ds-stat-value">{syncingCount}</div>
        </div>
        <div className="ds-stat">
          <div className="ds-stat-label">Errors</div>
          <div className="ds-stat-value" style={{ color: errorCount > 0 ? 'var(--df-error)' : undefined }}>{errorCount}</div>
        </div>
        <div className="ds-stat">
          <div className="ds-stat-label">Total files copied</div>
          <div className="ds-stat-value">
            {pairs.reduce((acc, p) => acc + (p.stats?.filesCopied ?? 0), 0).toLocaleString()}
          </div>
        </div>
      </div>

      {error && <div className="ds-error">{error}</div>}

      {/* ── Empty State ─────────────────────────────────────── */}
      {!loading && pairs.length === 0 && !showCreate && (
        <div className="ds-empty-state">
          <FolderSync size={32} className="ds-empty-icon" />
          <div className="ds-empty-title">No sync pairs configured</div>
          <p className="ds-empty-desc">
            Create a sync pair to keep folders in sync between WSL and Windows,
            or between project directories.
          </p>
          <button className="ds-btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> Create your first sync pair
          </button>
        </div>
      )}

      {/* ── Create Form ─────────────────────────────────────── */}
      {showCreate && (
        <div className="ds-form-overlay">
          <div className="ds-form-title"><Plus size={14} /> New Sync Pair</div>
          {cError && <div className="ds-error" style={{ marginBottom: 12 }}>{cError}</div>}
          <div className="ds-form-grid">
            <div className="ds-form-field">
              <label className="ds-form-label">Name</label>
              <input className="ds-form-input" placeholder="e.g. Project backups" value={cName} onChange={e => setCName(e.target.value)} />
            </div>
            <div className="ds-form-field">
              <label className="ds-form-label">Mode</label>
              <select className="ds-form-select" value={cMode} onChange={e => setCMode(e.target.value as 'watch' | 'periodic')}>
                <option value="watch">Watch (real-time)</option>
                <option value="periodic">Periodic</option>
              </select>
            </div>
            {renderPathField('Source Path', cSource, setCSource)}
            {renderPathField('Destination Path', cDest, setCDest)}
            {cMode === 'periodic' && (
              <div className="ds-form-field">
                <label className="ds-form-label">Interval (minutes)</label>
                <input className="ds-form-input" type="number" min={1} max={1440} value={cInterval} onChange={e => setCInterval(Number(e.target.value) || 5)} />
              </div>
            )}
            <div className="ds-form-field ds-form-field--wide">
              <label className="ds-form-label">Exclusion patterns <span className="ds-form-hint">comma-separated: *.tmp, node_modules/**</span></label>
              <input className="ds-form-input" value={cExcl} onChange={e => setCExcl(e.target.value)} />
            </div>
          </div>
          <div className="ds-form-actions">
            <button className="ds-btn-ghost" onClick={() => setShowCreate(false)} disabled={cBusy}>Cancel</button>
            <button className="ds-btn-primary" onClick={handleCreate} disabled={cBusy || !cName || !cSource || !cDest}>
              {cBusy ? <><Loader2 size={12} className="ds-spin" /> Creating…</> : <><Plus size={12} /> Create Pair</>}
            </button>
          </div>
        </div>
      )}

      {/* ── Sync Pair Cards ─────────────────────────────────── */}
      <div className="ds-cards">
        {pairs.map((pair) => (
          <div key={pair.id}>
            <div className={`ds-card ${!pair.enabled ? 'ds-card--disabled' : ''} ${pair.status === 'error' ? 'ds-card--error' : ''}`}>
              {/* Card main row */}
              <div
                className="ds-card-main"
                onClick={() => handleExpand(pair.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleExpand(pair.id); } }}
                role="button" tabIndex={0}
              >
                <div className="ds-card-toggle" onClick={e => e.stopPropagation()}>
                  {renderToggle(pair.enabled, (v) => togglePair(pair.id, v), busyTarget === pair.id)}
                </div>

                <div className="ds-card-info">
                  <div className="ds-card-name">
                    {pair.name}
                    {pair.status === 'syncing' && <Loader2 size={12} className="ds-spin" style={{ marginLeft: 6, color: 'var(--df-accent)' }} />}
                  </div>
                  <div className="ds-card-paths">
                    <span className={`ds-path-tag ${PATH_KIND_CLASS[detectPathKind(pair.sourcePath)]}`}>{PATH_KIND_LABEL[detectPathKind(pair.sourcePath)]}</span>
                    <span className="ds-path-text" title={pair.sourcePath}>{truncatePath(pair.sourcePath, 36)}</span>
                    <ArrowRight size={10} className="ds-path-arrow" />
                    <span className={`ds-path-tag ${PATH_KIND_CLASS[detectPathKind(pair.destPath)]}`}>{PATH_KIND_LABEL[detectPathKind(pair.destPath)]}</span>
                    <span className="ds-path-text" title={pair.destPath}>{truncatePath(pair.destPath, 36)}</span>
                  </div>
                </div>

                <div className="ds-card-badges">
                  <span className={`ds-mode-badge ds-mode-badge--${pair.mode}`}>
                    {pair.mode === 'watch' ? <><Eye size={10} /> Watch</> : <><Clock size={10} /> Every {pair.intervalMinutes}m</>}
                  </span>
                  <span className={`ds-status-badge ds-status-badge--${pair.status}`}>
                    {pair.status === 'idle' && <CheckCircle2 size={10} />}
                    {pair.status === 'syncing' && <Loader2 size={10} className="ds-spin" />}
                    {pair.status === 'error' && <XCircle size={10} />}
                    {pair.status}
                  </span>
                </div>

                <div className="ds-card-last">
                  <span className="ds-last-label">Last sync</span>
                  <span className="ds-last-value">{formatTimestamp(pair.lastSync)}</span>
                </div>

                <div className="ds-card-actions" onClick={e => e.stopPropagation()}>
                  <button className="ds-icon-btn" title="Edit" onClick={() => openEdit(pair)}>
                    <Settings size={13} />
                  </button>
                  <button className="ds-icon-btn" title="Sync Now" disabled={!pair.enabled || busyTarget === `run-${pair.id}`} onClick={() => runNow(pair.id)}>
                    <Play size={13} />
                  </button>
                  <button className="ds-icon-btn" title="Dry Run" disabled={busyTarget === `dry-${pair.id}`} onClick={() => dryRun(pair.id)}>
                    <Eye size={13} />
                  </button>
                  <button className="ds-icon-btn ds-icon-btn--danger" title="Delete" onClick={() => setShowDelete(pair.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>

                <div className="ds-card-chevron">
                  <span className={`ds-chevron ${expanded === pair.id ? 'ds-chevron--open' : ''}`}>▸</span>
                </div>
              </div>

              {/* Expand detail */}
              {expanded === pair.id && (
                <div className="ds-detail">
                  {editMode ? (
                    /* Edit form */
                    <div className="ds-form-overlay" style={{ marginTop: 0 }}>
                      <div className="ds-form-title"><Settings size={14} /> Edit {pair.name}</div>
                      <div className="ds-form-grid">
                        <div className="ds-form-field">
                          <label className="ds-form-label">Name</label>
                          <input className="ds-form-input" value={eName} onChange={e => setEName(e.target.value)} />
                        </div>
                        <div className="ds-form-field">
                          <label className="ds-form-label">Mode</label>
                          <select className="ds-form-select" value={eMode} onChange={e => setEMode(e.target.value as 'watch' | 'periodic')}>
                            <option value="watch">Watch</option>
                            <option value="periodic">Periodic</option>
                          </select>
                        </div>
                        {renderPathField('Source Path', eSource, setESource)}
                        {renderPathField('Destination Path', eDest, setEDest)}
                        {eMode === 'periodic' && (
                          <div className="ds-form-field">
                            <label className="ds-form-label">Interval (minutes)</label>
                            <input className="ds-form-input" type="number" min={1} value={eInterval} onChange={e => setEInterval(Number(e.target.value) || 1)} />
                          </div>
                        )}
                        <div className="ds-form-field ds-form-field--wide">
                          <label className="ds-form-label">Exclusion patterns <span className="ds-form-hint">comma-separated globs: *.tmp, node_modules/**</span></label>
                          <input className="ds-form-input" value={eExcl} onChange={e => setEExcl(e.target.value)} />
                        </div>
                      </div>
                      <div className="ds-form-actions">
                        <button className="ds-btn-ghost" onClick={() => setEditMode(false)}>Cancel</button>
                        <button className="ds-btn-primary" onClick={() => handleEditSave(pair.id)}>Save Changes</button>
                      </div>
                    </div>
                  ) : (
                    /* Detail view */
                    <>
                      <div className="ds-detail-grid">
                        <div><span className="ds-detail-label">Source</span><div className="ds-detail-value"><code>{pair.sourcePath}</code></div></div>
                        <div><span className="ds-detail-label">Destination</span><div className="ds-detail-value"><code>{pair.destPath}</code></div></div>
                        <div><span className="ds-detail-label">Mode</span><div className="ds-detail-value">{pair.mode === 'watch' ? 'Watch (real-time)' : `Periodic (every ${pair.intervalMinutes}m)`}</div></div>
                        <div><span className="ds-detail-label">Exclusions</span><div className="ds-detail-value">{pair.exclusions.length > 0 ? pair.exclusions.join(', ') : 'None'}</div></div>
                        {pair.lastError && (
                          <div style={{ gridColumn: 'span 2' }}>
                            <span className="ds-detail-label">Last error</span>
                            <div className="ds-detail-value" style={{ color: '#f87171' }}>{pair.lastError}</div>
                          </div>
                        )}
                      </div>

                      {/* Live progress bar — visible while syncing */}
                      {pair.status === 'syncing' && (() => {
                        const pairEvents = events[pair.id] ?? [];
                        const progressEvents = pairEvents.filter(e => e.type === 'sync-progress');
                        const latest = progressEvents[progressEvents.length - 1];
                        const filesProcessed = latest ? (latest.payload.filesProcessed as number) : 0;
                        const elapsedMs = latest ? (latest.payload.elapsedMs as number) : 0;
                        // Total file count from last completed sync, or fallback
                        const completeEvents = pairEvents.filter(e => e.type === 'sync-complete');
                        const lastComplete = completeEvents[completeEvents.length - 1];
                        const totalFiles = lastComplete ? (lastComplete.payload.fileCount as number) : null;
                        const pct = totalFiles ? Math.min(100, Math.round((filesProcessed / totalFiles) * 100)) : null;
                        return (
                          <div className="ds-live-progress">
                            <div className="ds-live-header">
                              <Loader2 size={14} className="ds-spin" style={{ color: 'var(--df-accent)' }} />
                              <span className="ds-live-title">Syncing files…</span>
                              <span className="ds-live-elapsed">{formatDuration(elapsedMs)} elapsed</span>
                            </div>
                            <div className="ds-live-count">
                              <span className="ds-live-count-value">{filesProcessed.toLocaleString()}</span>
                              <span className="ds-live-count-label">files processed</span>
                              {totalFiles && (
                                <span className="ds-live-count-total">of {totalFiles.toLocaleString()} total</span>
                              )}
                            </div>
                            {pct !== null && (
                              <div className="ds-progress-bar">
                                <div className="ds-progress-fill" style={{ width: `${pct}%` }} />
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Stats — always visible */}
                      <div className="ds-detail-stats">
                        <div className="ds-stat-card">
                          <div className="ds-stat-card-value">{(pair.stats?.filesCopied ?? 0).toLocaleString()}</div>
                          <div className="ds-stat-card-label">Files copied</div>
                        </div>
                        <div className="ds-stat-card">
                          <div className="ds-stat-card-value">{formatBytes(pair.stats?.bytesTransferred ?? 0)}</div>
                          <div className="ds-stat-card-label">Data transferred</div>
                        </div>
                        <div className="ds-stat-card">
                          <div className="ds-stat-card-value">{formatDuration(pair.stats?.durationMs ?? 0)}</div>
                          <div className="ds-stat-card-label">Last duration</div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                        <button className="ds-btn-primary" onClick={() => runNow(pair.id)} disabled={!pair.enabled || busyTarget === `run-${pair.id}`}>
                          <Play size={12} /> Sync Now
                        </button>
                        <button className="ds-btn-ghost" onClick={() => dryRun(pair.id)} disabled={busyTarget === `dry-${pair.id}`}>
                          <Eye size={12} /> Dry Run
                        </button>
                        <button className="ds-btn-ghost" onClick={() => openEdit(pair)}>
                          <Settings size={12} /> Edit
                        </button>
                      </div>

                      {/* Recent events — now shows meaningful info */}
                      {(() => {
                        const pairEvents = events[pair.id] ?? [];
                        const recent = pairEvents.slice(-8).reverse();
                        if (recent.length === 0) return <div className="ds-events-title">Recent Activity</div>;
                        return (
                          <>
                            <div className="ds-events-title">Recent Activity</div>
                            {recent.map((ev, i) => {
                              const p = ev.payload ?? {};
                              // Build a human-readable line for each event type
                              let line = '';
                              let badge = '';
                              let badgeClass = '';
                              switch (ev.type) {
                                case 'sync-start':
                                  line = 'Sync started';
                                  badge = 'start';
                                  badgeClass = 'ds-event-badge--sync';
                                  break;
                                case 'sync-complete':
                                  line = [`${(p.filesCopied as number) ?? 0} files copied`, (p.filesDeleted as number) ? `, ${p.filesDeleted} deleted` : '', ` in ${formatDuration((p.durationMs as number) ?? 0)}`].join('');
                                  badge = 'done';
                                  badgeClass = 'ds-event-badge--sync';
                                  break;
                                case 'sync-progress':
                                  line = `${((p.filesProcessed as number) ?? 0).toLocaleString()} files processed`;
                                  badge = 'progress';
                                  badgeClass = 'ds-event-badge--progress';
                                  break;
                                case 'sync-error':
                                  line = (p.error as string) ?? 'Sync failed';
                                  badge = 'error';
                                  badgeClass = 'ds-event-badge--error';
                                  break;
                                default:
                                  line = ev.type;
                                  badge = ev.type;
                              }
                              return (
                                <div key={i} className="ds-event-row">
                                  <span className="ds-event-time">{formatTimestamp(ev.timestamp)}</span>
                                  {badge && <span className={`ds-event-badge ${badgeClass}`}>{badge}</span>}
                                  <span className="ds-event-msg">{line}</span>
                                </div>
                              );
                            })}
                          </>
                        );
                      })()}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ── Delete Confirm Modal ────────────────────────────── */}
      {showDelete && (
        <div className="ds-modal-backdrop" onClick={() => setShowDelete(null)}>
          <div className="ds-modal" onClick={e => e.stopPropagation()}>
            <div className="ds-modal-title">Delete sync pair?</div>
            <div className="ds-modal-body">
              This will permanently delete <strong style={{ color: 'var(--df-text)' }}>{pairs.find(p => p.id === showDelete)?.name ?? showDelete}</strong>.
              No files will be deleted — only the sync configuration is removed.
            </div>
            <div className="ds-modal-actions">
              <button className="ds-btn-ghost" onClick={() => setShowDelete(null)} disabled={busyTarget === `delete-${showDelete}`}>Cancel</button>
              <button className="ds-btn-danger" onClick={() => handleDelete(showDelete)} disabled={busyTarget === `delete-${showDelete}`}>
                {busyTarget === `delete-${showDelete}` ? <><Loader2 size={12} className="ds-spin" /> Deleting…</> : <><Trash2 size={12} /> Delete</>}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        /* ── Section ─────────────────────────────────────── */
        .ds-section { padding: 24px 28px 48px; max-width: 1280px; }

        /* ── Header ──────────────────────────────────────── */
        .ds-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
        .ds-header-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
        .ds-eyebrow { font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--df-text-muted); font-weight: 600; }
        .ds-title { display: flex; align-items: center; gap: 8px; font-size: 22px; font-weight: 600; margin: 4px 0 6px; color: var(--df-text); letter-spacing: -0.3px; }
        .ds-sub { font-size: 13px; color: var(--df-text-secondary); max-width: 720px; line-height: 1.5; margin: 0; }

        /* ── Buttons ──────────────────────────────────────── */
        .ds-btn-primary {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 14px; background: var(--df-accent); color: #fff;
          border: none; border-radius: 6px; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: all 140ms ease;
        }
        .ds-btn-primary:hover { background: var(--df-accent-hover); }
        .ds-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

        .ds-btn-ghost {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 12px; background: transparent;
          border: 1px solid var(--df-border-subtle); border-radius: 6px;
          color: var(--df-text-secondary); font-size: 12px; cursor: pointer;
          transition: all 140ms ease;
        }
        .ds-btn-ghost:hover { background: var(--df-accent-10); color: var(--df-text); }
        .ds-btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }

        .ds-btn-danger {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 14px;
          background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3);
          border-radius: 6px; color: #f87171; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: all 140ms ease;
        }
        .ds-btn-danger:hover { background: rgba(239,68,68,0.25); }

        /* ── Stat Row ──────────────────────────────────────── */
        .ds-stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 16px 0 28px; }
        .ds-stat { padding: 14px 16px; background: rgba(15,25,50,0.4); border: 1px solid var(--df-border-subtle); border-radius: 8px; }
        .ds-stat-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--df-text-muted); font-weight: 600; margin-bottom: 6px; }
        .ds-stat-value { font-size: 20px; font-weight: 600; color: var(--df-text); font-family: var(--font-mono, monospace); }
        .ds-stat-suffix { font-size: 13px; color: var(--df-text-muted); margin-left: 4px; }

        /* ── Icon Button ───────────────────────────────────── */
        .ds-icon-btn {
          background: transparent; border: 1px solid var(--df-border-subtle);
          border-radius: 6px; width: 26px; height: 26px;
          display: flex; align-items: center; justify-content: center;
          color: var(--df-text-secondary); cursor: pointer;
          transition: all 140ms ease;
        }
        .ds-icon-btn:hover { background: var(--df-accent-10); color: var(--df-text); border-color: var(--df-accent); }
        .ds-icon-btn--danger:hover { background: rgba(239,68,68,0.1); color: #f87171; border-color: rgba(239,68,68,0.4); }
        .ds-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .ds-error { padding: 12px 16px; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 8px; color: #f87171; font-size: 12px; margin-bottom: 16px; }

        /* ── Empty State ──────────────────────────────────── */
        .ds-empty-state { text-align: center; padding: 64px 24px; }
        .ds-empty-icon { color: var(--df-text-muted); margin-bottom: 12px; opacity: 0.5; }
        .ds-empty-title { font-size: 16px; font-weight: 600; color: var(--df-text); margin-bottom: 6px; }
        .ds-empty-desc { font-size: 12px; color: var(--df-text-secondary); max-width: 420px; margin: 0 auto 20px; line-height: 1.5; }

        /* ── Cards ────────────────────────────────────────── */
        .ds-cards { display: flex; flex-direction: column; gap: 8px; }
        .ds-card {
          background: rgba(15,25,50,0.3); border: 1px solid var(--df-border-subtle);
          border-radius: 8px; overflow: hidden;
          transition: border-color 150ms ease;
        }
        .ds-card:hover { border-color: var(--df-border-hover); }
        .ds-card--disabled { opacity: 0.55; }
        .ds-card--error { border-color: rgba(239,68,68,0.3); }
        .ds-card-main {
          display: grid;
          grid-template-columns: 40px 1.6fr 1.4fr 0.9fr 1fr 24px;
          gap: 12px; padding: 12px 14px;
          align-items: center; font-size: 12px;
          cursor: pointer; transition: background 120ms ease;
        }
        .ds-card-main:hover { background: var(--df-accent-5); }
        .ds-card-main:focus-visible { outline: 2px solid var(--df-accent); outline-offset: -2px; border-radius: 7px; }

        .ds-card-toggle { display: flex; align-items: center; justify-content: center; }
        .ds-card-info { min-width: 0; }
        .ds-card-name { font-weight: 600; color: var(--df-text); display: flex; align-items: center; margin-bottom: 4px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ds-card--disabled .ds-card-name { color: var(--df-text-muted); }
        .ds-card-paths { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }

        .ds-path-text {
          font-family: var(--font-mono, monospace); font-size: 10px;
          color: var(--df-text-secondary);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px;
        }
        .ds-path-arrow { color: var(--df-text-dim); flex-shrink: 0; }
        .ds-path-tag {
          font-size: 9px; font-weight: 600; letter-spacing: 0.5px;
          padding: 1px 5px; border-radius: 3px;
          background: var(--df-accent-8); color: var(--df-text-secondary); flex-shrink: 0;
        }
        .ds-path-tag--win { background: rgba(59,130,246,0.18); color: #60a5fa; }
        .ds-path-tag--wslunc { background: rgba(59,130,246,0.18); color: #60a5fa; }
        .ds-path-tag--wslm { background: rgba(34,197,94,0.15); color: #4ade80; }
        .ds-path-tag--wsl { background: rgba(168,85,247,0.18); color: #c084fc; }

        .ds-card-badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
        .ds-mode-badge {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 500;
        }
        .ds-mode-badge--watch { background: rgba(34,197,94,0.12); color: #4ade80; border: 1px solid rgba(34,197,94,0.25); }
        .ds-mode-badge--periodic { background: rgba(59,130,246,0.12); color: #60a5fa; border: 1px solid rgba(59,130,246,0.25); }

        .ds-status-badge {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 500;
        }
        .ds-status-badge--idle { background: rgba(161,161,170,0.1); color: var(--df-text-secondary); border: 1px solid rgba(161,161,170,0.2); }
        .ds-status-badge--syncing { background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); }
        .ds-status-badge--error { background: rgba(239,68,68,0.12); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }

        .ds-card-last { display: flex; flex-direction: column; gap: 1px; }
        .ds-last-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--df-text-muted); }
        .ds-last-value { font-size: 11px; color: var(--df-text-secondary); white-space: nowrap; }

        .ds-card-actions { display: flex; gap: 4px; }
        .ds-card-chevron { display: flex; align-items: center; justify-content: center; }
        .ds-chevron { display: inline-block; font-size: 10px; color: var(--df-text-muted); transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1); }
        .ds-chevron--open { transform: rotate(90deg); }

        /* ── Detail Panel ─────────────────────────────────── */
        .ds-detail { padding: 16px 18px; background: rgba(0,0,0,0.25); border-top: 1px solid var(--df-border-subtle); }
        .ds-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px 24px; margin-bottom: 20px; }
        .ds-detail-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--df-text-muted); font-weight: 600; display: block; margin-bottom: 4px; }
        .ds-detail-value { font-size: 12px; color: var(--df-text); }
        .ds-detail-value code { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--df-text-secondary); background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 3px; }

        .ds-detail-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
        .ds-stat-card { padding: 12px; background: rgba(0,0,0,0.2); border: 1px solid var(--df-border-subtle); border-radius: 6px; text-align: center; }
        .ds-stat-card-value { font-size: 18px; font-weight: 600; color: var(--df-text); font-family: var(--font-mono, monospace); }
        .ds-stat-card-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--df-text-muted); margin-top: 4px; }

        .ds-events-title { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--df-text-muted); font-weight: 600; margin-bottom: 8px; }
        .ds-event-row { display: flex; align-items: center; gap: 10px; padding: 6px 10px; font-size: 11px; color: var(--df-text-secondary); border-top: 1px solid rgba(255,255,255,0.03); }
        .ds-event-row:first-child { border-top: none; }
        .ds-event-time { font-family: var(--font-mono, monospace); font-size: 10px; color: var(--df-text-muted); width: 70px; flex-shrink: 0; }
        .ds-event-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ds-event-badge { font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: 3px; text-transform: uppercase; flex-shrink: 0; }
        .ds-event-badge--sync { background: rgba(34,197,94,0.12); color: #4ade80; }
        .ds-event-badge--dry-run { background: rgba(59,130,246,0.12); color: #60a5fa; }
        .ds-event-badge--error { background: rgba(239,68,68,0.12); color: #f87171; }
        .ds-event-badge--progress { background: rgba(59,130,246,0.12); color: #60a5fa; }
        .ds-event-badge--toggle { background: rgba(161,161,170,0.1); color: var(--df-text-muted); }
        .ds-no-events { padding: 10px; color: var(--df-text-muted); font-size: 11px; font-style: italic; }

        /* ── Live sync progress ─────────────────────────────── */
        .ds-live-progress {
          margin-bottom: 20px; padding: 16px;
          background: rgba(59,130,246,0.06); border: 1px solid rgba(59,130,246,0.2);
          border-radius: 8px;
        }
        .ds-live-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
        .ds-live-title { font-size: 13px; font-weight: 600; color: var(--df-text); }
        .ds-live-elapsed { font-size: 11px; color: var(--df-text-muted); margin-left: auto; font-family: var(--font-mono, monospace); }
        .ds-live-count { display: flex; align-items: baseline; gap: 6px; margin-bottom: 10px; }
        .ds-live-count-value { font-size: 28px; font-weight: 600; color: var(--df-accent); font-family: var(--font-mono, monospace); letter-spacing: -0.5px; }
        .ds-live-count-label { font-size: 12px; color: var(--df-text-secondary); }
        .ds-live-count-total { font-size: 12px; color: var(--df-text-muted); }
        .ds-progress-bar { height: 4px; background: rgba(59,130,246,0.12); border-radius: 2px; overflow: hidden; }
        .ds-progress-fill { height: 100%; background: var(--df-accent); border-radius: 2px; transition: width 500ms cubic-bezier(0.16, 1, 0.3, 1); }

        /* ── Forms ─────────────────────────────────────────── */
        .ds-form-overlay { margin-bottom: 12px; background: var(--df-surface, rgba(15,25,50,0.5)); border: 1px solid var(--df-border); border-radius: 10px; padding: 20px; }
        .ds-form-title { font-size: 15px; font-weight: 600; color: var(--df-text); margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
        .ds-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .ds-form-field { display: flex; flex-direction: column; gap: 4px; }
        .ds-form-field--wide { grid-column: span 2; }
        .ds-form-label { font-size: 11px; font-weight: 500; color: var(--df-text-secondary); display: flex; align-items: center; gap: 8px; }
        .ds-form-input {
          height: 32px; padding: 0 10px;
          background: var(--df-surface-input, rgba(10,20,40,0.4));
          border: 1px solid var(--df-border-subtle); border-radius: 6px;
          color: var(--df-text); font-size: 12px; font-family: var(--font-mono, monospace);
          transition: border-color 150ms ease;
        }
        .ds-form-input:focus { outline: none; border-color: var(--df-accent); }
        .ds-form-input::placeholder { color: var(--df-text-dim); }
        .ds-form-select {
          height: 32px; padding: 0 8px;
          background: var(--df-surface-input); border: 1px solid var(--df-border-subtle);
          border-radius: 6px; color: var(--df-text); font-size: 12px;
          transition: border-color 150ms ease;
        }
        .ds-form-select:focus { outline: none; border-color: var(--df-accent); }
        .ds-form-hint { font-size: 10px; color: var(--df-text-dim); }
        .ds-path-kind-tag { font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 3px; flex-shrink: 0; }
        .ds-form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

        /* ── Modal ─────────────────────────────────────────── */
        .ds-modal-backdrop {
          position: fixed; inset: 0; z-index: 100;
          background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
          display: flex; align-items: center; justify-content: center;
        }
        .ds-modal {
          background: var(--df-surface, #18181d); border: 1px solid var(--df-border);
          border-radius: 10px; padding: 24px; max-width: 400px; width: 90%;
          box-shadow: 0 16px 48px rgba(0,0,0,0.6);
        }
        .ds-modal-title { font-size: 15px; font-weight: 600; color: var(--df-text); margin-bottom: 8px; }
        .ds-modal-body { font-size: 12px; color: var(--df-text-secondary); line-height: 1.5; margin-bottom: 16px; }
        .ds-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }

        /* ── Spinner ───────────────────────────────────────── */
        .ds-spin { animation: ds-spin 1s linear infinite; }
        @keyframes ds-spin { to { transform: rotate(360deg); } }

        /* ── Toggle ────────────────────────────────────────── */
        .ds-toggle { position: relative; width: 36px; height: 20px; border-radius: 999px; background: rgba(161,161,170,0.25); border: 1px solid rgba(161,161,170,0.3); cursor: pointer; transition: all 180ms ease; padding: 0; flex-shrink: 0; }
        .ds-toggle--on { background: rgba(34,197,94,0.45); border-color: rgba(34,197,94,0.6); }
        .ds-toggle--busy { opacity: 0.5; cursor: wait; }
        .ds-toggle-knob { position: absolute; top: 1px; left: 1px; width: 16px; height: 16px; background: white; border-radius: 50%; transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1); box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
        .ds-toggle--on .ds-toggle-knob { transform: translateX(16px); }

        /* ── Responsive ───────────────────────────────────── */
        @media (max-width: 900px) {
          .ds-card-main { grid-template-columns: 40px 1fr auto; gap: 8px; padding: 10px; }
          .ds-card-badges, .ds-card-last, .ds-card-chevron { display: none; }
          .ds-form-grid { grid-template-columns: 1fr; }
          .ds-form-field--wide { grid-column: span 1; }
          .ds-detail-stats { grid-template-columns: 1fr; }
          .ds-header { flex-direction: column; }
          .ds-header-actions { width: 100%; justify-content: flex-start; }
        }

        /* ── Focus-visible ─────────────────────────────────── */
        .ds-btn-primary:focus-visible,
        .ds-btn-ghost:focus-visible,
        .ds-btn-danger:focus-visible { outline: 2px solid var(--df-accent); outline-offset: 2px; }
        .ds-form-input:focus-visible,
        .ds-form-select:focus-visible { outline: 2px solid var(--df-accent); outline-offset: 0; }
        .ds-icon-btn:focus-visible { outline: 2px solid var(--df-accent); outline-offset: 1px; }
        .ds-toggle:focus-visible { outline: 2px solid var(--df-accent); outline-offset: 2px; }
      `}</style>
    </div>
  );
}
