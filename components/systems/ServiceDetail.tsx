'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ArrowLeft, Server, RefreshCw, ExternalLink, Search, X, Download, ArrowDown, CheckCircle2, XCircle, AlertCircle, Clock, Play, Pause, ChevronDown, Wifi } from 'lucide-react';
import { StatusBadge, MetricCard } from './DataTable';
import type { ServiceTab } from './systems-types';
import type { Project, PM2Process, WatchdogState, WatchdogStatusResponse, WatchdogEvent, WatchdogEventType, PM2Response, ProjectHealthStatus, HealthCheck, CronJob as CronJobType, CronExecution } from '@/lib/types';
import { useEventStream } from '@/lib/contexts/EventStreamContext';
import { PRODUCT_NAME } from '@/lib/brand';

interface ServiceDetailProps {
  serviceId: string;
  tab: ServiceTab;
  onTabChange: (tab: ServiceTab) => void;
  onBack: () => void;
}

interface LogLine {
  timestamp: string;
  message: string;
  type: 'out' | 'err';
}

interface LogResponse {
  name: string;
  lines: LogLine[];
  count: number;
  logPaths: Record<string, string>;
}

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  jobType: string;
  command?: string;
  status: string;
  lastRun?: string;
  nextRun?: string;
  enabled: boolean;
}

interface ServiceDetailResponse {
  project: Project;
  pm2Process: PM2Process | null;
  health: unknown;
  cronJobs: CronJob[];
  watchdog: WatchdogState | null;
}

const TABS: { id: ServiceTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'logs', label: 'Logs' },
  { id: 'config', label: 'Config' },
  { id: 'health', label: 'Health' },
  { id: 'cron', label: 'Cron' },
];

export function ServiceDetail({ serviceId, tab, onTabChange, onBack }: ServiceDetailProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [process, setProcess] = useState<PM2Process | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/services/${serviceId}`);
      if (res.ok) {
        const data: ServiceDetailResponse = await res.json();
        setProject(data.project ?? null);
        setProcess(data.pm2Process ?? null);
      } else if (res.status === 404) {
        setProject(null);
      }
    } catch {
      // silently fail — error shown in loading state
    } finally {
      setLoading(false);
    }
  }, [serviceId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const pm2Action = useCallback(async (action: 'start' | 'stop' | 'restart') => {
    if (!project) return;
    const target = project.server?.pm2Name ?? project.name;
    setActionLoading(true);
    try {
      await fetch('/api/pm2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, target }),
      });
      await fetchData();
    } finally {
      setActionLoading(false);
    }
  }, [project, fetchData]);

  const [unregisterOpen, setUnregisterOpen] = useState(false);
  const [unregistering, setUnregistering]   = useState(false);

  const handleUnregister = useCallback(async () => {
    if (!project) return;
    setUnregistering(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, deleteDirectory: false }),
      });
      if (res.ok) onBack();
    } finally {
      setUnregistering(false);
    }
  }, [project, onBack]);

  // Close modal on Escape
  useEffect(() => {
    if (!unregisterOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setUnregisterOpen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [unregisterOpen]);

  const status = process?.status ?? 'unknown';
  const canStart = status === 'stopped' || status === 'errored' || status === 'unknown';
  const canStop = status === 'online' || status === 'launching';

  if (loading) return (
    <div className="svc-detail">
      <header className="svc-detail__header">
        <div style={{ width: 28, height: 28, borderRadius: 6, flexShrink: 0 }} className="skeleton" />
        <div style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0 }} className="skeleton" />
        <div style={{ width: 160, height: 16, borderRadius: 4 }} className="skeleton" />
      </header>
      <nav className="svc-detail__tabs">
        {TABS.map(t => (
          <div key={t.id} style={{ width: 48, height: 9, borderRadius: 3, margin: '12px 8px' }} className="skeleton" />
        ))}
      </nav>
      <div className="svc-detail__skeleton-body">
        <div className="svc-detail__skeleton-section">
          <div className="svc-detail__skeleton-title skeleton" />
          <div className="svc-skeleton-metrics">
            {[...Array(6)].map((_, i) => <div key={i} className="svc-skeleton-metric skeleton" />)}
          </div>
          <div className="svc-skeleton-cards-row">
            {[...Array(3)].map((_, i) => <div key={i} className="svc-skeleton-card skeleton" />)}
          </div>
        </div>
        <div className="svc-detail__skeleton-section">
          <div className="svc-detail__skeleton-title skeleton" />
          <div className="svc-detail__skeleton-row">
            {[...Array(4)].map((_, i) => <div key={i} className="svc-detail__skeleton-field skeleton" />)}
          </div>
        </div>
      </div>
    </div>
  );
  if (!project) return <div className="svc-detail__loading" style={{ color: '#ef4444' }}>Service not found.</div>;

  return (
    <div className="svc-detail">
      <header className="svc-detail__header">
        <button className="svc-detail__back-btn" onClick={onBack} aria-label="Back">
          <ArrowLeft size={16} />
        </button>
        <div className="svc-detail__icon">
          <Server size={16} color="var(--accent)" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="svc-detail__name">{project.name}</h2>
        </div>
        <StatusBadge status={status} />
        <div className="svc-detail__actions">
          <button className="svc-detail__action-btn" disabled={!canStart || actionLoading} onClick={() => pm2Action('start')}>Start</button>
          <button className="svc-detail__action-btn" disabled={!canStop || actionLoading} onClick={() => pm2Action('stop')}>Stop</button>
          <button className="svc-detail__action-btn" disabled={actionLoading} onClick={() => pm2Action('restart')}>Restart</button>
          <span className="svc-detail__action-divider" aria-hidden="true" />
          <button className="svc-detail__action-btn svc-detail__action-btn--danger" onClick={() => setUnregisterOpen(true)}>Unregister</button>
        </div>
      </header>

      <nav className="svc-detail__tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`svc-detail__tab${tab === t.id ? ' svc-detail__tab--active' : ''}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="svc-detail__content">
        <div key={tab} className="systems-tab-content-enter">
          {tab === 'overview' && <OverviewTab project={project} process={process} onRefresh={fetchData} />}
          {tab === 'logs' && <LogsTab serviceName={project.server?.pm2Name ?? project.name} />}
          {tab === 'config' && <ConfigTab project={project} onRefresh={fetchData} />}
          {tab === 'health' && <HealthTab projectId={project.id} project={project} process={process} />}
          {tab === 'cron' && <CronTab project={project} />}
        </div>
      </div>

      {unregisterOpen && (
        <div
          className="svc-unregister-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="unregister-title"
          onClick={e => { if (e.target === e.currentTarget) setUnregisterOpen(false); }}
        >
          <div className="svc-unregister-modal">
            <h3 className="svc-unregister-modal__title" id="unregister-title">Unregister Service</h3>
            <p className="svc-unregister-modal__body">
              Are you sure you want to unregister <strong>{project.name}</strong>? This removes it from {PRODUCT_NAME} but does not delete any files.
            </p>
            <div className="svc-unregister-modal__actions">
              <button
                className="svc-unregister-modal__btn svc-unregister-modal__btn--cancel"
                onClick={() => setUnregisterOpen(false)}
                disabled={unregistering}
              >
                Cancel
              </button>
              <button
                className="svc-unregister-modal__btn svc-unregister-modal__btn--confirm"
                onClick={handleUnregister}
                disabled={unregistering}
              >
                {unregistering ? 'Removing…' : 'Unregister'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

interface WatchdogSSEPayload {
  event: WatchdogEvent;
  states: WatchdogState[];
  timestamp: string;
}

const EVENT_LABELS: Record<WatchdogEventType, string> = {
  restart_attempt:  'Restart attempt',
  restart_success:  'Restart succeeded',
  restart_failed:   'Restart failed',
  cooldown_started: 'Cooldown started',
  cooldown_ended:   'Cooldown ended',
  port_conflict:    'Port conflict',
  circuit_broken:   'Circuit broken',
};

const EVENT_COLORS: Record<WatchdogEventType, string> = {
  restart_attempt:  'rgba(234,179,8,0.9)',
  restart_success:  'rgba(34,197,94,0.9)',
  restart_failed:   '#ef4444',
  cooldown_started: '#f97316',
  cooldown_ended:   'rgba(96,165,250,0.9)',
  port_conflict:    '#f87171',
  circuit_broken:   '#dc2626',
};

function SvgSparkline({ data, width = 160, height = 40 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="rgba(255,255,255,0.1)" strokeWidth="1" strokeDasharray="3 3" />
      </svg>
    );
  }
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - 2 - (v / max) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="rgba(37,99,235,0.85)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OverviewTab({ project, process: initialProcess, onRefresh: _onRefresh }: {
  project: Project;
  process: PM2Process | null;
  onRefresh: () => void;
}) {
  const MAX_HISTORY = 20;
  const MAX_EVENTS  = 8;

  const cpuHistoryRef = useRef<number[]>([]);
  const [cpuSeries, setCpuSeries]       = useState<number[]>([]);
  const [liveProcess, setLiveProcess]   = useState<PM2Process | null>(initialProcess);
  const [events, setEvents]             = useState<WatchdogEvent[]>([]);

  // Seed from initial prop
  useEffect(() => {
    setLiveProcess(initialProcess);
    if (initialProcess?.cpu !== undefined) {
      cpuHistoryRef.current = [...cpuHistoryRef.current, initialProcess.cpu].slice(-MAX_HISTORY);
      setCpuSeries([...cpuHistoryRef.current]);
    }
  }, [initialProcess]);

  // Live PM2 metrics via SSE
  const { data: pm2SSE } = useEventStream<PM2Response>('pm2:status');
  useEffect(() => {
    if (!pm2SSE?.processes) return;
    const pm2Name = project.server?.pm2Name ?? project.name;
    const proc = pm2SSE.processes.find(p => p.name === pm2Name);
    if (proc) {
      setLiveProcess(proc);
      cpuHistoryRef.current = [...cpuHistoryRef.current, proc.cpu ?? 0].slice(-MAX_HISTORY);
      setCpuSeries([...cpuHistoryRef.current]);
    }
  }, [pm2SSE, project.server?.pm2Name, project.name]);

  // Live watchdog events via SSE
  const { data: watchdogSSE } = useEventStream<WatchdogSSEPayload>('watchdog:event');
  useEffect(() => {
    if (!watchdogSSE?.event) return;
    const evt = watchdogSSE.event;
    if (evt.projectId !== project.id) return;
    setEvents(prev => [evt, ...prev].slice(0, MAX_EVENTS));
  }, [watchdogSSE, project.id]);

  // Load recent watchdog events on mount
  useEffect(() => {
    fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'watchdog.status' }),
    })
      .then(r => r.ok ? r.json() : null)
      .then((raw) => {
        if (!raw) return;
        const payload: WatchdogStatusResponse = raw.data ?? raw;
        const filtered = (payload.events ?? [])
          .filter(e => e.projectId === project.id)
          .slice(0, MAX_EVENTS);
        setEvents(filtered);
      })
      .catch(() => {});
  }, [project.id]);

  const proc    = liveProcess;
  const cpuPct  = proc?.cpu ?? 0;
  const links   = Object.entries(project.links).filter(([, v]) => !!v) as [string, string][];

  const metrics = [
    { label: 'CPU',      value: proc ? `${cpuPct.toFixed(1)}%` : '—',             alert: cpuPct > 80 },
    { label: 'Memory',   value: proc?.memoryFormatted ?? '—' },
    { label: 'Uptime',   value: proc?.uptimeFormatted ?? '—' },
    { label: 'Restarts', value: proc?.restarts !== undefined ? String(proc.restarts) : '—', warn: (proc?.restarts ?? 0) > 5 },
    { label: 'PID',      value: proc?.pid ? String(proc.pid) : '—' },
    { label: 'Port',     value: project.server?.port ? String(project.server.port) : '—' },
  ];

  return (
    <div className="sov-do">
      {/* Description */}
      {project.description && (
        <p className="sov-do__desc">{project.description}</p>
      )}

      {/* Live metrics strip */}
      <div className="sov-do__metrics" role="list" aria-label="Service metrics">
        {metrics.map(m => (
          <div key={m.label} className="sov-do__metric" role="listitem">
            <span className="sov-do__metric-label">{m.label}</span>
            <span
              className="sov-do__metric-value"
              style={{ color: m.alert ? '#ef4444' : m.warn ? '#f97316' : undefined }}
            >
              {m.value}
            </span>
          </div>
        ))}
      </div>

      {/* Sparkline + info cards row */}
      <div className="sov-do__cards-row">
        <div className="sov-do__sparkline-card">
          <div className="sov-do__sparkline-header">
            <span className="sov-do__card-title">CPU Usage</span>
            <span className="sov-do__sparkline-live"
              style={{ color: cpuPct > 80 ? '#ef4444' : cpuPct > 50 ? '#f97316' : 'rgba(96,165,250,0.9)' }}
            >
              {cpuPct.toFixed(1)}%
            </span>
          </div>
          <SvgSparkline data={cpuSeries} width={160} height={40} />
          <div className="sov-do__gauge-bar" role="progressbar" aria-valuenow={cpuPct} aria-valuemin={0} aria-valuemax={100}>
            <div
              className="sov-do__gauge-fill"
              style={{
                width: `${Math.min(100, cpuPct)}%`,
                background: cpuPct > 80 ? '#ef4444' : cpuPct > 50 ? '#f97316' : 'rgba(37,99,235,0.75)',
              }}
            />
          </div>
        </div>

        <div className="sov-do__proc-card">
          <div className="sov-do__card-title">Process</div>
          <div className="sov-do__proc-row"><span className="sov-do__proc-label">Mode</span><span className="sov-do__proc-val">{proc?.execMode ?? '—'}</span></div>
          <div className="sov-do__proc-row"><span className="sov-do__proc-label">PM2 ID</span><span className="sov-do__proc-val">{proc?.pm_id !== undefined ? String(proc.pm_id) : '—'}</span></div>
          <div className="sov-do__proc-row"><span className="sov-do__proc-label">Category</span><span className="sov-do__proc-val">{project.category}</span></div>
          <div className="sov-do__proc-row"><span className="sov-do__proc-label">CWD</span><span className="sov-do__proc-val sov-do__proc-val--mono">{proc?.cwd ?? project.path ?? '—'}</span></div>
        </div>

        {links.length > 0 && (
          <div className="sov-do__links-card">
            <div className="sov-do__card-title">Quick Links</div>
            {links.map(([key, url]) => (
              <a key={key} href={url} target="_blank" rel="noreferrer" className="sov-do__link">
                <ExternalLink size={11} aria-hidden="true" />
                <span>{key === 'local' ? 'Open local' : key === 'repo' ? 'Repository' : key === 'docs' ? 'Docs' : key}</span>
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Events timeline */}
      {events.length > 0 && (
        <div className="svc-detail__section" style={{ marginTop: 14 }}>
          <div className="svc-detail__section-title">Recent Events</div>
          <div className="sov-do__events" role="log" aria-label="Watchdog events">
            {events.map(e => (
              <div key={e.id} className="sov-do__event">
                <span className="sov-do__event-dot" style={{ background: EVENT_COLORS[e.eventType] }} aria-hidden="true" />
                <span className="sov-do__event-type">{EVENT_LABELS[e.eventType]}</span>
                <span className="sov-do__event-msg">{e.message}</span>
                <span className="sov-do__event-ts">{new Date(e.timestamp).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Logs Tab (rebuilt) ───────────────────────────────────────────────────────

type LogLevel = 'all' | 'err' | 'warn' | 'info';

function detectLogLevel(line: LogLine): Exclude<LogLevel, 'all'> | 'out' {
  if (line.type === 'err') return 'err';
  const msg = line.message.toUpperCase();
  if (/\bERROR\b|\[ERR\]|\bERR:/.test(msg)) return 'err';
  if (/\bWARN(ING)?\b|\[WARN\]/.test(msg)) return 'warn';
  if (/\bINFO\b|\[INFO\]/.test(msg)) return 'info';
  return 'out';
}

const LEVEL_CLASSES: Record<string, string> = {
  err:  'svc-log__line--err',
  warn: 'svc-log__line--warn',
  info: 'svc-log__line--info',
  out:  'svc-log__line--out',
};

function LogsTab({ serviceName }: { serviceName: string }) {
  const [lines, setLines]           = useState<LogLine[]>([]);
  const [lineCount, setLineCount]   = useState(200);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState('');
  const [levelFilter, setLevelFilter] = useState<LogLevel>('all');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [hasNew, setHasNew]         = useState(false);

  const panelRef    = useRef<HTMLDivElement>(null);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const fetchLogs = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/pm2/logs?name=${encodeURIComponent(serviceName)}&lines=${lineCount}&type=both`);
      if (res.ok) {
        const data: LogResponse = await res.json();
        const next = data.lines ?? [];
        setLines(prev => {
          if (prev.length > 0 && next.length > prev.length && !atBottomRef.current) {
            setHasNew(true);
          }
          return next;
        });
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [serviceName, lineCount]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  // Auto-refresh polling
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => fetchLogs(true), 3000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchLogs]);

  // Auto-scroll when new lines arrive
  useEffect(() => {
    if (autoScroll && atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      setHasNew(false);
    }
  }, [lines, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    atBottomRef.current = at;
    if (at) setHasNew(false);
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setHasNew(false);
    atBottomRef.current = true;
  }, []);

  const handleDownload = useCallback(() => {
    const text = lines
      .map(l => `[${l.timestamp ?? ''}] [${l.type.toUpperCase()}] ${l.message}`)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${serviceName}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [lines, serviceName]);

  const filtered = useMemo(() => {
    let result = lines;
    if (levelFilter !== 'all') {
      result = result.filter(l => {
        const lv = detectLogLevel(l);
        return levelFilter === 'err' ? lv === 'err' :
               levelFilter === 'warn' ? lv === 'warn' :
               levelFilter === 'info' ? lv === 'info' : true;
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(l => l.message.toLowerCase().includes(q));
    }
    return result;
  }, [lines, levelFilter, search]);

  const errCount  = useMemo(() => lines.filter(l => detectLogLevel(l) === 'err').length,  [lines]);
  const warnCount = useMemo(() => lines.filter(l => detectLogLevel(l) === 'warn').length, [lines]);

  const LEVELS: { value: LogLevel; label: string }[] = [
    { value: 'all',  label: 'All' },
    { value: 'err',  label: 'ERR' },
    { value: 'warn', label: 'WARN' },
    { value: 'info', label: 'INFO' },
  ];

  return (
    <div className="svc-log">
      {/* Toolbar */}
      <div className="svc-log__toolbar">
        <div className="svc-log__toolbar-left">
          <select
            className="svc-log__select"
            value={lineCount}
            onChange={e => setLineCount(Number(e.target.value))}
            aria-label="Line count"
          >
            <option value={50}>50 lines</option>
            <option value={100}>100 lines</option>
            <option value={200}>200 lines</option>
            <option value={500}>500 lines</option>
          </select>
          <div className="svc-log__search-wrap">
            <Search size={11} className="svc-log__search-icon" aria-hidden="true" />
            <input
              className="svc-log__search"
              placeholder="Search…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search logs"
            />
            {search && (
              <button className="svc-log__search-clear" onClick={() => setSearch('')} aria-label="Clear search">
                <X size={10} />
              </button>
            )}
          </div>
        </div>
        <div className="svc-log__toolbar-right">
          {/* Level filter chips */}
          <div className="svc-log__levels" role="group" aria-label="Log level filter">
            {LEVELS.map(({ value, label }) => (
              <button
                key={value}
                className={`svc-log__level svc-log__level--${value}${levelFilter === value ? ' svc-log__level--active' : ''}`}
                onClick={() => setLevelFilter(value)}
                aria-pressed={levelFilter === value}
              >
                {label}
                {value === 'err'  && errCount  > 0 && <span className="svc-log__badge-count">{errCount}</span>}
                {value === 'warn' && warnCount > 0 && <span className="svc-log__badge-count">{warnCount}</span>}
              </button>
            ))}
          </div>
          {/* Auto-scroll toggle */}
          <button
            className={`svc-log__ctrl${autoScroll ? ' svc-log__ctrl--on' : ''}`}
            onClick={() => setAutoScroll(v => !v)}
            title={autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}
            aria-pressed={autoScroll}
          >
            <ArrowDown size={11} />
          </button>
          {/* Live refresh toggle */}
          <button
            className={`svc-log__ctrl${autoRefresh ? ' svc-log__ctrl--on' : ''}`}
            onClick={() => setAutoRefresh(v => !v)}
            title={autoRefresh ? 'Live refresh on (3s)' : 'Enable live refresh'}
            aria-pressed={autoRefresh}
          >
            <RefreshCw size={11} className={autoRefresh ? 'svc-log__spin' : undefined} />
          </button>
          {/* Download */}
          <button
            className="svc-log__ctrl"
            onClick={handleDownload}
            disabled={lines.length === 0}
            title="Download logs"
            aria-label="Download logs"
          >
            <Download size={11} />
          </button>
          {/* Manual refresh */}
          <button
            className="svc-log__ctrl"
            onClick={() => fetchLogs()}
            title="Refresh now"
            aria-label="Refresh"
            disabled={loading}
          >
            <RefreshCw size={11} className={loading && !autoRefresh ? 'svc-log__spin' : undefined} />
          </button>
        </div>
      </div>

      {/* Log panel */}
      <div className="svc-log__panel" ref={panelRef} onScroll={handleScroll}>
        {loading && lines.length === 0 && (
          <div className="svc-skeleton-lines">
            {[100, 75, 90, 60, 85, 70, 95, 65, 80, 55].map((w, i) => (
              <div key={i} className="svc-skeleton-line skeleton" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="svc-log__empty">
            {search || levelFilter !== 'all' ? 'No lines match the filter.' : 'No log output available.'}
          </div>
        )}
        {filtered.map((l, i) => {
          const lv = detectLogLevel(l);
          return (
            <div key={i} className={`svc-log__line ${LEVEL_CLASSES[lv] ?? 'svc-log__line--out'}`}>
              {l.timestamp && (
                <span className="svc-log__ts">{l.timestamp.length > 10 ? l.timestamp.slice(11, 19) : l.timestamp}</span>
              )}
              <span className={`svc-log__type svc-log__type--${l.type}`}>{l.type}</span>
              <span className="svc-log__msg">{l.message}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* New-logs jump button */}
      {hasNew && (
        <button className="svc-log__new-logs" onClick={scrollToBottom} aria-label="Jump to new logs">
          <ArrowDown size={11} />
          New logs
        </button>
      )}

      {/* Status bar */}
      <div className="svc-log__statusbar">
        <span className="svc-log__statusbar-count">
          {filtered.length}{filtered.length !== lines.length ? ` / ${lines.length}` : ''} lines
        </span>
        {search && (
          <span className="svc-log__statusbar-item">filter: "{search}"</span>
        )}
        {loading && !autoRefresh && (
          <span className="svc-log__statusbar-item">Refreshing…</span>
        )}
        {autoRefresh && (
          <span className="svc-log__statusbar-live">● Live</span>
        )}
      </div>
    </div>
  );
}

// ─── Config Tab ───────────────────────────────────────────────────────────────

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'tool',           label: 'Tool' },
  { value: 'site',           label: 'Site' },
  { value: 'server',         label: 'Server' },
  { value: 'service',        label: 'Service' },
  { value: 'api',            label: 'API' },
  { value: 'ai',             label: 'AI' },
  { value: 'development',    label: 'Development' },
  { value: 'automation',     label: 'Automation' },
  { value: 'media',          label: 'Media' },
  { value: 'monitoring',     label: 'Monitoring' },
  { value: 'infrastructure', label: 'Infrastructure' },
  { value: 'agent',          label: 'Agent' },
];

interface EditableFieldProps {
  label: string;
  value: string;
  onSave: (val: string) => Promise<void>;
  mono?: boolean;
  multiline?: boolean;
  select?: { value: string; label: string }[];
}

function EditableField({ label, value, onSave, mono = false, multiline = false, select }: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);
  const [saving,  setSaving]  = useState(false);

  const inputRef    = useRef<HTMLInputElement>(null);
  const selectRef   = useRef<HTMLSelectElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startEdit = () => {
    setDraft(value);
    setEditing(true);
    setTimeout(() => {
      (inputRef.current ?? selectRef.current ?? textareaRef.current)?.focus();
    }, 10);
  };
  const cancelEdit  = () => setEditing(false);
  const commitEdit  = async () => {
    const trimmed = draft.trim();
    if (trimmed === value) { cancelEdit(); return; }
    setSaving(true);
    try { await onSave(trimmed); setEditing(false); }
    finally { setSaving(false); }
  };

  return (
    <div className="sov-cfg__field">
      <div className="svc-detail__field-label">{label}</div>
      {editing ? (
        <div className="sov-cfg__edit">
          {select ? (
            <select
              ref={selectRef}
              className="sov-cfg__input"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              disabled={saving}
              aria-label={label}
            >
              {select.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : multiline ? (
            <textarea
              ref={textareaRef}
              className={`sov-cfg__input sov-cfg__input--ta${mono ? ' sov-cfg__input--mono' : ''}`}
              value={draft}
              rows={3}
              onChange={e => setDraft(e.target.value)}
              disabled={saving}
              aria-label={label}
            />
          ) : (
            <input
              ref={inputRef}
              className={`sov-cfg__input${mono ? ' sov-cfg__input--mono' : ''}`}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') cancelEdit(); }}
              disabled={saving}
              aria-label={label}
            />
          )}
          <button className="sov-cfg__btn sov-cfg__btn--save" onClick={commitEdit} disabled={saving}>Save</button>
          <button className="sov-cfg__btn sov-cfg__btn--cancel" onClick={cancelEdit} disabled={saving} aria-label="Cancel">✕</button>
        </div>
      ) : (
        <div
          className="sov-cfg__value"
          onClick={startEdit}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') startEdit(); }}
          title="Click to edit"
          aria-label={`Edit ${label}`}
        >
          <span className={`svc-detail__field-value${mono ? ' svc-detail__field-value--mono' : ''}`}>
            {value || <span style={{ color: 'var(--muted)' }}>—</span>}
          </span>
          <span className="sov-cfg__pen" aria-hidden="true">✏</span>
        </div>
      )}
    </div>
  );
}

function ConfigTab({ project, onRefresh }: { project: Project; onRefresh: () => void }) {
  const srv = project.server;

  const patch = useCallback(async (fields: Record<string, unknown>) => {
    const res = await fetch('/api/projects', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, ...fields }),
    });
    if (!res.ok) throw new Error('Save failed');
    onRefresh();
  }, [project.id, onRefresh]);

  return (
    <>
      {/* Identity */}
      <div className="svc-detail__section">
        <div className="svc-detail__section-title">Identity</div>
        <div className="sov-cfg__fields">
          <EditableField
            label="Description"
            value={project.description}
            onSave={v => patch({ description: v })}
            multiline
          />
          <EditableField
            label="Category"
            value={project.category}
            onSave={v => patch({ category: v })}
            select={CATEGORY_OPTIONS}
          />
          {project.tags.length > 0 && (
            <div className="sov-cfg__field">
              <div className="svc-detail__field-label">Tags</div>
              <div className="sov-cfg__tags">
                {project.tags.map(t => <span key={t} className="sov-cfg__tag">{t}</span>)}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* File Paths */}
      <div className="svc-detail__section">
        <div className="svc-detail__section-title">File Paths</div>
        <div className="svc-detail__field-grid">
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="svc-detail__field-label">Project Path</div>
            <div className="svc-detail__field-value svc-detail__field-value--mono">{project.path}</div>
          </div>
        </div>
      </div>

      {/* Server Config */}
      {srv && (
        <div className="svc-detail__section">
          <div className="svc-detail__section-title">Server Config</div>
          <div className="svc-detail__field-grid">
            {srv.pm2Name && (
              <div>
                <div className="svc-detail__field-label">PM2 Name</div>
                <div className="svc-detail__field-value svc-detail__field-value--mono">{srv.pm2Name}</div>
              </div>
            )}
            <div>
              <div className="svc-detail__field-label">Port</div>
              <div className="svc-detail__field-value">{srv.port || '—'}</div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="svc-detail__field-label">Start Command</div>
              <div className="svc-detail__field-value svc-detail__field-value--mono">{srv.startCommand || '—'}</div>
            </div>
            {srv.stopCommand && (
              <div style={{ gridColumn: '1 / -1' }}>
                <div className="svc-detail__field-label">Stop Command</div>
                <div className="svc-detail__field-value svc-detail__field-value--mono">{srv.stopCommand}</div>
              </div>
            )}
            <div>
              <div className="svc-detail__field-label">Auto Start</div>
              <div className="svc-detail__field-value">{srv.autoStart ? 'Yes' : 'No'}</div>
            </div>
            <div>
              <div className="svc-detail__field-label">Auto Restart</div>
              <div className="svc-detail__field-value">{srv.autoRestart ? 'Yes' : 'No'}</div>
            </div>
          </div>
        </div>
      )}

      {/* Watchdog */}
      {srv?.watchdog && (
        <div className="svc-detail__section">
          <div className="svc-detail__section-title">Watchdog Config</div>
          <div className="svc-detail__field-grid">
            <div><div className="svc-detail__field-label">Enabled</div><div className="svc-detail__field-value">{srv.watchdog.enabled ? 'Yes' : 'No'}</div></div>
            {srv.watchdog.maxRestarts  !== undefined && <div><div className="svc-detail__field-label">Max Restarts</div><div className="svc-detail__field-value">{srv.watchdog.maxRestarts}</div></div>}
            {srv.watchdog.cooldownMs   !== undefined && <div><div className="svc-detail__field-label">Cooldown</div><div className="svc-detail__field-value">{srv.watchdog.cooldownMs / 1000}s</div></div>}
            {srv.watchdog.restartDelayMs !== undefined && <div><div className="svc-detail__field-label">Restart Delay</div><div className="svc-detail__field-value">{srv.watchdog.restartDelayMs / 1000}s</div></div>}
            {srv.watchdog.maxCycles    !== undefined && <div><div className="svc-detail__field-label">Max Cycles</div><div className="svc-detail__field-value">{srv.watchdog.maxCycles}</div></div>}
          </div>
        </div>
      )}

      {/* Health Checks */}
      {project.healthChecks.length > 0 && (
        <div className="svc-detail__section">
          <div className="svc-detail__section-title">Health Checks</div>
          {project.healthChecks.map((hc, i) => (
            <div key={i} className="svc-detail__field-grid" style={{ marginBottom: 8 }}>
              <div><div className="svc-detail__field-label">Type</div><div className="svc-detail__field-value">{hc.type}</div></div>
              <div><div className="svc-detail__field-label">Label</div><div className="svc-detail__field-value">{hc.label ?? '—'}</div></div>
              {'port' in hc && <div><div className="svc-detail__field-label">Port</div><div className="svc-detail__field-value">{(hc as { port: number }).port}</div></div>}
              {'url' in hc && <div style={{ gridColumn: '1 / -1' }}><div className="svc-detail__field-label">URL</div><div className="svc-detail__field-value svc-detail__field-value--mono">{(hc as { url: string }).url}</div></div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Health / Cron helpers ────────────────────────────────────────────────────

function HealthStatusIcon({ status, size = 14 }: { status: string; size?: number }) {
  if (status === 'online') return <CheckCircle2 size={size} className="hc-icon hc-icon--ok" aria-hidden="true" />;
  if (status === 'offline') return <XCircle size={size} className="hc-icon hc-icon--fail" aria-hidden="true" />;
  if (status === 'warning') return <AlertCircle size={size} className="hc-icon hc-icon--warn" aria-hidden="true" />;
  return <Wifi size={size} className="hc-icon hc-icon--unknown" aria-hidden="true" />;
}

function getCheckDetail(hc: HealthCheck): string {
  switch (hc.type) {
    case 'http': return hc.url;
    case 'port': return `port ${hc.port}`;
    case 'command': return hc.command;
    case 'process': return hc.processName;
    default: return '';
  }
}

function parseCronSchedule(schedule: string): string {
  const p = schedule.trim().split(/\s+/);
  if (p.length !== 5) return schedule;
  const [min, hour, dom, month, dow] = p;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (min === '*' && hour === '*') return 'Every minute';
  if (min.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*')
    return `Every ${min.slice(2)} minutes`;
  if (hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*')
    return `Every ${hour.slice(2)} hours`;
  if (!min.includes('*') && !hour.includes('*') && dom === '*' && month === '*' && dow !== '*')
    return `Weekly on ${DAYS[parseInt(dow, 10)] ?? dow} at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (!min.includes('*') && !hour.includes('*') && dom === '*' && month === '*' && dow === '*')
    return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (!min.includes('*') && hour === '*' && dom === '*' && month === '*' && dow === '*')
    return `Hourly at :${min.padStart(2, '0')}`;
  return schedule;
}

function formatCountdown(nextRun: string): string {
  const diff = new Date(nextRun).getTime() - Date.now();
  if (diff <= 0) return 'due now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ─── Health Tab ───────────────────────────────────────────────────────────────

function HealthTab({ projectId, project, process }: { projectId: string; project: Project; process: PM2Process | null }) {
  const [healthStatus, setHealthStatus] = useState<ProjectHealthStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [history, setHistory] = useState<ProjectHealthStatus[]>([]);
  const [watchdogEnabled, setWatchdogEnabled] = useState(project.server?.watchdog?.enabled ?? false);
  const [toggling, setToggling] = useState(false);
  const [watchdogState, setWatchdogState] = useState<WatchdogState | null>(null);
  const [wdLoading, setWdLoading] = useState(false);

  const hasHealthChecks = (project.healthChecks?.length ?? 0) > 0;

  const runChecks = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectIds: [projectId] }),
      });
      if (res.ok) {
        const data: { statuses: ProjectHealthStatus[] } = await res.json();
        const status = data.statuses?.[0] ?? null;
        if (status) {
          setHealthStatus(status);
          setHistory(h => [status, ...h].slice(0, 10));
        }
      }
    } finally {
      setChecking(false);
    }
  }, [projectId]);

  const fetchWdState = useCallback(async () => {
    setWdLoading(true);
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'watchdog.status' }),
      });
      if (res.ok) {
        const raw = await res.json();
        const payload: WatchdogStatusResponse = raw.data ?? raw;
        setWatchdogState((payload.services ?? []).find(s => s.projectId === projectId) ?? null);
      }
    } finally {
      setWdLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (watchdogEnabled) fetchWdState();
  }, [watchdogEnabled, fetchWdState]);

  const handleWdToggle = useCallback(async () => {
    const next = !watchdogEnabled;
    setToggling(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, watchdog: { enabled: next } }),
      });
      if (res.ok) {
        setWatchdogEnabled(next);
        if (!next) setWatchdogState(null);
      }
    } finally {
      setToggling(false);
    }
  }, [projectId, watchdogEnabled]);

  const uptime = process?.uptimeFormatted;
  const cfg = project.server?.watchdog;

  return (
    <div className="hc-root">
      {/* Header: uptime + run button */}
      <div className="hc-header">
        <div className="hc-header-stats">
          {uptime && (
            <div className="hc-stat">
              <Clock size={12} aria-hidden="true" />
              <span>Uptime: {uptime}</span>
            </div>
          )}
          {healthStatus && (
            <div className="hc-stat">
              <span>Checked {new Date(healthStatus.lastChecked).toLocaleTimeString()}</span>
            </div>
          )}
        </div>
        <button
          className="svc-detail__action-btn hc-run-btn"
          onClick={runChecks}
          disabled={checking || !hasHealthChecks}
          title={hasHealthChecks ? 'Run health checks now' : 'No health checks configured for this service'}
        >
          <RefreshCw size={13} className={checking ? 'hc-spin' : undefined} aria-hidden="true" />
          {checking ? 'Checking…' : 'Run Checks'}
        </button>
      </div>

      {/* Overall status banner */}
      {healthStatus && (
        <div className={`hc-overall hc-overall--${healthStatus.overallStatus}`}>
          <HealthStatusIcon status={healthStatus.overallStatus} size={16} />
          <span>Overall: <strong>{healthStatus.overallStatus}</strong></span>
          <span className="hc-overall-count">{healthStatus.checks.length} check{healthStatus.checks.length !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Individual check results */}
      {hasHealthChecks ? (
        <div className="hc-checks">
          {healthStatus ? (
            healthStatus.checks.map((check, i) => (
              <div key={check.checkId ?? i} className={`hc-check hc-check--${check.status}`}>
                <HealthStatusIcon status={check.status} size={14} />
                <div className="hc-check-body">
                  <span className="hc-check-label">{check.label}</span>
                  {check.message && <span className="hc-check-msg">{check.message}</span>}
                </div>
                {check.responseTime !== undefined && (
                  <span className="hc-check-rt">{check.responseTime}ms</span>
                )}
                <span className={`hc-check-badge hc-check-badge--${check.status}`}>{check.status}</span>
              </div>
            ))
          ) : (
            <>
              {project.healthChecks.map((hc, i) => (
                <div key={i} className="hc-check hc-check--unknown">
                  <Wifi size={14} className="hc-icon hc-icon--unknown" aria-hidden="true" />
                  <div className="hc-check-body">
                    <span className="hc-check-label">{hc.label}</span>
                    <span className="hc-check-msg">{hc.type}: {getCheckDetail(hc)}</span>
                  </div>
                  <span className="hc-check-badge hc-check-badge--unknown">not run</span>
                </div>
              ))}
              <div className="hc-run-hint">Hit &ldquo;Run Checks&rdquo; to see live results</div>
            </>
          )}
        </div>
      ) : (
        <div className="svc-detail__empty hc-no-checks">
          No health checks configured. Add them via the Config tab.
        </div>
      )}

      {/* Health history dots */}
      {history.length > 1 && (
        <div className="hc-history">
          <div className="svc-detail__section-title" style={{ marginBottom: 8 }}>Check History (this session)</div>
          <div className="hc-history-strip">
            {history.map((h, i) => (
              <div
                key={i}
                className={`hc-history-dot hc-history-dot--${h.overallStatus}`}
                title={`${h.overallStatus} — ${new Date(h.lastChecked).toLocaleTimeString()}`}
              />
            ))}
          </div>
          <div className="hc-history-legend">
            <span>{history.length} checks</span>
            <span className="hc-legend-item"><span className="hc-legend-dot hc-legend-dot--online" /> OK</span>
            <span className="hc-legend-item"><span className="hc-legend-dot hc-legend-dot--offline" /> Fail</span>
            <span className="hc-legend-item"><span className="hc-legend-dot hc-legend-dot--warning" /> Warn</span>
          </div>
        </div>
      )}

      <div className="hc-divider" />

      {/* Watchdog */}
      <div className="svc-detail__section">
        <div className="wd-toggle-row">
          <div className="wd-toggle-info">
            <div className="wd-toggle-label">Watchdog Monitoring</div>
            <div className="wd-toggle-hint">
              {watchdogEnabled
                ? 'Auto-restarts on health check failure. Circuit-breaks persistent crash loops.'
                : 'Enable to monitor this service and auto-restart on failure.'}
            </div>
          </div>
          <button
            className={`wd-toggle${watchdogEnabled ? ' wd-toggle--on' : ''}`}
            onClick={handleWdToggle}
            disabled={toggling}
            aria-pressed={watchdogEnabled}
            aria-label={watchdogEnabled ? 'Disable watchdog' : 'Enable watchdog'}
          >
            <span className="wd-toggle__track"><span className="wd-toggle__thumb" /></span>
          </button>
        </div>

        {watchdogEnabled && (
          <>
            {wdLoading && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ height: 10, width: 80, borderRadius: 4 }} className="skeleton" />
                <div className="svc-detail__skeleton-row">
                  {[...Array(4)].map((_, i) => <div key={i} className="svc-detail__skeleton-field skeleton" />)}
                </div>
              </div>
            )}
            {!wdLoading && !watchdogState && (
              <div className="svc-detail__empty" style={{ marginTop: 16 }}>Watchdog enabled. Waiting for first health check cycle.</div>
            )}
            {!wdLoading && watchdogState && (
              <div style={{ marginTop: 20 }}>
                <div className="svc-detail__section-title">Live State</div>
                <div className="svc-detail__field-grid">
                  <div><div className="svc-detail__field-label">Restart Count</div><div className="svc-detail__field-value">{watchdogState.restartCount}</div></div>
                  <div><div className="svc-detail__field-label">Failed Cycles</div><div className="svc-detail__field-value">{watchdogState.failedCycles}</div></div>
                  <div><div className="svc-detail__field-label">Circuit Broken</div><div className="svc-detail__field-value" style={{ color: watchdogState.circuitBroken ? '#f87171' : 'inherit' }}>{watchdogState.circuitBroken ? 'Yes' : 'No'}</div></div>
                  {watchdogState.lastCheckStatus && <div><div className="svc-detail__field-label">Last Check</div><div className="svc-detail__field-value">{watchdogState.lastCheckStatus}</div></div>}
                  {watchdogState.lastRestartAt && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <div className="svc-detail__field-label">Last Restart</div>
                      <div className="svc-detail__field-value">{new Date(watchdogState.lastRestartAt).toLocaleString()}</div>
                    </div>
                  )}
                  {watchdogState.cooldownUntil && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <div className="svc-detail__field-label">Cooldown Until</div>
                      <div className="svc-detail__field-value" style={{ color: '#eab308' }}>{new Date(watchdogState.cooldownUntil).toLocaleString()}</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {cfg && (
          <div style={{ marginTop: 20 }}>
            <div className="svc-detail__section-title">Configuration</div>
            <div className="svc-detail__field-grid">
              {cfg.maxRestarts !== undefined && <div><div className="svc-detail__field-label">Max Restarts</div><div className="svc-detail__field-value">{cfg.maxRestarts}</div></div>}
              {cfg.cooldownMs !== undefined && <div><div className="svc-detail__field-label">Cooldown</div><div className="svc-detail__field-value">{cfg.cooldownMs / 1000}s</div></div>}
              {cfg.restartDelayMs !== undefined && <div><div className="svc-detail__field-label">Restart Delay</div><div className="svc-detail__field-value">{cfg.restartDelayMs / 1000}s</div></div>}
              {cfg.maxCycles !== undefined && <div><div className="svc-detail__field-label">Max Cycles</div><div className="svc-detail__field-value">{cfg.maxCycles}</div></div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Cron Tab ─────────────────────────────────────────────────────────────────

function CronTab({ project }: { project: Project }) {
  const [jobs, setJobs] = useState<CronJobType[]>([]);
  const [loading, setLoading] = useState(true);
  const [executions, setExecutions] = useState<Record<string, CronExecution[]>>({});
  const [loadingHistory, setLoadingHistory] = useState<Record<string, boolean>>({});
  const [triggering, setTriggering] = useState<Record<string, boolean>>({});
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/cron');
      if (res.ok) {
        const data = await res.json();
        const allJobs: CronJobType[] = data.jobs ?? [];
        const name = (project.server?.pm2Name ?? project.name).toLowerCase();
        const filtered = allJobs.filter(
          j => j.name.toLowerCase().includes(name) || j.tags?.includes(project.id)
        );
        setJobs(filtered.sort((a, b) => a.name.localeCompare(b.name)));
      }
    } finally {
      setLoading(false);
    }
  }, [project]);

  const fetchHistory = useCallback(async (jobId: string) => {
    setLoadingHistory(s => ({ ...s, [jobId]: true }));
    try {
      const res = await fetch(`/api/cron?history=${encodeURIComponent(jobId)}&limit=10`);
      if (res.ok) {
        const data = await res.json();
        setExecutions(s => ({ ...s, [jobId]: data.executions ?? [] }));
      }
    } finally {
      setLoadingHistory(s => ({ ...s, [jobId]: false }));
    }
  }, []);

  const handleTrigger = useCallback(async (jobId: string) => {
    setTriggering(s => ({ ...s, [jobId]: true }));
    try {
      await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trigger', jobId }),
      });
      await Promise.all([fetchJobs(), fetchHistory(jobId)]);
    } finally {
      setTriggering(s => ({ ...s, [jobId]: false }));
    }
  }, [fetchJobs, fetchHistory]);

  const handleToggle = useCallback(async (job: CronJobType) => {
    setToggling(s => ({ ...s, [job.id]: true }));
    try {
      const res = await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', jobId: job.id }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.job) setJobs(js => js.map(j => j.id === job.id ? (data.job as CronJobType) : j));
      }
    } finally {
      setToggling(s => ({ ...s, [job.id]: false }));
    }
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  // Auto-expand first job and load its history
  useEffect(() => {
    if (jobs.length > 0 && expandedJob === null) {
      const first = jobs[0].id;
      setExpandedJob(first);
      fetchHistory(first);
    }
  }, [jobs, expandedJob, fetchHistory]);

  const serviceCronJobs = project.server?.cronJobs ?? [];

  if (loading) return (
    <div className="svc-detail__skeleton-body">
      <div className="svc-detail__skeleton-section">
        <div className="svc-detail__skeleton-title skeleton" />
        {[...Array(3)].map((_, i) => (
          <div key={i} className="svc-detail__skeleton-row">
            <div className="svc-detail__skeleton-field skeleton" />
            <div className="svc-detail__skeleton-field skeleton" />
          </div>
        ))}
      </div>
    </div>
  );

  const hasAny = jobs.length > 0 || serviceCronJobs.length > 0;
  if (!hasAny) return (
    <div className="svc-detail__empty-state">
      <Clock size={32} className="svc-detail__empty-icon" aria-hidden="true" />
      <div className="svc-detail__empty-title">No scheduled jobs</div>
      <div className="svc-detail__empty-hint">No cron jobs are configured for this service.</div>
    </div>
  );

  return (
    <div className="cron-root">
      {jobs.length > 0 && (
        <div className="cron-section">
          <div className="svc-detail__section-title">Scheduled Jobs</div>
          {jobs.map(job => {
            const isExpanded = expandedJob === job.id;
            const jobExecs = executions[job.id] ?? [];
            const isHistLoading = loadingHistory[job.id] ?? false;
            const isTrig = triggering[job.id] ?? false;
            const isToggling = toggling[job.id] ?? false;
            return (
              <div key={job.id} className={`cron-job${isExpanded ? ' cron-job--expanded' : ''}`}>
                <button
                  className="cron-job__header"
                  onClick={() => {
                    const next = isExpanded ? null : job.id;
                    setExpandedJob(next);
                    if (next && !executions[next]) fetchHistory(next);
                  }}
                >
                  <div className={`cron-job__status-dot${job.enabled ? ' cron-job__status-dot--active' : ' cron-job__status-dot--paused'}`} />
                  <div className="cron-job__info">
                    <span className="cron-job__name">{job.name}</span>
                    <span className="cron-job__schedule">{parseCronSchedule(job.schedule)}</span>
                  </div>
                  <div className="cron-job__meta">
                    {job.nextRun && job.enabled && (
                      <span className="cron-job__next-run" title={new Date(job.nextRun).toLocaleString()}>
                        in {formatCountdown(job.nextRun)}
                      </span>
                    )}
                    {!job.enabled && <span className="cron-job__paused-badge">paused</span>}
                  </div>
                  <ChevronDown size={14} className={`cron-job__chevron${isExpanded ? ' cron-job__chevron--open' : ''}`} />
                </button>

                {isExpanded && (
                  <div className="cron-job__body">
                    <div className="cron-job__actions">
                      <button
                        className="svc-detail__action-btn cron-trigger-btn"
                        onClick={() => handleTrigger(job.id)}
                        disabled={isTrig}
                      >
                        <Play size={12} aria-hidden="true" />
                        {isTrig ? 'Running…' : 'Run Now'}
                      </button>
                      <button
                        className={`svc-detail__action-btn cron-toggle-btn${!job.enabled ? ' cron-toggle-btn--enable' : ''}`}
                        onClick={() => handleToggle(job)}
                        disabled={isToggling}
                      >
                        {job.enabled ? <Pause size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
                        {job.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </div>

                    <div className="svc-detail__field-grid cron-job__stats">
                      <div><div className="svc-detail__field-label">Schedule</div><div className="svc-detail__field-value svc-detail__field-value--mono">{job.schedule}</div></div>
                      <div><div className="svc-detail__field-label">Type</div><div className="svc-detail__field-value">{job.jobType}</div></div>
                      {job.lastRun && <div><div className="svc-detail__field-label">Last Run</div><div className="svc-detail__field-value">{new Date(job.lastRun).toLocaleString()}</div></div>}
                      {job.lastRunDurationMs !== undefined && (
                        <div><div className="svc-detail__field-label">Last Duration</div><div className="svc-detail__field-value">{Math.round(job.lastRunDurationMs / 1000)}s</div></div>
                      )}
                      {job.lastRunExitCode !== undefined && (
                        <div>
                          <div className="svc-detail__field-label">Exit Code</div>
                          <div className="svc-detail__field-value" style={{ color: job.lastRunExitCode === 0 ? '#4ade80' : '#f87171' }}>{job.lastRunExitCode}</div>
                        </div>
                      )}
                      {job.nextRun && (
                        <div><div className="svc-detail__field-label">Next Run</div><div className="svc-detail__field-value">{new Date(job.nextRun).toLocaleString()}</div></div>
                      )}
                    </div>

                    <div className="cron-history">
                      <div className="cron-history__header">
                        <span>Recent Executions</span>
                        <button
                          className="cron-history__refresh"
                          onClick={() => fetchHistory(job.id)}
                          title="Refresh history"
                          aria-label="Refresh execution history"
                        >
                          <RefreshCw size={11} aria-hidden="true" />
                        </button>
                      </div>
                      {isHistLoading ? (
                        <div style={{ color: 'var(--muted)', fontSize: 11, padding: '8px 0' }}>Loading…</div>
                      ) : jobExecs.length === 0 ? (
                        <div style={{ color: 'var(--muted)', fontSize: 11, padding: '8px 0' }}>No execution history yet.</div>
                      ) : (
                        <div className="cron-history__list">
                          {jobExecs.map(exec => (
                            <div key={exec.id} className={`cron-exec cron-exec--${exec.status}`}>
                              <div className="cron-exec__row">
                                <span className="cron-exec__icon">
                                  {exec.status === 'success'
                                    ? <CheckCircle2 size={12} aria-hidden="true" />
                                    : exec.status === 'failed'
                                      ? <XCircle size={12} aria-hidden="true" />
                                      : <Clock size={12} aria-hidden="true" />}
                                </span>
                                <span className="cron-exec__time">{new Date(exec.startedAt).toLocaleString()}</span>
                                <span className={`cron-exec__trigger cron-exec__trigger--${exec.trigger}`}>{exec.trigger}</span>
                                {exec.durationMs !== undefined && (
                                  <span className="cron-exec__dur">{Math.round(exec.durationMs / 1000)}s</span>
                                )}
                                {exec.exitCode !== undefined && (
                                  <span className="cron-exec__exit" style={{ color: exec.exitCode === 0 ? '#4ade80' : '#f87171' }}>
                                    exit {exec.exitCode}
                                  </span>
                                )}
                              </div>
                              {exec.error && (
                                <div className="cron-exec__error">{exec.error}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {serviceCronJobs.length > 0 && (
        <div className="cron-section">
          <div className="svc-detail__section-title">Service Config Jobs</div>
          {serviceCronJobs.map((j, i) => (
            <div key={i} className="svc-detail__field-grid" style={{ marginBottom: 10 }}>
              <div><div className="svc-detail__field-label">Name</div><div className="svc-detail__field-value">{j.name}</div></div>
              <div><div className="svc-detail__field-label">Schedule</div><div className="svc-detail__field-value svc-detail__field-value--mono">{j.schedule}</div></div>
              <div><div className="svc-detail__field-label">Action</div><div className="svc-detail__field-value">{j.action}</div></div>
              <div><div className="svc-detail__field-label">Enabled</div><div className="svc-detail__field-value">{j.enabled === false ? 'No' : 'Yes'}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
