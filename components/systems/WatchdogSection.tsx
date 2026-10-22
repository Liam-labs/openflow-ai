'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Shield, RotateCw, CheckCircle, XCircle, AlertTriangle, Pause, RefreshCw, Eye, Clock, Zap, Plus } from 'lucide-react';
import { useEventStream } from '@/lib/contexts/EventStreamContext';
import type { WatchdogState, WatchdogEvent, WatchdogEventType, Project } from '@/lib/types';
import { DataTable, StatusBadge } from './DataTable';
import type { ColumnDef } from './DataTable';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WatchdogSSEData {
  event?: WatchdogEvent;
  states?: WatchdogState[];
  timestamp?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveStatus(state: WatchdogState): string {
  if (state.circuitBroken) return 'errored';
  const inCooldown = state.cooldownUntil && new Date(state.cooldownUntil).getTime() > Date.now();
  if (inCooldown) return 'warning';
  if (state.lastCheckStatus === 'online') return 'online';
  if (state.lastCheckStatus === 'offline') return 'errored';
  return 'unknown';
}

const EVENT_ICON: Record<WatchdogEventType, React.ReactNode> = {
  restart_attempt: <RotateCw size={13} style={{ color: '#3b82f6' }} />,
  restart_success: <CheckCircle size={13} style={{ color: '#22c55e' }} />,
  restart_failed:  <XCircle size={13} style={{ color: '#ef4444' }} />,
  cooldown_started:<Pause size={13} style={{ color: '#eab308' }} />,
  cooldown_ended:  <RefreshCw size={13} style={{ color: '#22c55e' }} />,
  port_conflict:   <AlertTriangle size={13} style={{ color: '#eab308' }} />,
  circuit_broken:  <AlertTriangle size={13} style={{ color: '#ef4444' }} />,
};

const EVENT_LABEL: Record<WatchdogEventType, string> = {
  restart_attempt:  'Restart attempt',
  restart_success:  'Restart success',
  restart_failed:   'Restart failed',
  cooldown_started: 'Cooldown started',
  cooldown_ended:   'Cooldown ended',
  port_conflict:    'Port conflict',
  circuit_broken:   'Circuit broken',
};

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Services table columns ───────────────────────────────────────────────────

function buildServiceCols(
  onReset: (projectId: string) => void,
  resetting: Set<string>
): ColumnDef<WatchdogState>[] {
  return [
    {
      key: 'projectId',
      header: 'Service',
      sortable: true,
      getValue: r => r.projectId,
      render: r => (
        <span className="wd-service-name">
          {r.circuitBroken ? <AlertTriangle size={12} style={{ color: '#ef4444', marginRight: 5 }} /> : <Shield size={12} style={{ color: '#22c55e', marginRight: 5, opacity: 0.7 }} />}
          {r.projectId.replace(/-service$/, '')}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      width: '120px',
      getValue: r => deriveStatus(r),
      render: r => <StatusBadge status={deriveStatus(r)} />,
    },
    {
      key: 'restartCount',
      header: 'Restarts',
      sortable: true,
      width: '90px',
      align: 'right',
      getValue: r => r.restartCount,
      render: r => (
        <span style={{ color: r.restartCount > 0 ? '#eab308' : 'inherit' }}>
          {r.restartCount}
        </span>
      ),
    },
    {
      key: 'failedCycles',
      header: 'Failed Cycles',
      sortable: true,
      width: '110px',
      align: 'right',
      getValue: r => r.failedCycles,
      render: r => (
        <span style={{ color: r.failedCycles > 0 ? '#ef4444' : 'inherit' }}>
          {r.failedCycles}
        </span>
      ),
    },
    {
      key: 'lastRestartAt',
      header: 'Last Restart',
      sortable: true,
      width: '130px',
      getValue: r => r.lastRestartAt ?? '',
      render: r => r.lastRestartAt
        ? <span title={formatTime(r.lastRestartAt)} style={{ color: 'var(--muted)' }}>{formatRelative(r.lastRestartAt)}</span>
        : <span style={{ color: 'var(--muted)' }}>—</span>,
    },
    {
      key: 'cooldown',
      header: 'Cooldown / Circuit',
      width: '180px',
      getValue: r => r.cooldownUntil ?? (r.circuitBroken ? 'broken' : ''),
      render: r => {
        const inCooldown = r.cooldownUntil && new Date(r.cooldownUntil).getTime() > Date.now();
        const needsReset = r.circuitBroken || inCooldown;
        if (!needsReset) return <span style={{ color: 'var(--muted)' }}>—</span>;
        const isResetting = resetting.has(r.projectId);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {r.circuitBroken ? (
              <span style={{ color: '#ef4444', fontSize: '11px', display: 'flex', alignItems: 'center', gap: 3 }}>
                <Zap size={11} /> Circuit broken
              </span>
            ) : (
              <span style={{ color: '#eab308', fontSize: '11px', display: 'flex', alignItems: 'center', gap: 3 }}>
                <Clock size={11} /> until {formatTime(r.cooldownUntil!)}
              </span>
            )}
            <button
              className="wd-reset-btn"
              onClick={(e) => { e.stopPropagation(); onReset(r.projectId); }}
              disabled={isResetting}
              title="Reset cooldown / circuit breaker"
            >
              {isResetting ? <RefreshCw size={10} className="wd-spin" /> : <RefreshCw size={10} />}
              {isResetting ? '' : 'Reset'}
            </button>
          </div>
        );
      },
    },
  ];
}

// ─── Events table columns ─────────────────────────────────────────────────────

const EVENT_COLS: ColumnDef<WatchdogEvent>[] = [
  {
    key: 'timestamp',
    header: 'Time',
    sortable: true,
    width: '100px',
    getValue: e => e.timestamp,
    render: e => (
      <span title={formatTime(e.timestamp)} style={{ color: 'var(--muted)', fontSize: '11.5px' }}>
        {formatRelative(e.timestamp)}
      </span>
    ),
  },
  {
    key: 'eventType',
    header: 'Event',
    sortable: true,
    width: '160px',
    getValue: e => e.eventType,
    render: e => (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {EVENT_ICON[e.eventType]}
        <span style={{ fontSize: '12px' }}>{EVENT_LABEL[e.eventType]}</span>
      </span>
    ),
  },
  {
    key: 'projectId',
    header: 'Service',
    sortable: true,
    width: '140px',
    getValue: e => e.projectId,
    render: e => <span style={{ color: '#60a5fa' }}>{e.projectId.replace(/-service$/, '')}</span>,
  },
  {
    key: 'message',
    header: 'Message',
    getValue: e => e.message,
    render: e => <span style={{ color: 'var(--muted)', fontSize: '12px' }}>{e.message}</span>,
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export function WatchdogSection() {
  const [states, setStates] = useState<WatchdogState[]>([]);
  const [events, setEvents] = useState<WatchdogEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [view, setView] = useState<'services' | 'events'>('services');
  const [resetting, setResetting] = useState<Set<string>>(new Set());
  const [showAddModal, setShowAddModal] = useState(false);
  const statesRef = useRef(states);
  statesRef.current = states;

  const { data: sseData } = useEventStream<WatchdogSSEData>('watchdog:event', {
    fallbackUrl: undefined,
    fallbackInterval: 0,
  });

  useEffect(() => {
    if (!sseData) return;
    if (sseData.states) setStates(sseData.states);
    if (sseData.event) setEvents(prev => [...prev, sseData.event!].slice(-100));
  }, [sseData]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'watchdog.status' }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.data) {
        setStates(data.data.services || []);
        setEvents(data.data.recentEvents || []);
      }
    } catch {
      // SSE keeps us live
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleReset = useCallback(async (projectId: string) => {
    setResetting(prev => new Set(prev).add(projectId));
    try {
      await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'watchdog.reset', projectId }),
      });
      // Optimistically clear local state
      setStates(prev => prev.map(s =>
        s.projectId === projectId
          ? { ...s, circuitBroken: false, cooldownUntil: undefined, restartCount: 0, failedCycles: 0 }
          : s
      ));
      // Then re-fetch to sync
      setTimeout(fetchStatus, 500);
    } catch {
      // silently fail — SSE will correct state
    } finally {
      setResetting(prev => { const s = new Set(prev); s.delete(projectId); return s; });
    }
  }, [fetchStatus]);

  const enabledCount = states.filter(s => s.enabled).length;
  const erroredCount = states.filter(s => deriveStatus(s) === 'errored').length;
  const warningCount = states.filter(s => deriveStatus(s) === 'warning').length;

  if (isLoading) return <div className="systems-section__loading">Loading watchdog status…</div>;

  return (
    <div className="systems-section">
      {/* Header */}
      <div className="systems-section__header">
        <div className="systems-section__header-left">
          <Shield size={16} style={{ color: '#22c55e', flexShrink: 0 }} />
          <h2 className="systems-section__title">Watchdog</h2>
          <span className="systems-stat-pill systems-stat-pill--success">
            <span className="systems-stat-pill__value">{enabledCount}</span> monitored
          </span>
          {erroredCount > 0 && (
            <span className="systems-stat-pill systems-stat-pill--error">
              <span className="systems-stat-pill__value">{erroredCount}</span> errored
            </span>
          )}
          {warningCount > 0 && (
            <span className="systems-stat-pill systems-stat-pill--warning">
              <span className="systems-stat-pill__value">{warningCount}</span> cooldown
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="systems-section__view-toggle">
            <button className={`systems-section__toggle-btn${view === 'services' ? ' systems-section__toggle-btn--active' : ''}`} onClick={() => setView('services')}>
              Services
            </button>
            <button className={`systems-section__toggle-btn${view === 'events' ? ' systems-section__toggle-btn--active' : ''}`} onClick={() => setView('events')}>
              <Eye size={12} /> Events {events.length > 0 && <span className="systems-section__badge-sm">{events.length}</span>}
            </button>
          </div>
          <button
            className="systems-section__btn systems-section__btn--primary"
            onClick={() => setShowAddModal(true)}
            title="Add service to watchdog"
          >
            <Plus size={13} />
            <span>Add Service</span>
          </button>
        </div>
      </div>

      <p className="systems-section__desc">Periodic port health checks for monitored services. Automatically restarts crashed processes and circuit-breaks persistent crash loops.</p>

      {/* Content */}
      {view === 'services' ? (
        <DataTable<WatchdogState>
          columns={buildServiceCols(handleReset, resetting)}
          data={states}
          rowKey={r => r.projectId}
          pageSize={25}
          initialSort={{ key: 'projectId', direction: 'asc' }}
          emptyMessage="No services are being monitored."
        />
      ) : (
        <DataTable<WatchdogEvent>
          columns={EVENT_COLS}
          data={[...events].reverse()}
          rowKey={e => e.id}
          pageSize={30}
          initialSort={{ key: 'timestamp', direction: 'desc' }}
          emptyMessage="No watchdog events recorded."
        />
      )}

      {showAddModal && (
        <AddServiceModal
          monitored={new Set(states.map(s => s.projectId))}
          onClose={() => setShowAddModal(false)}
          onAdded={() => { setShowAddModal(false); fetchStatus(); }}
        />
      )}
    </div>
  );
}

// ─── Add Service Modal ────────────────────────────────────────────────────────

interface AddServiceModalProps {
  monitored: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}

function AddServiceModal({ monitored, onClose, onAdded }: AddServiceModalProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/projects');
        if (res.ok) {
          const data = await res.json();
          const all: Project[] = data.projects ?? [];
          const eligible = all.filter(p => p.server?.pm2Name && !monitored.has(p.id));
          setProjects(eligible);
          if (eligible.length > 0) setSelected(eligible[0].id);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [monitored]);

  const handleAdd = async () => {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/projects', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selected, watchdog: { enabled: true } }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed to enable watchdog'); return; }
      onAdded();
    } catch {
      setError('Failed to enable watchdog');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="systems-modal-overlay" onClick={onClose}>
      <div className="systems-modal" onClick={e => e.stopPropagation()}>
        <div className="systems-modal__header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Shield size={14} style={{ color: '#22c55e' }} />
            Add Service to Watchdog
          </h3>
          <button className="systems-modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="systems-modal__form">
          {loading ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading services…</p>
          ) : projects.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>All eligible services are already monitored.</p>
          ) : (
            <label className="systems-modal__label">
              Service
              <select
                className="glass-input"
                value={selected}
                onChange={e => setSelected(e.target.value)}
              >
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          )}
          {error && <p className="systems-modal__error">{error}</p>}
          <div className="systems-modal__footer">
            <button type="button" className="glass-button secondary" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="glass-button primary"
              disabled={saving || loading || projects.length === 0}
              onClick={handleAdd}
            >
              {saving ? 'Enabling…' : 'Enable Watchdog'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
