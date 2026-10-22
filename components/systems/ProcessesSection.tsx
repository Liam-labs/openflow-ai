'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Cpu, RefreshCw, RotateCcw, Square, AlertTriangle } from 'lucide-react';
import { DataTable, StatusBadge } from './DataTable';
import type { ColumnDef } from './DataTable';
import { useEventStream } from '@/lib/contexts/EventStreamContext';
import type { PM2Process, PM2Response } from '@/lib/types';
import type { SystemsNavState, ContextPanelEntity } from './systems-types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMem(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function CpuBar({ value }: { value: number }) {
  const pct = Math.min(100, value);
  const color = pct > 80 ? '#ef4444' : pct > 40 ? '#eab308' : '#22c55e';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{
        flex: 1, height: 3, background: 'rgba(255,255,255,0.06)',
        borderRadius: 2, overflow: 'hidden', minWidth: 40,
      }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.4s ease' }} />
      </div>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11, color, width: 36, textAlign: 'right' }}>
        {value.toFixed(1)}%
      </span>
    </div>
  );
}

// ─── Columns ──────────────────────────────────────────────────────────────────

function buildColumns(
  onAction: (proc: PM2Process, action: 'stop' | 'restart') => void
): ColumnDef<PM2Process>[] {
  return [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      getValue: r => r.name,
      render: r => (
        <span style={{ fontWeight: 500, color: 'var(--foreground)' }}>{r.name}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      width: '110px',
      getValue: r => r.status,
      render: r => <StatusBadge status={r.status} />,
    },
    {
      key: 'pid',
      header: 'PID',
      sortable: true,
      width: '70px',
      align: 'right',
      getValue: r => r.pid,
      render: r => (
        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11, color: 'var(--muted)' }}>{r.pid}</span>
      ),
    },
    {
      key: 'uptimeFormatted',
      header: 'Uptime',
      sortable: true,
      width: '90px',
      getValue: r => r.uptime,
      render: r => <span style={{ color: 'var(--muted)', fontSize: 11 }}>{r.uptimeFormatted}</span>,
    },
    {
      key: 'cpu',
      header: 'CPU',
      sortable: true,
      width: '140px',
      getValue: r => r.cpu,
      render: r => <CpuBar value={r.cpu} />,
    },
    {
      key: 'memory',
      header: 'Memory',
      sortable: true,
      width: '90px',
      align: 'right',
      getValue: r => r.memory,
      render: r => (
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)', fontSize: 11 }}>
          {fmtMem(r.memory)}
        </span>
      ),
    },
    {
      key: 'restarts',
      header: 'Restarts',
      sortable: true,
      width: '80px',
      align: 'right',
      getValue: r => r.restarts,
      render: r => (
        <span style={{
          fontVariantNumeric: 'tabular-nums',
          color: r.restarts > 5 ? '#ef4444' : r.restarts > 0 ? '#eab308' : 'var(--muted)',
          fontSize: 11,
          display: 'flex', alignItems: 'center', gap: 3, justifyContent: 'flex-end',
        }}>
          {r.restarts > 5 && <AlertTriangle size={10} />}
          {r.restarts}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '60px',
      align: 'right',
      render: r => {
        const isRunning = r.status === 'online' || r.status === 'launching';
        return (
          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
            <button
              className="svc-action-btn"
              style={{ color: isRunning ? '#f87171' : 'var(--muted)', opacity: isRunning ? 1 : 0.35 }}
              disabled={!isRunning}
              onClick={() => isRunning && onAction(r, 'stop')}
              title="Stop"
              aria-label="Stop"
            >
              <Square size={11} />
            </button>
            <button
              className="svc-action-btn"
              style={{ color: '#60a5fa' }}
              onClick={() => onAction(r, 'restart')}
              title="Restart"
              aria-label="Restart"
            >
              <RotateCcw size={11} />
            </button>
          </div>
        );
      },
    },
  ];
}

// ─── Component ────────────────────────────────────────────────────────────────

interface ProcessesSectionProps {
  onNavigate: (partial: Partial<SystemsNavState>) => void;
  onEntitySelect: (entity: ContextPanelEntity) => void;
  onProcessCountChange?: (count: number) => void;
}

const STATUS_FILTERS = [
  { value: 'all',     label: 'All' },
  { value: 'online',  label: 'Online',  variant: 'success' as const },
  { value: 'stopped', label: 'Stopped' },
  { value: 'errored', label: 'Errored', variant: 'error' as const },
] as const;

type ProcStatusFilter = (typeof STATUS_FILTERS)[number]['value'];

export function ProcessesSection({ onEntitySelect, onProcessCountChange }: ProcessesSectionProps) {
  const [processes, setProcesses] = useState<PM2Process[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<ProcStatusFilter>('all');

  const { data: sseData } = useEventStream<PM2Response>('pm2:status', {
    fallbackUrl: '/api/pm2',
    fallbackInterval: 10000,
  });

  useEffect(() => {
    if (!sseData?.processes) return;
    setProcesses(sseData.processes);
    onProcessCountChange?.(sseData.processes.length);
  }, [sseData, onProcessCountChange]);

  const fetchProcesses = useCallback(async () => {
    try {
      const res = await fetch('/api/pm2');
      const data: PM2Response = await res.json();
      setProcesses(data.processes ?? []);
      onProcessCountChange?.(data.processes?.length ?? 0);
    } catch {
      // SSE covers live updates
    } finally {
      setIsLoading(false);
    }
  }, [onProcessCountChange]);

  useEffect(() => { fetchProcesses(); }, [fetchProcesses]);

  const handleAction = useCallback(async (proc: PM2Process, action: 'stop' | 'restart') => {
    try {
      await fetch('/api/pm2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, target: proc.name, port: proc.port }),
      });
      await fetchProcesses();
    } catch {
      // ignore
    }
  }, [fetchProcesses]);

  const handleRowClick = useCallback((proc: PM2Process) => {
    onEntitySelect({
      id: String(proc.pm_id),
      name: proc.name,
      type: 'process',
      status: proc.status as ContextPanelEntity['status'],
      port: proc.port ?? undefined,
      pid: proc.pid,
      uptime: proc.uptimeFormatted,
      cpu: proc.cpu,
      memory: proc.memory,
    });
  }, [onEntitySelect]);

  const columns = React.useMemo(() => buildColumns(handleAction), [handleAction]);

  const onlineCount  = processes.filter(p => p.status === 'online').length;
  const erroredCount = processes.filter(p => p.status === 'errored').length;
  const stoppedCount = processes.filter(p => p.status === 'stopped').length;
  const totalCpu     = processes.reduce((sum, p) => sum + p.cpu, 0);
  const totalMem     = processes.reduce((sum, p) => sum + p.memory, 0);

  const filtered = React.useMemo(() => {
    if (statusFilter === 'all') return processes;
    return processes.filter(p => p.status === statusFilter);
  }, [processes, statusFilter]);

  if (isLoading) return <div className="systems-section__loading">Loading processes…</div>;

  return (
    <div className="systems-section">
      {/* Header — title + inline stats + refresh */}
      <div className="systems-section__header">
        <div className="systems-section__title-group">
          <Cpu size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <h2 className="systems-section__title">Processes</h2>
          <span className="systems-section__count">{processes.length}</span>
          <span className="svc-stat-inline">
            <span className="svc-stat-inline__dot svc-stat-inline__dot--online" />
            {onlineCount} online
          </span>
          {erroredCount > 0 && (
            <span className="svc-stat-inline svc-stat-inline--error">
              <span className="svc-stat-inline__dot svc-stat-inline__dot--error" />
              {erroredCount} errored
            </span>
          )}
          {totalCpu > 0 && (
            <span className="svc-stat-inline" style={{ color: totalCpu > 80 ? '#f87171' : 'rgba(255,255,255,0.45)' }}>
              · {totalCpu.toFixed(1)}% CPU · {fmtMem(totalMem)}
            </span>
          )}
        </div>
        <button
          className="systems-section__btn"
          onClick={fetchProcesses}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Filter bar — status chips */}
      <p className="systems-section__desc">All active PM2 processes — services, dev servers, and automation. View CPU/memory usage and restart from here.</p>
      <div className="svc-filter-bar">
        <div className="svc-filter-group">
          {STATUS_FILTERS.map(sf => (
            <button
              key={sf.value}
              className={`svc-filter-chip${statusFilter === sf.value ? ` svc-filter-chip--active${'variant' in sf ? ` svc-filter-chip--${sf.variant}` : ''}` : ''}`}
              onClick={() => setStatusFilter(sf.value)}
              aria-pressed={statusFilter === sf.value}
            >
              {sf.label}
              <span className="svc-filter-chip__count">
                {sf.value === 'all' ? processes.length
                  : sf.value === 'online'  ? onlineCount
                  : sf.value === 'stopped' ? stoppedCount
                  : erroredCount}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <DataTable<PM2Process>
        columns={columns}
        data={filtered}
        rowKey={r => String(r.pm_id)}
        onRowClick={handleRowClick}
        pageSize={30}
        initialSort={{ key: 'name', direction: 'asc' }}
        emptyMessage="No processes match the current filter."
      />
    </div>
  );
}
