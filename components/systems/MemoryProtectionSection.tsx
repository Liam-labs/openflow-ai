'use client';

import { useEffect, useState, useCallback } from 'react';
import { Brain, Shield, Cpu, HardDrive, AlertTriangle, RefreshCw, CheckCircle2, XCircle, Activity, Database, RotateCcw } from 'lucide-react';
import { DataTable, StatusBadge, MetricCard } from './DataTable';
import type { ColumnDef } from './DataTable';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MemoryEvent {
  id: string;
  timestamp: string;
  type: 'earlyoom_kill' | 'ollama_idle_unload';
  severity: 'critical' | 'warning' | 'info';
  killedPid?: string;
  killedProcess?: string;
  memAvailPercent?: string;
  swapFreePercent?: string;
  model?: string;
  message: string;
}

interface MemoryInfo {
  totalMB: number;
  availableMB: number;
  freeMB: number;
  swapTotalMB: number;
  swapFreeMB: number;
}

interface ProcInfo {
  pid: number;
  comm: string;
  cmdline: string;
  rssKb: number;
  oomScoreAdj: number | null;
  oomScore: number | null;
  uid: string | null;
  pm2Name: string | null;
}

interface LiveState {
  generatedAt: string;
  memory: { totalMB: number; availableMB: number; usedMB: number; swapTotalMB: number; swapFreeMB: number };
  topProcesses: ProcInfo[];
  embeddingServer: {
    pid: number | null;
    rssKb: number | null;
    rssMb: number | null;
    ceilingMb: number;
    pctOfCeiling: number | null;
    uptimeSeconds: number | null;
    healthy: boolean;
  };
  defenseStatus: {
    embeddingCeiling: { active: boolean; detail: string };
    earlyoom: { active: boolean; args: string | null };
    oomScoreManager: { active: boolean; lastTickAgo: number | null; agentsTagged: number | null };
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function formatKB(kb: number): string {
  return formatMB(kb / 1024);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// Bias colour for oom_score_adj. Negative = protected (green), positive = kill candidate.
function adjColor(adj: number | null): string {
  if (adj === null) return 'var(--muted)';
  if (adj <= -200) return '#22c55e';   // green: protected
  if (adj <= 0) return '#94a3b8';      // grey: default
  if (adj <= 300) return '#eab308';    // yellow: idle
  return '#ef4444';                    // red: stale, first to die
}

function shortName(p: ProcInfo): string {
  // Try to extract --name X from cmdline (collab agents).
  const m = p.cmdline.match(/--name\s+(\S+)/);
  if (m) return `${p.comm} (${m[1]})`;
  // For next-server show port if present.
  if (p.comm.startsWith('next-server')) return p.comm;
  return p.comm || '(unnamed)';
}

// ─── Columns ──────────────────────────────────────────────────────────────────

const COLS: ColumnDef<MemoryEvent>[] = [
  {
    key: 'timestamp',
    header: 'Time',
    sortable: true,
    width: '110px',
    getValue: e => e.timestamp,
    render: e => (
      <span title={new Date(e.timestamp).toLocaleString()} style={{ color: 'var(--muted)', fontSize: '11.5px' }}>
        {formatRelative(e.timestamp)}
      </span>
    ),
  },
  {
    key: 'severity',
    header: 'Severity',
    sortable: true,
    width: '100px',
    getValue: e => e.severity,
    render: e => <StatusBadge status={e.severity === 'critical' ? 'errored' : e.severity === 'warning' ? 'warning' : 'configured'} label={e.severity} />,
  },
  {
    key: 'type',
    header: 'Type',
    sortable: true,
    width: '160px',
    getValue: e => e.type,
    render: e => (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px' }}>
        {e.type === 'earlyoom_kill' ? <Shield size={12} style={{ color: '#ef4444' }} /> : <Brain size={12} style={{ color: '#a855f7' }} />}
        {e.type === 'earlyoom_kill' ? 'OOM Kill' : 'Ollama Unload'}
      </span>
    ),
  },
  {
    key: 'killedProcess',
    header: 'Process',
    sortable: true,
    width: '160px',
    getValue: e => e.killedProcess ?? e.model ?? '',
    render: e => {
      const val = e.killedProcess || e.model;
      return val
        ? <span style={{ color: '#60a5fa', fontFamily: 'monospace', fontSize: '11.5px' }}>{val}</span>
        : <span style={{ color: 'var(--muted)' }}>—</span>;
    },
  },
  {
    key: 'memAvailPercent',
    header: 'Mem %',
    sortable: true,
    width: '80px',
    align: 'right',
    getValue: e => e.memAvailPercent ?? '',
    render: e => e.memAvailPercent
      ? <span style={{ color: parseFloat(e.memAvailPercent) < 5 ? '#ef4444' : '#eab308', fontVariantNumeric: 'tabular-nums' }}>{e.memAvailPercent}%</span>
      : <span style={{ color: 'var(--muted)' }}>—</span>,
  },
  {
    key: 'message',
    header: 'Message',
    getValue: e => e.message,
    render: e => <span style={{ color: 'var(--muted)', fontSize: '12px' }}>{e.message}</span>,
  },
];

// ─── Top processes table columns ──────────────────────────────────────────────

// Critical infra we never offer a one-click restart for, even if PM2-managed.
// Restarting these is high-risk; force the user to use the proper Services panel.
const RESTART_DENYLIST = new Set(['devflow', 'next-server', 'qdrant', 'postgrest', 'ollama']);

function buildTopCols(onRestart: (p: ProcInfo) => void): ColumnDef<ProcInfo>[] {
  const cols: ColumnDef<ProcInfo>[] = [
  {
    key: 'name',
    header: 'Process',
    sortable: true,
    width: '220px',
    getValue: p => p.comm,
    render: p => (
      <span style={{ fontFamily: 'monospace', fontSize: '11.5px', color: '#e2e8f0' }}>
        {shortName(p)}
      </span>
    ),
  },
  {
    key: 'pid',
    header: 'PID',
    sortable: true,
    width: '80px',
    align: 'right',
    getValue: p => p.pid,
    render: p => <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '11.5px', color: 'var(--muted)' }}>{p.pid}</span>,
  },
  {
    key: 'rss',
    header: 'RSS',
    sortable: true,
    width: '90px',
    align: 'right',
    getValue: p => p.rssKb,
    render: p => <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: '#60a5fa' }}>{formatKB(p.rssKb)}</span>,
  },
  {
    key: 'adj',
    header: 'oom_score_adj',
    sortable: true,
    width: '120px',
    align: 'right',
    getValue: p => p.oomScoreAdj ?? 0,
    render: p => (
      <span
        style={{ fontVariantNumeric: 'tabular-nums', fontSize: '11.5px', color: adjColor(p.oomScoreAdj), fontWeight: 600 }}
        title="oom_score_adj — lower = protected, higher = first to die under memory pressure"
      >
        {p.oomScoreAdj === null ? '—' : (p.oomScoreAdj >= 0 ? `+${p.oomScoreAdj}` : `${p.oomScoreAdj}`)}
      </span>
    ),
  },
  {
    key: 'oomScore',
    header: 'oom_score',
    sortable: true,
    width: '90px',
    align: 'right',
    getValue: p => p.oomScore ?? 0,
    render: p => (
      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '11.5px', color: 'var(--muted)' }} title="kernel-computed kill priority (higher = more likely victim)">
        {p.oomScore ?? '—'}
      </span>
    ),
  },
  {
    key: 'action',
    header: '',
    width: '110px',
    sortable: false,
    align: 'right',
    getValue: () => '',
    render: p => {
      if (!p.pm2Name) return <span style={{ color: 'var(--muted)', fontSize: '11px' }}>—</span>;
      if (RESTART_DENYLIST.has(p.pm2Name)) {
        return (
          <span style={{ color: 'var(--muted)', fontSize: '11px' }} title="Critical service — restart from Services panel">
            critical
          </span>
        );
      }
      return (
        <button
          onClick={() => onRestart(p)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'rgba(96, 165, 250, 0.08)',
            border: '1px solid rgba(96, 165, 250, 0.25)',
            color: '#60a5fa',
            fontSize: '11px',
            padding: '3px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
          title={`Restart ${p.pm2Name} via PM2`}
        >
          <RotateCcw size={11} /> restart
        </button>
      );
    },
  },
];
  return cols;
}

// ─── Defense status indicator (3 lights) ──────────────────────────────────────

function DefenseLight({ label, active, detail, icon }: { label: string; active: boolean; detail: string; icon: React.ReactNode }) {
  const color = active ? '#22c55e' : '#ef4444';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        background: active ? 'rgba(34, 197, 94, 0.06)' : 'rgba(239, 68, 68, 0.06)',
        border: `1px solid ${active ? 'rgba(34, 197, 94, 0.25)' : 'rgba(239, 68, 68, 0.25)'}`,
        borderRadius: 8,
        flex: 1,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color }}>
        {active ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        {icon}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0' }}>{label}</div>
        <div style={{ fontSize: '11px', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={detail}>
          {detail}
        </div>
      </div>
    </div>
  );
}

function EmbeddingServerCard({ s, onRestart }: { s: LiveState['embeddingServer']; onRestart: () => void }) {
  const pct = s.pctOfCeiling ?? 0;
  const barColor = pct < 50 ? '#22c55e' : pct < 80 ? '#eab308' : '#ef4444';
  return (
    <div
      style={{
        padding: '14px 16px',
        background: 'rgba(168, 85, 247, 0.04)',
        border: '1px solid rgba(168, 85, 247, 0.18)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Database size={14} style={{ color: '#a855f7' }} />
          <span style={{ fontSize: '12.5px', fontWeight: 600, color: '#e2e8f0' }}>Embedding Server</span>
          <span style={{ fontSize: '11px', color: 'var(--muted)' }}>(rag-qdrant-memory)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '11px', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
            uptime {formatDuration(s.uptimeSeconds)}
            {s.pid !== null && <> · pid {s.pid}</>}
          </span>
          <button
            onClick={onRestart}
            disabled={s.pid === null}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: 'rgba(168, 85, 247, 0.10)',
              border: '1px solid rgba(168, 85, 247, 0.30)',
              color: '#c084fc',
              fontSize: '11px',
              padding: '3px 8px',
              borderRadius: 4,
              cursor: s.pid === null ? 'not-allowed' : 'pointer',
              opacity: s.pid === null ? 0.5 : 1,
              fontFamily: 'inherit',
            }}
            title={s.pid === null ? 'Wrapper not running' : 'Restart the rag-qdrant-memory wrapper (will reload models, ~10s downtime)'}
          >
            <RotateCcw size={11} /> restart
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: '13px', fontVariantNumeric: 'tabular-nums', color: '#e2e8f0', minWidth: 110 }}>
          {s.rssMb !== null ? `${s.rssMb} MB` : '—'} / {s.ceilingMb} MB
        </span>
        <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: barColor, transition: 'width 0.4s ease' }} />
        </div>
        <span style={{ fontSize: '11.5px', color: barColor, fontVariantNumeric: 'tabular-nums', minWidth: 38, textAlign: 'right' }}>
          {pct}%
        </span>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
        Wrapper polls every 30s; force-restart triggers above 4 GB ceiling. Prevents the 23 GB leak that nuked the fleet on 26 Apr.
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MemoryProtectionSection() {
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [memoryInfo, setMemoryInfo] = useState<MemoryInfo | null>(null);
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/memory/events');
      const data = await res.json();
      setEvents(data.events || []);
      setMemoryInfo(data.memoryInfo || null);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch('/api/memory/live-state');
      if (res.ok) {
        const data = (await res.json()) as LiveState;
        setLiveState(data);
      }
    } catch {
      // silently fail — endpoint optional, page still renders
    }
  }, []);

  useEffect(() => {
    fetchEvents();
    fetchLive();
    const id = setInterval(() => {
      fetchEvents();
      fetchLive();
    }, 30_000);
    return () => clearInterval(id);
  }, [fetchEvents, fetchLive]);

  const restartProcess = useCallback(async (p: ProcInfo) => {
    if (!p.pm2Name) return;
    if (RESTART_DENYLIST.has(p.pm2Name)) {
      // eslint-disable-next-line no-alert
      alert(`${p.pm2Name} is in the critical service list — restart it from the Services panel.`);
      return;
    }
    // eslint-disable-next-line no-alert
    const ok = confirm(
      `Restart "${p.pm2Name}" (PID ${p.pid}, RSS ${formatKB(p.rssKb)}) via PM2?\n\nThis will briefly take the process offline.`
    );
    if (!ok) return;
    try {
      const res = await fetch('/api/pm2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart', target: p.pm2Name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        // eslint-disable-next-line no-alert
        alert(`Restart failed: ${body?.error ?? res.statusText}`);
      } else {
        // Refresh after a beat so the new PID + RSS show up.
        setTimeout(fetchLive, 1500);
      }
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [fetchLive]);

  const topCols = buildTopCols(restartProcess);

  const restartEmbedding = useCallback(async () => {
    // eslint-disable-next-line no-alert
    const ok = confirm('Restart the embedding server (rag-qdrant-memory)?\n\nWill take ~10s while models reload. RAG queries will fail during that window.');
    if (!ok) return;
    try {
      const res = await fetch('/api/pm2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart', target: 'rag-qdrant-memory' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        // eslint-disable-next-line no-alert
        alert(`Restart failed: ${body?.error ?? res.statusText}`);
      } else {
        setTimeout(fetchLive, 2500);
      }
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [fetchLive]);

  const criticalCount = events.filter(e => e.severity === 'critical').length;
  const oomKills = events.filter(e => e.type === 'earlyoom_kill').length;

  const memUsedPct = memoryInfo
    ? Math.round(((memoryInfo.totalMB - memoryInfo.availableMB) / memoryInfo.totalMB) * 100)
    : null;

  const swapUsedPct = memoryInfo && memoryInfo.swapTotalMB > 0
    ? Math.round(((memoryInfo.swapTotalMB - memoryInfo.swapFreeMB) / memoryInfo.swapTotalMB) * 100)
    : null;

  if (isLoading) return <div className="systems-section__loading">Loading memory data…</div>;

  return (
    <div className="systems-section">
      {/* Header */}
      <div className="systems-section__header">
        <div className="systems-section__header-left">
          <Brain size={16} style={{ color: '#a855f7', flexShrink: 0 }} />
          <h2 className="systems-section__title">Memory Protection</h2>
          <span className="systems-stat-pill systems-stat-pill--muted">
            <span className="systems-stat-pill__value">{events.length}</span> events
          </span>
          {criticalCount > 0 && (
            <span className="systems-stat-pill systems-stat-pill--error">
              <span className="systems-stat-pill__value">{criticalCount}</span> critical
            </span>
          )}
        </div>
        <button className="systems-filter-bar__action" onClick={fetchEvents} title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Metrics strip */}
      <p className="systems-section__desc">OOM kill events from earlyoom and Ollama idle unloads. Shows memory pressure history and kill triggers.</p>
      {memoryInfo && (
        <div className="systems-section__metrics">
          <MetricCard
            label="RAM Used"
            value={`${memUsedPct}%`}
            sub={`${formatMB(memoryInfo.totalMB - memoryInfo.availableMB)} / ${formatMB(memoryInfo.totalMB)}`}
            variant={memUsedPct! > 90 ? 'error' : memUsedPct! > 75 ? 'warning' : 'success'}
            icon={<Cpu size={14} />}
          />
          <MetricCard
            label="RAM Available"
            value={formatMB(memoryInfo.availableMB)}
            sub="available now"
            variant="info"
            icon={<HardDrive size={14} />}
          />
          {memoryInfo.swapTotalMB > 0 && (
            <MetricCard
              label="Swap Used"
              value={`${swapUsedPct}%`}
              sub={`${formatMB(memoryInfo.swapTotalMB - memoryInfo.swapFreeMB)} / ${formatMB(memoryInfo.swapTotalMB)}`}
              variant={swapUsedPct! > 80 ? 'warning' : 'default'}
              icon={<HardDrive size={14} />}
            />
          )}
          <MetricCard
            label="OOM Kills"
            value={oomKills}
            sub="earlyoom kills"
            variant={oomKills > 0 ? 'error' : 'success'}
            icon={<AlertTriangle size={14} />}
          />
        </div>
      )}

      {/* Defense Status — three lights showing each defense layer is active */}
      {liveState && (
        <div style={{ marginTop: 16, marginBottom: 8 }}>
          <h3 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Defense Status
          </h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <DefenseLight
              label="Embedding Ceiling"
              active={liveState.defenseStatus.embeddingCeiling.active}
              detail={liveState.defenseStatus.embeddingCeiling.detail}
              icon={<Database size={13} />}
            />
            <DefenseLight
              label="earlyoom"
              active={liveState.defenseStatus.earlyoom.active}
              detail={liveState.defenseStatus.earlyoom.args
                ? liveState.defenseStatus.earlyoom.args.replace(/^\S*earlyoom\s+/, '')
                : 'not running'}
              icon={<Shield size={13} />}
            />
            <DefenseLight
              label="oom-score-manager"
              active={liveState.defenseStatus.oomScoreManager.active}
              detail={
                liveState.defenseStatus.oomScoreManager.active
                  ? `${liveState.defenseStatus.oomScoreManager.agentsTagged ?? '?'} agents tagged · last tick ${formatDuration(liveState.defenseStatus.oomScoreManager.lastTickAgo)} ago`
                  : 'no recent ticks'
              }
              icon={<Activity size={13} />}
            />
          </div>
        </div>
      )}

      {/* Embedding Server card */}
      {liveState && (
        <div style={{ marginTop: 16, marginBottom: 8 }}>
          <EmbeddingServerCard s={liveState.embeddingServer} onRestart={restartEmbedding} />
        </div>
      )}

      {/* Top RSS consumers — proves oom-score-manager is biasing victims */}
      {liveState && liveState.topProcesses.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h3 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Top Memory Consumers (Live)
          </h3>
          <p style={{ fontSize: '11.5px', color: 'var(--muted)', marginBottom: 8 }}>
            Sorted by RSS. <span style={{ color: '#22c55e' }}>Green</span> oom_score_adj = protected (active agent or pinned infra). {' '}
            <span style={{ color: '#eab308' }}>Yellow</span> = idle agent. <span style={{ color: '#ef4444' }}>Red</span> = stale, first picked under pressure.
          </p>
          <DataTable<ProcInfo>
            columns={topCols}
            data={liveState.topProcesses}
            rowKey={p => String(p.pid)}
            pageSize={15}
            initialSort={{ key: 'rss', direction: 'desc' }}
            emptyMessage="No process data."
          />
        </div>
      )}

      {/* Events table */}
      <div style={{ marginTop: 18 }}>
        <h3 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
          Recent OOM Events
        </h3>
        <DataTable<MemoryEvent>
          columns={COLS}
          data={events}
          rowKey={e => e.id}
          pageSize={25}
          initialSort={{ key: 'timestamp', direction: 'desc' }}
          emptyMessage="No memory protection events recorded."
        />
      </div>
    </div>
  );
}
