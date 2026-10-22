'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import {
  Activity, RefreshCw, Search, X, Skull, Radio, AlertTriangle,
} from 'lucide-react';

// ─── Lazy-load ECharts ───────────────────────────────────────────────────────

const ReactECharts = dynamic(() => import('echarts-for-react'), {
  ssr: false,
  loading: () => <div className="ph-chart__skeleton" />,
});

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProcessSummary {
  totalProcesses: number;
  totalThreads: number;
  zombies: number;
  orphans: number;
  forkErrors1hr: number;
  processLimit: number;
  threadLimit: number;
  status: 'green' | 'amber' | 'red';
}

interface ProcessEntry {
  pid: number;
  name: string;
  parentPid: number;
  parentName: string;
  threads: number;
  memoryMB: number;
  cpuPercent: number;
  state: 'running' | 'sleeping' | 'zombie' | 'stopped';
  owner: string;
  pm2Name: string | null;
  uptime: string;
  children: number;
}

interface HistoryEntry {
  timestamp: string;
  threads: number;
  zombies: number;
}

interface ProcessHealthData {
  summary: ProcessSummary;
  topConsumers: ProcessEntry[];
  history: HistoryEntry[];
}

type StateFilter = 'all' | 'running' | 'sleeping' | 'zombie' | 'stopped';
type OwnerFilter = 'all' | 'pm2' | 'docker' | 'unmanaged';
type ThreadFilter = 'all' | '>10' | '>50' | '>100';

// ─── Kill state per PID ───────────────────────────────────────────────────────

type KillState = 'idle' | 'confirm' | 'killing' | 'done';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMB(mb: number) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${mb}MB`;
}

function getRowClass(p: ProcessEntry) {
  if (p.state === 'zombie' || p.children > 1000) return 'ph-row ph-row--red';
  if (p.threads > 100 || p.memoryMB > 500) return 'ph-row ph-row--amber';
  return 'ph-row';
}

function filterByOwner(p: ProcessEntry, f: OwnerFilter) {
  if (f === 'all') return true;
  if (f === 'pm2') return p.pm2Name !== null;
  if (f === 'docker') return p.owner === 'docker';
  return p.pm2Name === null && p.owner !== 'docker';
}

function filterByThreads(p: ProcessEntry, f: ThreadFilter) {
  if (f === 'all') return true;
  if (f === '>10') return p.threads > 10;
  if (f === '>50') return p.threads > 50;
  return p.threads > 100;
}

// ─── Thread History Chart ─────────────────────────────────────────────────────

function ThreadHistoryChart({ history }: { history: HistoryEntry[] }) {
  const timestamps = history.map(h => {
    const d = new Date(h.timestamp);
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  });
  const threadData = history.map(h => h.threads);
  const maxThread = Math.max(...threadData, 35000);

  const option = {
    animation: false,
    backgroundColor: 'transparent',
    grid: { top: 24, right: 24, bottom: 32, left: 60 },
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: 'rgba(8,14,28,0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
      formatter: (params: { dataIndex: number }[]) => {
        if (!params[0]) return '';
        const h = history[params[0].dataIndex];
        if (!h) return '';
        const t = new Date(h.timestamp).toLocaleTimeString();
        return `${t}<br/>Threads: <b>${h.threads.toLocaleString()}</b><br/>Zombies: ${h.zombies}`;
      },
    },
    xAxis: {
      type: 'category' as const,
      data: timestamps,
      boundaryGap: false,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      axisLabel: { color: 'rgba(255,255,255,0.3)', fontSize: 10, interval: Math.floor(history.length / 6) },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value' as const,
      min: 0,
      max: Math.max(maxThread * 1.1, 35000),
      axisLine: { show: false },
      axisLabel: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 10,
        formatter: (v: number) => v >= 1000 ? `${(v/1000).toFixed(0)}K` : String(v),
      },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } },
    },
    series: [
      {
        type: 'line' as const,
        data: threadData,
        smooth: 0.3,
        symbol: 'none',
        lineStyle: { color: '#3b82f6', width: 2 },
        areaStyle: {
          color: {
            type: 'linear' as const,
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(59,130,246,0.28)' },
              { offset: 1, color: 'rgba(59,130,246,0.02)' },
            ],
          },
        },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { fontSize: 10 },
          data: [
            {
              yAxis: 10000,
              lineStyle: { color: '#eab308', width: 1, type: 'dashed' as const },
              label: { color: '#eab308', formatter: '10K' },
            },
            {
              yAxis: 30000,
              lineStyle: { color: '#ef4444', width: 1, type: 'dashed' as const },
              label: { color: '#ef4444', formatter: '30K' },
            },
          ],
        },
      },
    ],
  };

  return (
    <ReactECharts
      option={option}
      style={{ height: '200px', width: '100%' }}
      opts={{ renderer: 'canvas' }}
    />
  );
}

// ─── Kill Button ──────────────────────────────────────────────────────────────

function KillButton({ pid, onKillDone }: { pid: number; onKillDone: () => void }) {
  const [state, setState] = useState<KillState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendKill = useCallback(async (signal: 'SIGTERM' | 'SIGKILL') => {
    await fetch('/api/process-health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'kill', pid, signal }),
    });
  }, [pid]);

  const handleConfirm = useCallback(async () => {
    setState('killing');
    await sendKill('SIGTERM');
    // After 5s, if still in killing state, send SIGKILL
    timerRef.current = setTimeout(async () => {
      await sendKill('SIGKILL');
      setState('done');
      onKillDone();
    }, 5000);
    // Optimistically mark done after 1s for UX (real check on next poll)
    setTimeout(() => {
      setState('done');
      onKillDone();
    }, 1200);
  }, [sendKill, onKillDone]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  if (state === 'done') return <span className="ph-kill-done">Killed</span>;

  if (state === 'confirm') {
    return (
      <span className="ph-kill-confirm">
        <button className="ph-kill-confirm__yes" onClick={handleConfirm}>Kill</button>
        <button className="ph-kill-confirm__no" onClick={() => setState('idle')}>Cancel</button>
      </span>
    );
  }

  return (
    <button
      className="ph-kill-btn"
      onClick={(e) => { e.stopPropagation(); setState('confirm'); }}
      disabled={state === 'killing'}
      title={`Send SIGTERM to PID ${pid}`}
      aria-label={`Kill process ${pid}`}
    >
      <Skull size={11} />
    </button>
  );
}

// ─── Process Row ──────────────────────────────────────────────────────────────

function ProcessRow({ proc, onKillDone }: { proc: ProcessEntry; onKillDone: () => void }) {
  const rowClass = getRowClass(proc);

  return (
    <tr className={rowClass}>
      <td className="ph-td ph-td--name" title={proc.name}>{proc.name}</td>
      <td className="ph-td ph-td--pid">{proc.pid}</td>
      <td className="ph-td ph-td--parent" title={`${proc.parentName} (${proc.parentPid})`}>
        {proc.parentName}
      </td>
      <td className="ph-td ph-td--threads">{proc.threads.toLocaleString()}</td>
      <td className="ph-td ph-td--mem">{formatMB(proc.memoryMB)}</td>
      <td className="ph-td ph-td--cpu">{proc.cpuPercent.toFixed(1)}%</td>
      <td className="ph-td">
        <span className={`ph-state-badge ph-state-badge--${proc.state}`}>
          {proc.state}
        </span>
      </td>
      <td className="ph-td ph-td--owner">{proc.pm2Name ?? proc.owner}</td>
      <td className="ph-td ph-td--uptime">{proc.uptime}</td>
      <td className="ph-td ph-td--children">
        {proc.children > 50 ? (
          <span className="ph-children-badge">{proc.children}</span>
        ) : proc.children}
      </td>
      <td className="ph-td ph-td--actions">
        <KillButton pid={proc.pid} onKillDone={onKillDone} />
      </td>
    </tr>
  );
}

// ─── Summary Bar ──────────────────────────────────────────────────────────────

function SummaryBar({ summary }: { summary: ProcessSummary }) {
  const pills = [
    { label: 'Processes', value: summary.totalProcesses.toLocaleString(), alert: false },
    { label: 'Threads', value: summary.totalThreads.toLocaleString(), alert: summary.totalThreads >= 10000 },
    { label: 'Zombies', value: String(summary.zombies), alert: summary.zombies > 0, alertColor: '#ef4444' as const },
    { label: 'Orphans', value: String(summary.orphans), alert: false },
    { label: 'Fork Errors/hr', value: String(summary.forkErrors1hr), alert: summary.forkErrors1hr > 0, alertColor: '#eab308' as const },
    {
      label: 'Process Limit',
      value: `${summary.totalProcesses.toLocaleString()}/${summary.processLimit.toLocaleString()}`,
      alert: summary.totalProcesses / summary.processLimit > 0.8,
      alertColor: '#eab308' as const,
    },
  ];

  return (
    <div className="ph-summary-bar">
      {pills.map(p => (
        <div key={p.label} className="ph-summary-pill">
          <span
            className="ph-summary-pill__value"
            style={p.alert && p.alertColor ? { color: p.alertColor } : undefined}
          >
            {p.value}
          </span>
          <span className="ph-summary-pill__label">{p.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ProcessHealthPanel() {
  const [data, setData] = useState<ProcessHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isLive, setIsLive] = useState(false);

  // Filters
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all');
  const [threadFilter, setThreadFilter] = useState<ThreadFilter>('all');
  const [search, setSearch] = useState('');

  const fetchData = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/process-health');
      if (!res.ok) return;
      const json = await res.json();
      setData(json as ProcessHealthData);
      setIsLive(true);
    } catch {
      setIsLive(false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(() => fetchData(), 10_000);
    return () => clearInterval(id);
  }, [fetchData]);

  // ── Filtered consumers ──────────────────────────────────────────────────────

  const filtered = (data?.topConsumers ?? []).filter(p => {
    if (stateFilter !== 'all' && p.state !== stateFilter) return false;
    if (!filterByOwner(p, ownerFilter)) return false;
    if (!filterByThreads(p, threadFilter)) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) &&
        !String(p.pid).includes(search)) return false;
    return true;
  });

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="ph-page">
      {/* Header */}
      <div className="ph-header">
        <div className="ph-header__left">
          <Activity size={15} className="ph-header__icon" />
          <h2 className="ph-header__title">Process Health</h2>
          {isLive && (
            <span className="ph-live-badge" title="Auto-refreshing every 10s">
              <Radio size={9} className="ph-live-badge__dot" />
              LIVE
            </span>
          )}
        </div>
        <button
          className="ph-refresh-btn"
          onClick={() => fetchData(true)}
          disabled={refreshing}
          aria-label="Refresh process data"
          title="Refresh"
        >
          <RefreshCw size={13} className={refreshing ? 'ph-spinning' : ''} />
        </button>
      </div>

      {/* Summary Bar */}
      {data && <SummaryBar summary={data.summary} />}

      {/* Thread History Chart */}
      {data && data.history.length > 1 && (
        <div className="ph-chart-wrap">
          <div className="ph-chart-title">Thread Count — 24h</div>
          <ThreadHistoryChart history={data.history} />
        </div>
      )}

      {/* Filters */}
      <div className="ph-filters">
        <div className="ph-filter-search">
          <Search size={12} className="ph-filter-search__icon" />
          <input
            className="ph-filter-search__input"
            placeholder="Search process or PID…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Filter by process name or PID"
          />
          {search && (
            <button
              className="ph-filter-search__clear"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              <X size={11} />
            </button>
          )}
        </div>

        <select
          className="ph-filter-select"
          value={stateFilter}
          onChange={e => setStateFilter(e.target.value as StateFilter)}
          aria-label="Filter by process state"
        >
          <option value="all">All States</option>
          <option value="running">Running</option>
          <option value="sleeping">Sleeping</option>
          <option value="zombie">Zombie</option>
          <option value="stopped">Stopped</option>
        </select>

        <select
          className="ph-filter-select"
          value={ownerFilter}
          onChange={e => setOwnerFilter(e.target.value as OwnerFilter)}
          aria-label="Filter by owner"
        >
          <option value="all">All Owners</option>
          <option value="pm2">PM2 Managed</option>
          <option value="docker">Docker</option>
          <option value="unmanaged">Unmanaged</option>
        </select>

        <select
          className="ph-filter-select"
          value={threadFilter}
          onChange={e => setThreadFilter(e.target.value as ThreadFilter)}
          aria-label="Filter by thread count"
        >
          <option value="all">All Threads</option>
          <option value=">10">&gt;10 threads</option>
          <option value=">50">&gt;50 threads</option>
          <option value=">100">&gt;100 threads</option>
        </select>
      </div>

      {/* Top Consumers Table */}
      <div className="ph-table-wrap">
        {loading ? (
          <div className="ph-table-loading">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="ph-table-skel-row" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="ph-table-empty">
            <AlertTriangle size={18} className="ph-table-empty__icon" />
            <span>No processes match filters</span>
          </div>
        ) : (
          <table className="ph-table" aria-label="Top process consumers by thread count">
            <thead>
              <tr className="ph-thead-row">
                <th className="ph-th">Process</th>
                <th className="ph-th">PID</th>
                <th className="ph-th">Parent</th>
                <th className="ph-th ph-th--num">Threads</th>
                <th className="ph-th ph-th--num">Memory</th>
                <th className="ph-th ph-th--num">CPU</th>
                <th className="ph-th">State</th>
                <th className="ph-th">Owner</th>
                <th className="ph-th">Uptime</th>
                <th className="ph-th ph-th--num">Children</th>
                <th className="ph-th ph-th--actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(proc => (
                <ProcessRow
                  key={proc.pid}
                  proc={proc}
                  onKillDone={() => fetchData()}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer: row count */}
      {!loading && data && (
        <div className="ph-footer">
          <span className="ph-footer__stat">
            Showing {filtered.length} of {data.topConsumers.length} processes
          </span>
          {data.summary.status !== 'green' && (
            <span className={`ph-footer__status ph-footer__status--${data.summary.status}`}>
              {data.summary.status === 'red' ? '⚠ Critical thresholds exceeded' : '⚡ Elevated activity'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
