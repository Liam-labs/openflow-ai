'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { animate, motion } from 'framer-motion';
import {
  Server, Clock, Activity, RefreshCw, ChevronRight,
  Play, RotateCw, Terminal, Zap, CheckCircle,
} from 'lucide-react';
import type { SystemsNavState } from './systems-types';
import { useMetricsBuffer } from '@/lib/hooks/useMetricsBuffer';
import { useEventStream } from '@/lib/contexts/EventStreamContext';
import type { PM2Response } from '@/lib/types';
import { ServiceAlertsPanel } from './ServiceAlertsPanel';
import { SystemStatusHeader } from './SystemStatusHeader';
import { ProcessCardGrid } from './ProcessCardGrid';
import { BridgesStatusWidget } from './BridgesStatusWidget';
import { MemoryEventWidget } from './MemoryEventWidget';
import {
  ProcessHealthWidget,
  MemoryTopologyBar,
  RecentActivityTimeline,
  CoreLoadChart,
  type SidebarActivityItem,
} from './SidebarWidgets';
import {
  MetricsStripSkeleton,
  ChartPanelSkeleton,
  ActivityFeedSkeleton,
  SparklineStripSkeleton,
} from './OverviewPanelStates';
import { PRODUCT_NAME } from '@/lib/brand';

// ─── Lazy-loaded chart components (~400KB echarts bundle deferred) ─────────────

const MachineMemoryGauges = dynamic(
  () => import('./WslMemoryGauge').then(m => ({ default: m.MachineMemoryGauges })),
  { ssr: false, loading: () => <ChartPanelSkeleton height={240} /> }
);

const ServiceStatusDonut = dynamic(
  () => import('./ServiceStatusDonut').then(m => ({ default: m.ServiceStatusDonut })),
  { ssr: false, loading: () => <ChartPanelSkeleton height={240} /> }
);

const ServiceMemoryChart = dynamic(
  () => import('./ServiceMemoryChart').then(m => ({ default: m.ServiceMemoryChart })),
  { ssr: false, loading: () => <ChartPanelSkeleton height={240} /> }
);

// ReactECharts used by inline SparklineChart
const ReactECharts = dynamic(() => import('echarts-for-react'), {
  ssr: false,
  loading: () => <SparklineStripSkeleton count={1} />,
});

// ─── Types ─────────────────────────────────────────────────────────────────────

interface BuildInfo {
  buildId: string | null;
  buildTime: string | null;
  devflowUptimeSeconds: number | null;
  devflowRestartCount: number | null;
  devflowLastRestart: string | null;
  serverUptimeSeconds: number;
  serverUptimeFormatted: string;
  errors: string[];
}

interface AgentSession {
  name: string;
  model: string;
  channelName: string;
  channelId: string;
  status: string;
  pid: number | null;
  ptySessionId: string | null;
  lastStartedAt: string | null;
  uptimeSeconds: number | null;
}

interface AgentSessionsData {
  total_active: number;
  sessions: AgentSession[];
}

interface SystemsOverviewProps {
  onNavigate: (state: Partial<SystemsNavState>) => void;
}

export interface PM2Process {
  name: string;
  pm_id: number;
  status: string;
  monit?: { cpu: number; memory: number };
  pm2_env?: { pm_uptime?: number; restart_time?: number };
}

interface CronJobSummary {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
  lastRun?: string;
}

interface AITaskSummary {
  id: string;
  prompt: string;
  status: string;
  engine: string;
  createdAt: string;
}

interface OverviewData {
  processes: PM2Process[];
  cronJobs: CronJobSummary[];
  aiTasks: AITaskSummary[];
  portCount: number;
}

interface ActivityItem {
  id: string;
  kind: 'ai-task' | 'cron';
  title: string;
  meta: string;
  status: string;
  time: string;
  onClick: () => void;
}

interface CronStatusSSEPayload { jobs: CronJobSummary[]; }
interface TerminalStatusSSEPayload { tasks: AITaskSummary[]; }

// ─── Main Component ─────────────────────────────────────────────────────────────

interface SSEStatus {
  connected: number;
  maxConnections: number;
  bufferSize: number;
  maxBufferSize: number;
}

export function SystemsOverview({ onNavigate }: SystemsOverviewProps) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const sparkHistory = useRef<Map<string, number[]>>(new Map());
  const [sseStatus, setSseStatus] = useState<SSEStatus>({ connected: 0, maxConnections: 50, bufferSize: 0, maxBufferSize: 100 });

  // ── Build stats ─────────────────────────────────────────────────────────────
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const devflowTickRef = useRef<number>(0);
  const [devflowTick, setDevflowTick] = useState(0);

  // ── Agent sessions ──────────────────────────────────────────────────────────
  const [agentSessions, setAgentSessions] = useState<AgentSessionsData | null>(null);

  // ── SSE data layer ───────────────────────────────────────────────────────────
  // CPU/Memory rolling buffer — updated via pm2:status SSE (~5s interval)
  const { cpuMemorySeries } = useMetricsBuffer();

  // Live PM2 process list
  const { data: pm2SSE } = useEventStream<PM2Response>('pm2:status', {
    fallbackUrl: '/api/pm2',
    fallbackInterval: 15000,
    fallbackTransform: (r) => r as PM2Response,
  });

  // Live cron job list
  const { data: cronSSE } = useEventStream<CronStatusSSEPayload>('cron:status', {
    fallbackUrl: '/api/cron',
    fallbackInterval: 15000,
    fallbackTransform: (r) => r as CronStatusSSEPayload,
  });

  // Live AI task list
  const { data: terminalSSE } = useEventStream<TerminalStatusSSEPayload>('terminal:status', {
    fallbackUrl: '/api/terminal-tasks',
    fallbackInterval: 15000,
    fallbackTransform: (r) => r as TerminalStatusSSEPayload,
  });

  // Update processes + sparklines from pm2 SSE
  useEffect(() => {
    if (!pm2SSE?.processes) return;
    // Map lib/types PM2Process → local PM2Process shape (monit + pm2_env)
    const processes: PM2Process[] = pm2SSE.processes.map((p) => ({
      name: p.name,
      pm_id: p.pm_id,
      status: p.status,
      monit: { cpu: p.cpu ?? 0, memory: p.memory ?? 0 },
      pm2_env: { pm_uptime: Date.now() - (p.uptime ?? 0) },
    }));
    processes.forEach((p) => {
      const h = sparkHistory.current.get(p.name) ?? [];
      h.push(p.monit?.cpu ?? 0);
      if (h.length > 20) h.shift();
      sparkHistory.current.set(p.name, h);
    });
    setData((prev) => ({
      cronJobs: prev?.cronJobs ?? [],
      aiTasks: prev?.aiTasks ?? [],
      portCount: prev?.portCount ?? 0,
      processes,
    }));
    setLoading(false);
  }, [pm2SSE]);

  // Update cron jobs from SSE
  useEffect(() => {
    if (!cronSSE?.jobs) return;
    setData((prev) => ({
      processes: prev?.processes ?? [],
      aiTasks: prev?.aiTasks ?? [],
      portCount: prev?.portCount ?? 0,
      cronJobs: cronSSE.jobs,
    }));
    setLoading(false);
  }, [cronSSE]);

  // Update AI tasks from SSE
  useEffect(() => {
    if (!terminalSSE?.tasks) return;
    setData((prev) => ({
      processes: prev?.processes ?? [],
      cronJobs: prev?.cronJobs ?? [],
      portCount: prev?.portCount ?? 0,
      aiTasks: terminalSSE.tasks,
    }));
    setLoading(false);
  }, [terminalSSE]);

  // Fetch portCount once on mount — SSE handles the rest
  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/ports');
      const portsData = res.ok ? await res.json() : {};
      const portCount = portsData.ports?.length ?? portsData.registered?.length ?? 0;
      setData((prev) => ({
        processes: prev?.processes ?? [],
        cronJobs: prev?.cronJobs ?? [],
        aiTasks: prev?.aiTasks ?? [],
        portCount,
      }));
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => { fetch_(); }, [fetch_]);

  // Poll SSE health status every 30s
  useEffect(() => {
    const fetchSseStatus = async () => {
      try {
        const res = await fetch('/api/events?status=true');
        if (!res.ok) return;
        const d = await res.json();
        setSseStatus({
          connected: d.connected ?? 0,
          maxConnections: d.maxConnections ?? 50,
          bufferSize: d.bufferSize ?? 0,
          maxBufferSize: d.maxBufferSize ?? 100,
        });
      } catch {
        // non-fatal
      }
    };
    fetchSseStatus();
    const id = setInterval(fetchSseStatus, 30_000);
    return () => clearInterval(id);
  }, []);

  // Fetch build-info on mount, refresh every 60s
  useEffect(() => {
    const fetchBuildInfo = async () => {
      try {
        const res = await fetch('/api/system/build-info');
        if (!res.ok) return;
        const d: BuildInfo = await res.json();
        setBuildInfo(d);
        const secs = d.devflowUptimeSeconds ?? 0;
        devflowTickRef.current = secs;
        setDevflowTick(secs);
      } catch { /* non-fatal */ }
    };
    fetchBuildInfo();
    const id = setInterval(fetchBuildInfo, 60_000);
    return () => clearInterval(id);
  }, []);

  // Fetch agent sessions on mount, refresh every 30s
  useEffect(() => {
    const fetchAgentSessions = async () => {
      try {
        const res = await fetch('/api/system/agent-sessions');
        if (!res.ok) return;
        const d: AgentSessionsData = await res.json();
        setAgentSessions(d);
      } catch { /* non-fatal */ }
    };
    fetchAgentSessions();
    const id = setInterval(fetchAgentSessions, 30_000);
    return () => clearInterval(id);
  }, []);

  // 1s ticker for live DevFlow uptime display
  useEffect(() => {
    const id = setInterval(() => {
      devflowTickRef.current += 1;
      setDevflowTick(devflowTickRef.current);
    }, 1_000);
    return () => clearInterval(id);
  }, []);

  const handlePm2Action = useCallback(async (name: string, action: 'start' | 'stop' | 'restart') => {
    await fetch('/api/pm2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, target: name }),
    });
  }, []);

  if (loading) return <SystemsOverviewSkeleton />;

  const processes = data?.processes ?? [];
  const cronJobs = data?.cronJobs ?? [];
  const aiTasks = data?.aiTasks ?? [];

  const services = processes.filter((p) => !p.name.startsWith('dev-'));
  const devServersList = processes.filter((p) => p.name.startsWith('dev-') && p.status === 'online');
  const onlineServices = services.filter((p) => p.status === 'online').length;
  const erroredServices = services.filter((p) => p.status === 'errored').length;
  const totalServices = services.length;
  const devServers = devServersList.length;
  const activeJobs = cronJobs.filter((j) => j.enabled).length;
  const erroredJobs = cronJobs.filter((j) => j.status === 'error').length;
  const runningTasks = aiTasks.filter(
    (t) => t.status === 'running' || t.status === 'pending'
  ).length;

  // Unified activity feed
  const activityItems: ActivityItem[] = [
    ...aiTasks.slice(0, 8).map((t) => ({
      id: t.id,
      kind: 'ai-task' as const,
      title: truncate(t.prompt, 52),
      meta: t.engine,
      status: t.status,
      time: t.createdAt,
      onClick: () =>
        onNavigate({ section: 'ai-tasks', entityId: t.id, entityType: 'ai-task', tab: 'output' }),
    })),
    ...cronJobs
      .filter((j) => j.lastRun)
      .slice(0, 4)
      .map((j) => ({
        id: j.id,
        kind: 'cron' as const,
        title: j.name,
        meta: 'cron',
        status: !j.enabled ? 'stopped' : j.status === 'error' ? 'errored' : 'active',
        time: j.lastRun!,
        onClick: () =>
          onNavigate({
            section: 'scheduled-jobs',
            entityId: j.id,
            entityType: 'scheduled-job',
            tab: 'overview',
          }),
      })),
  ]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 8);

  void sparkHistory; // sparkline strip removed — card grid is the primary infra view

  return (
    <div className="sov-layout">
      {/* Row 0: Command Status Header */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1], delay: 0 }}
      >
        <SystemStatusHeader
          processes={processes}
          onRefresh={fetch_}
          sseConnections={sseStatus.connected}
          maxSseConnections={sseStatus.maxConnections}
          sseBuffer={sseStatus.bufferSize}
          maxSseBuffer={sseStatus.maxBufferSize}
        />
      </motion.div>

      {/* Alerts sit right under the header so a failing job is seen first (renders nothing when all is well) */}
      <ServiceAlertsPanel onNavigate={onNavigate} />

      {/* Row 1: build and uptime, one slim strip */}
      {buildInfo && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1], delay: 0.03 }}
        >
          <BuildStatsBar buildInfo={buildInfo} devflowTick={devflowTick} />
        </motion.div>
      )}

      {/* Row 2: services (wide) beside the agents list */}
      <motion.div
        className="sov-main-grid"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
      >
        <div className="sov-infrastructure">
          <ProcessCardGrid processes={services} onAction={handlePm2Action} />
          {devServersList.length > 0 && (
            <div className="pcg-dev-pill-row">
              {devServersList.map((p) => (
                <div key={p.name} className="pcg-dev-pill">
                  <span className="pcg-dev-dot" />
                  {p.name}
                  {p.pm2_env?.pm_uptime && (
                    <span style={{ color: 'rgba(147,197,253,0.5)', marginLeft: 2 }}>
                      · {formatRelative(new Date(p.pm2_env.pm_uptime).toISOString())}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {agentSessions && <AgentSessionsWidget data={agentSessions} />}
      </motion.div>

      {/* Row 3: memory on both machines */}
      <motion.div
        className="sov-machine-row"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1], delay: 0.07 }}
      >
        <MachineMemoryGauges />
      </motion.div>

      {/* Row 4: health and capacity tiles */}
      <motion.div
        className="sov-tiles-row"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1], delay: 0.08 }}
      >
        <div className="sov-intel-group">
          <div className="sov-intel-group__header">
            <span className="sov-intel-group__header-dot" />
            System Health
          </div>
          <div className="sov-intel-split sov-intel-split--stack">
            <ProcessHealthWidget onNavigate={onNavigate} />
            <CoreLoadChart processes={processes} />
          </div>
        </div>
        <ServiceStatusDonut
          online={onlineServices}
          stopped={totalServices - onlineServices - erroredServices}
          errored={erroredServices}
          total={totalServices}
          onNavigate={onNavigate}
        />
        <ServiceMemoryChart processes={processes} />
      </motion.div>

      {/* Row 5: activity, infrastructure and alerts */}
      <motion.div
        className="sov-bottom-row"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1], delay: 0.10 }}
      >
        <div className="sov-intel-group">
          <div className="sov-intel-group__header">
            <span className="sov-intel-group__header-dot" />
            Activity
          </div>
          <RecentActivityTimeline items={activityItems as SidebarActivityItem[]} />
          <MemoryTopologyBar processes={processes} />
        </div>

        <div className="sov-intel-group">
          <div className="sov-intel-group__header">
            <span className="sov-intel-group__header-dot" />
            Infrastructure
          </div>
          <BridgesStatusWidget onNavigate={onNavigate} />
          <MemoryEventWidget onNavigate={onNavigate} />
        </div>

      </motion.div>
    </div>
  );
}

// ─── Metrics Strip ─────────────────────────────────────────────────────────────

const DOT_OK = '#22c55e';
const DOT_ERR = '#ef4444';
const DOT_INFO = '#3b82f6';
const DOT_MUTED = 'rgba(255,255,255,0.22)';
const DOT_WARN = '#eab308';

function MetricsStrip({
  onlineServices, totalServices, erroredServices,
  devServers, activeJobs, erroredJobs,
  runningTasks, totalAiTasks, portCount, onRefresh,
}: {
  onlineServices: number; totalServices: number; erroredServices: number;
  devServers: number; activeJobs: number; erroredJobs: number;
  runningTasks: number; totalAiTasks: number; portCount: number;
  onRefresh: () => void;
}) {
  return (
    <div className="sov-metrics-strip">
      <MetricItem
        dot={erroredServices > 0 ? DOT_ERR : DOT_OK}
        value={onlineServices}
        suffix={`/${totalServices}`}
        label="Services"
        badge={erroredServices > 0 ? erroredServices : undefined}
      />
      <div className="sov-metrics-sep" />
      <MetricItem
        dot={devServers > 0 ? DOT_INFO : DOT_MUTED}
        value={devServers}
        label="Dev Servers"
      />
      <div className="sov-metrics-sep" />
      <MetricItem
        dot={erroredJobs > 0 ? DOT_ERR : activeJobs > 0 ? DOT_OK : DOT_MUTED}
        value={activeJobs}
        label="Jobs"
        badge={erroredJobs > 0 ? erroredJobs : undefined}
      />
      <div className="sov-metrics-sep" />
      <MetricItem
        dot={runningTasks > 0 ? DOT_INFO : totalAiTasks > 0 ? DOT_MUTED : DOT_MUTED}
        value={runningTasks > 0 ? runningTasks : totalAiTasks}
        label={runningTasks > 0 ? 'AI Running' : 'AI Tasks'}
      />
      <div className="sov-metrics-sep" />
      <MetricItem
        dot={portCount > 0 ? DOT_MUTED : DOT_WARN}
        value={portCount}
        label="Ports"
      />
      <div style={{ flex: 1 }} />
      <button className="sov-refresh-btn" onClick={onRefresh} title="Refresh overview">
        <RefreshCw size={12} />
      </button>
    </div>
  );
}

function MetricItem({
  dot, value, suffix, label, badge,
}: {
  dot: string; value: number; suffix?: string; label: string; badge?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const from = prev.current;
    prev.current = value;
    if (from === value) return;
    const ctrl = animate(from, value, {
      duration: 0.55,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => { node.textContent = Math.round(v).toString(); },
    });
    return () => ctrl.stop();
  }, [value]);

  return (
    <div className="sov-metric-item">
      <span className="sov-metric-dot" style={{ background: dot }} />
      <span className="sov-metric-value">
        <span ref={ref}>{value}</span>
        {suffix && <span className="sov-metric-suffix">{suffix}</span>}
      </span>
      <span className="sov-metric-label">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="sov-metric-badge">{badge}</span>
      )}
    </div>
  );
}

// ─── Activity Row ───────────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  online: DOT_OK, active: DOT_OK, running: DOT_INFO, launching: DOT_INFO,
  pending: DOT_INFO, errored: DOT_ERR, error: DOT_ERR,
  stopped: DOT_MUTED, cancelled: DOT_MUTED, completed: DOT_OK,
  timeout: DOT_WARN, failed: DOT_ERR,
};

function ActivityRow({ item, index = 0 }: { item: ActivityItem; index?: number }) {
  const dot = STATUS_DOT[item.status] ?? DOT_MUTED;
  const Icon = item.kind === 'cron' ? Clock : Terminal;
  return (
    <motion.button
      className="sov-activity-row"
      onClick={item.onClick}
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut', delay: 0.12 + index * 0.04 }}
    >
      <span className="sov-activity-dot" style={{ background: dot }} />
      <span className="sov-activity-kind-icon">
        <Icon size={11} />
      </span>
      <div className="sov-activity-text">
        <span className="sov-activity-title">{item.title}</span>
        <span className="sov-activity-meta">
          {item.meta} · {formatRelative(item.time)}
        </span>
      </div>
      <ChevronRight size={11} className="sov-activity-arrow" />
    </motion.button>
  );
}

// ─── Quick Actions Panel ────────────────────────────────────────────────────────

function QuickActionsPanel({
  onNavigate, cronJobs, erroredProcs,
}: {
  onNavigate: (state: Partial<SystemsNavState>) => void;
  cronJobs: CronJobSummary[];
  erroredProcs: PM2Process[];
}) {
  const [restarting, setRestarting] = useState<string | null>(null);

  const restart = useCallback(async (name: string) => {
    setRestarting(name);
    try {
      await fetch('/api/pm2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart', name }),
      });
    } finally {
      setRestarting(null);
    }
  }, []);

  const triggerJob = useCallback(async (id: string) => {
    await fetch('/api/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'trigger', jobId: id }),
    });
  }, []);

  // Show first enabled cron job as a trigger action
  const triggerableJob = cronJobs.find((j) => j.enabled);

  return (
    <div className="sov-panel">
      <div className="sov-panel__header">
        <span className="sov-panel__title">
          <Zap size={14} />
          Quick Actions
        </span>
      </div>
      <div className="sov-panel__body sov-qa-body">
        <button
          className="sov-qa-btn"
          onClick={() => restart('devflow')}
          disabled={restarting === 'devflow'}
        >
          <RotateCw size={13} className={restarting === 'devflow' ? 'sov-spin' : ''} />
          Restart {PRODUCT_NAME}
        </button>

        {erroredProcs.slice(0, 2).map((p) => (
          <button
            key={p.name}
            className="sov-qa-btn sov-qa-btn--warn"
            onClick={() => restart(p.name)}
            disabled={restarting === p.name}
          >
            <RotateCw size={13} className={restarting === p.name ? 'sov-spin' : ''} />
            Restart {truncate(p.name, 24)}
          </button>
        ))}

        {triggerableJob && (
          <button
            className="sov-qa-btn"
            onClick={() => triggerJob(triggerableJob.id)}
          >
            <Play size={13} />
            Trigger {truncate(triggerableJob.name, 22)}
          </button>
        )}

        <button
          className="sov-qa-btn sov-qa-btn--primary"
          onClick={() => onNavigate({ section: 'ai-tasks' })}
        >
          <Terminal size={13} />
          Submit AI Task
        </button>

        <button
          className="sov-qa-btn"
          onClick={() => onNavigate({ section: 'services' })}
        >
          <Server size={13} />
          All Services
        </button>
      </div>
    </div>
  );
}

// ─── Sparkline Strip ────────────────────────────────────────────────────────────

function SparklineStrip({
  services, sparkHistory, onNavigate,
}: {
  services: PM2Process[];
  sparkHistory: Map<string, number[]>;
  onNavigate: (state: Partial<SystemsNavState>) => void;
}) {
  return (
    <div className="sov-sparkline-strip">
      {services.map((svc) => {
        const history = sparkHistory.get(svc.name) ?? [0];
        const cpu = svc.monit?.cpu ?? 0;
        return (
          <button
            key={svc.name}
            className="sov-sparkline-card"
            onClick={() =>
              onNavigate({ section: 'services', entityId: svc.name, entityType: 'service', tab: 'overview' })
            }
          >
            <div className="sov-sparkline-top">
              <span className="sov-sparkline-name">{svc.name}</span>
              <span className="sov-sparkline-cpu">{cpu.toFixed(1)}%</span>
            </div>
            <SparklineChart data={history} />
          </button>
        );
      })}
    </div>
  );
}

function SparklineChart({ data }: { data: number[] }) {
  const option = {
    animation: false,
    grid: { top: 2, right: 0, bottom: 2, left: 0 },
    xAxis: { type: 'category' as const, show: false, data: data.map((_, i) => i) },
    yAxis: { type: 'value' as const, show: false, min: 0 },
    series: [
      {
        type: 'line' as const,
        data,
        smooth: 0.5,
        symbol: 'none',
        lineStyle: {
          color: '#3b82f6',
          width: 1.5,
          shadowBlur: 6,
          shadowColor: 'rgba(59,130,246,0.6)',
        },
        areaStyle: {
          color: {
            type: 'linear' as const,
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(59,130,246,0.42)' },
              { offset: 1, color: 'rgba(59,130,246,0.03)' },
            ],
          },
        },
      },
    ],
  };
  return (
    <ReactECharts
      option={option}
      style={{ height: '90px', width: '100%' }}
      opts={{ renderer: 'canvas' }}
    />
  );
}

// ─── Skeleton ───────────────────────────────────────────────────────────────────

function SystemsOverviewSkeleton() {
  return (
    <div className="sov-layout">
      {/* Row 0: Metrics strip */}
      <MetricsStripSkeleton count={5} />

      {/* Row 1: Chart panels */}
      <div className="sov-charts-row">
        <ChartPanelSkeleton height={200} showLegend />
        <ChartPanelSkeleton height={200} />
        <ChartPanelSkeleton height={200} />
      </div>

      {/* Row 2: Ops panels */}
      <div className="sov-ops-row">
        <div className="sov-panel">
          <div className="sov-panel__header">
            <div className="ops-shimmer" style={{ width: 100, height: 12, borderRadius: 4 }} />
          </div>
          <div className="sov-panel__body">
            <ActivityFeedSkeleton rows={6} />
          </div>
        </div>
        <div className="sov-skeleton-panel" />
        <div className="sov-skeleton-panel" />
      </div>

      {/* Row 3: Sparkline strip */}
      <SparklineStripSkeleton count={6} />
    </div>
  );
}

// ─── Agent Sessions Widget ──────────────────────────────────────────────────────

const MODEL_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  opus:           { bg: 'rgba(168,85,247,0.18)', text: '#c084fc', label: 'Opus' },
  'claude-opus':  { bg: 'rgba(168,85,247,0.18)', text: '#c084fc', label: 'Opus' },
  sonnet:         { bg: 'rgba(59,130,246,0.18)',  text: '#93c5fd', label: 'Sonnet' },
  'claude-sonnet':{ bg: 'rgba(59,130,246,0.18)',  text: '#93c5fd', label: 'Sonnet' },
  haiku:          { bg: 'rgba(34,197,94,0.18)',   text: '#86efac', label: 'Haiku' },
  'claude-haiku': { bg: 'rgba(34,197,94,0.18)',   text: '#86efac', label: 'Haiku' },
  deepseek:       { bg: 'rgba(249,115,22,0.18)',  text: '#fdba74', label: 'DeepSeek' },
};

function getModelBadge(model: string): { bg: string; text: string; label: string } {
  const lower = model.toLowerCase();
  for (const [key, val] of Object.entries(MODEL_COLORS)) {
    if (lower.includes(key)) return val;
  }
  return { bg: 'rgba(148,163,184,0.15)', text: '#cbd5e1', label: model };
}

function formatSessionUptime(seconds: number | null): string {
  if (seconds === null) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

function AgentSessionsWidget({ data }: { data: AgentSessionsData }) {
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());

  const toggleChannel = (chName: string) => {
    setExpandedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(chName)) next.delete(chName);
      else next.add(chName);
      return next;
    });
  };

  // Group by channel, count per channel
  const byChannel = new Map<string, AgentSession[]>();
  for (const s of data.sessions) {
    const list = byChannel.get(s.channelName) ?? [];
    list.push(s);
    byChannel.set(s.channelName, list);
  }

  const channelEntries = Array.from(byChannel.entries());

  return (
    <div className="asw-strip">
      <div className="asw-header">
        <span className="asw-title">
          <span className="asw-dot" />
          Active Agents
        </span>
        <span className="asw-count">{data.total_active}</span>
      </div>
      <div className="asw-channels">
        {channelEntries.map(([chName, sessions]) => {
          const isOpen = expandedChannels.has(chName);
          const opusCount = sessions.filter((s) => s.model.toLowerCase().includes('opus')).length;
          const sonnetCount = sessions.filter((s) => s.model.toLowerCase().includes('sonnet')).length;
          const haikuCount = sessions.filter((s) => s.model.toLowerCase().includes('haiku')).length;
          return (
            <div key={chName} className="asw-channel-group">
              <button className="asw-channel-name" onClick={() => toggleChannel(chName)} title={chName}>
                <span className={`asw-chevron${isOpen ? ' asw-chevron--open' : ''}`}>▸</span>
                <span className="asw-channel-label">{chName}</span>
                <span className="asw-channel-agent-count">{sessions.length}</span>
                <span className="asw-channel-model-tags">
                  {opusCount > 0 && <span className="asw-model-tag asw-model-tag--opus">O{opusCount}</span>}
                  {sonnetCount > 0 && <span className="asw-model-tag asw-model-tag--sonnet">S{sonnetCount}</span>}
                  {haikuCount > 0 && <span className="asw-model-tag asw-model-tag--haiku">H{haikuCount}</span>}
                </span>
              </button>
              {isOpen && (
                <div className="asw-agents">
                  {sessions.map((s) => {
                    const badge = getModelBadge(s.model);
                    return (
                      <div key={s.name} className="asw-agent" title={`${s.name} · ${s.model} · PID ${s.pid ?? '?'}`}>
                        <span className="asw-agent-name">{s.name}</span>
                        <span
                          className="asw-agent-model"
                          style={{ background: badge.bg, color: badge.text }}
                        >
                          {badge.label}
                        </span>
                        <span className="asw-agent-uptime">{formatSessionUptime(s.uptimeSeconds)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Build Stats Bar ─────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return d > 0
    ? `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}`
    : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function BuildStatsBar({ buildInfo, devflowTick }: { buildInfo: BuildInfo; devflowTick: number }) {
  const buildId = buildInfo.buildId ? buildInfo.buildId.slice(0, 8) : '—';
  const lastBuild = buildInfo.buildTime ? formatRelative(buildInfo.buildTime) : '—';
  const dfUptime = formatDuration(devflowTick);
  const restartCount = buildInfo.devflowRestartCount ?? '—';
  const lastRestart = buildInfo.devflowLastRestart ? formatRelative(buildInfo.devflowLastRestart) : '—';
  const serverUp = buildInfo.serverUptimeFormatted ?? formatDuration(buildInfo.serverUptimeSeconds);

  return (
    <div className="bsb-strip">
      <div className="bsb-item">
        <span className="bsb-label">Build ID</span>
        <span className="bsb-value bsb-value--mono">{buildId}</span>
      </div>
      <div className="bsb-sep" />
      <div className="bsb-item">
        <span className="bsb-label">Last Rebuild</span>
        <span className="bsb-value">{lastBuild}</span>
      </div>
      <div className="bsb-sep" />
      <div className="bsb-item">
        <span className="bsb-label">{PRODUCT_NAME} Uptime</span>
        <span className="bsb-value bsb-value--mono bsb-value--ticker">{dfUptime}</span>
      </div>
      <div className="bsb-sep" />
      <div className="bsb-item">
        <span className="bsb-label">Restarts</span>
        <span className="bsb-value bsb-value--mono" style={typeof restartCount === 'number' && restartCount > 0 ? { color: '#fbbf24' } : undefined}>{restartCount}</span>
      </div>
      <div className="bsb-sep" />
      <div className="bsb-item">
        <span className="bsb-label">Last Restart</span>
        <span className="bsb-value">{lastRestart}</span>
      </div>
      <div className="bsb-sep" />
      <div className="bsb-item">
        <span className="bsb-label">Server Up</span>
        <span className="bsb-value bsb-value--mono">{serverUp}</span>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function EmptyState({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div className="sov-empty">
      <span className="sov-empty__icon">{icon}</span>
      <span className="sov-empty__text">{message}</span>
    </div>
  );
}

function truncate(str: string, max: number) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const abs = Math.abs(diff);
    const future = diff < 0;
    if (abs < 60_000) return future ? 'in <1m' : '<1m ago';
    if (abs < 3_600_000) return `${future ? 'in ' : ''}${Math.round(abs / 60_000)}m${future ? '' : ' ago'}`;
    if (abs < 86_400_000) return `${future ? 'in ' : ''}${Math.round(abs / 3_600_000)}h${future ? '' : ' ago'}`;
    return `${future ? 'in ' : ''}${Math.round(abs / 86_400_000)}d${future ? '' : ' ago'}`;
  } catch { return ''; }
}
