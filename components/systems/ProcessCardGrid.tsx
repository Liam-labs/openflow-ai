'use client';

import React, { useCallback, useState } from 'react';
import { RotateCcw, Square, Play, AlertTriangle, Bot, Film, Workflow, Activity, Network, Database, LayoutDashboard, Server, type LucideIcon } from 'lucide-react';

interface PM2Process {
  name: string;
  pm_id: number;
  status: string;
  monit?: { cpu: number; memory: number };
  pm2_env?: { pm_uptime?: number; restart_time?: number };
  port?: number;
  category?: string;
}

interface ProcessCardGridProps {
  processes: PM2Process[];
  onAction: (name: string, action: 'start' | 'stop' | 'restart') => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtUptime(pm_uptimeMs?: number): string {
  if (!pm_uptimeMs) return '—';
  const ms = Date.now() - pm_uptimeMs;
  if (ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function fmtMem(bytes: number): string {
  if (!bytes) return '0MB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// ─── Icon per process (lucide, so nothing depends on an icon font loading from the internet) ─────────

const ICONS: Record<string, LucideIcon> = {
  warning: AlertTriangle, smart_toy: Bot, video_library: Film, auto_mode: Workflow, monitoring: Activity,
  robot_2: Bot, hub: Network, database: Database, dashboard: LayoutDashboard, dns: Server,
};

function getIconName(proc: PM2Process): string {
  if (proc.status === 'errored') return 'warning';
  const name = proc.name.toLowerCase();
  const cat  = (proc.category ?? '').toLowerCase();
  if (cat === 'ai' || name.includes('claude') || name.includes('llm') || name.includes('ollama')) return 'smart_toy';
  if (cat === 'media' || name.includes('media') || name.includes('footage') || name.includes('veo')) return 'video_library';
  if (cat === 'automation' || name.includes('n8n') || name.includes('cron')) return 'auto_mode';
  if (cat === 'monitoring' || name.includes('monitor')) return 'monitoring';
  if (cat === 'agent' || name.includes('agent') || name.includes('sg-')) return 'robot_2';
  if (name.includes('tunnel') || name.includes('proxy') || name.includes('gateway')) return 'hub';
  if (name.includes('db') || name.includes('postgres') || name.includes('redis') || name.includes('supabase')) return 'database';
  if (name.includes('devflow') || name.includes('next')) return 'dashboard';
  if (name.includes('logrotate') || name.includes('pm2')) return 'dns';
  return 'dns';
}

// ─── Status config with border + badge background ──────────────────────────────

function getStatusConfig(status: string) {
  switch (status) {
    case 'online':
      return { dot: '#22c55e', border: '#22c55e', bg: 'rgba(34,197,94,0.08)', pulse: true };
    case 'errored':
      return { dot: '#ef4444', border: '#ef4444', bg: 'rgba(239,68,68,0.1)', pulse: false };
    case 'stopped':
    case 'stopping':
      return { dot: '#71717a', border: 'rgba(113,113,122,0.35)', bg: 'rgba(113,113,122,0.07)', pulse: false };
    default:
      return { dot: '#3b82f6', border: 'rgba(59,130,246,0.5)', bg: 'rgba(59,130,246,0.08)', pulse: false };
  }
}

// ─── Sparkline placeholder SVG ─────────────────────────────────────────────────

function SparklinePlaceholder({ cpu, color }: { cpu: number; color: string }) {
  const pts: string[] = [];
  for (let i = 0; i <= 10; i++) {
    const wave = Math.sin(cpu * 0.07 + i * 1.31) * 3.5 + Math.cos(cpu * 0.13 + i * 2.17) * 2.5;
    const base = Math.max(1, Math.min(17, (cpu / 100) * 13 + wave + 2));
    pts.push(`${i === 0 ? 'M' : 'L'}${i * 10} ${(19 - base).toFixed(1)}`);
  }
  return (
    <svg width="96" height="24" viewBox="0 0 100 20" fill="none" aria-hidden="true">
      <path
        d={pts.join(' ')}
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.7"
      />
    </svg>
  );
}

// ─── Process Card ──────────────────────────────────────────────────────────────

function ProcessCard({
  proc,
  onAction,
}: {
  proc: PM2Process;
  onAction: (name: string, action: 'start' | 'stop' | 'restart') => void;
}) {
  const [acting, setActing] = useState<string | null>(null);
  const cfg      = getStatusConfig(proc.status);
  const isActive  = proc.status === 'online';
  const isErrored = proc.status === 'errored';

  const cpu = proc.monit?.cpu ?? 0;
  const mem = proc.monit?.memory ?? 0;

  const act = useCallback(
    async (action: 'start' | 'stop' | 'restart') => {
      setActing(action);
      try { await onAction(proc.name, action); }
      finally { setActing(null); }
    },
    [proc.name, onAction],
  );

  return (
    <div
      className={`pcg-card${isActive ? ' pcg-card--online' : ''}${isErrored ? ' pcg-card--errored' : ''}`}
      style={{ borderLeft: `4px solid ${cfg.border}` }}
    >
      {/* ── Left: icon badge + name/meta ── */}
      <div className="pcg-card__left">
        <div className="pcg-icon-badge" style={{ background: cfg.bg }}>
          {(() => {
            const Icon = ICONS[getIconName(proc)] ?? Server;
            return <Icon size={20} style={{ color: cfg.dot }} aria-hidden="true" />;
          })()}
        </div>

        <div className="pcg-card__info">
          <h3 className="pcg-card__name" title={proc.name}>{proc.name}</h3>
          <div className="pcg-card__meta">
            <span
              className={`pcg-status-dot${cfg.pulse ? ' pcg-status-dot--pulse' : ''}`}
              style={{ background: cfg.dot }}
            />
            <span className="pcg-meta-text">
              {proc.pm_id !== undefined && `PID: ${proc.pm_id}`}
              {proc.pm_id !== undefined && proc.pm2_env?.pm_uptime ? ' · ' : ''}
              {proc.pm2_env?.pm_uptime ? fmtUptime(proc.pm2_env.pm_uptime) : ''}
              {!isActive && proc.pm_id === undefined && proc.status}
            </span>
          </div>
        </div>
      </div>

      {/* ── Right: sparkline + metrics, or action buttons ── */}
      <div className="pcg-card__right">
        {isErrored ? (
          <div className="pcg-error-actions">
            <button
              className="pcg-err-btn"
              onClick={() => act('restart')}
              disabled={acting !== null}
              title="Restart"
            >
              <RotateCcw size={12} className={acting === 'restart' ? 'pcg-spin' : ''} />
              RESTART
            </button>
          </div>
        ) : isActive ? (
          <div className="pcg-card__metrics-col">
            <div className="pcg-sparkline-wrap">
              <SparklinePlaceholder cpu={cpu} color={cfg.dot} />
            </div>
            <span className="pcg-metrics-text" style={{ color: cfg.dot }}>
              {cpu.toFixed(1)}% · {fmtMem(mem)}
            </span>
          </div>
        ) : (
          <button
            className="pcg-action-btn"
            title="Start"
            onClick={() => act('start')}
            disabled={acting !== null}
          >
            <Play size={13} />
          </button>
        )}

        {/* Hover-reveal actions for online services */}
        {isActive && (
          <div className="pcg-card__actions">
            <button
              className="pcg-action-btn"
              title="Restart"
              onClick={() => act('restart')}
              disabled={acting !== null}
            >
              <RotateCcw size={13} className={acting === 'restart' ? 'pcg-spin' : ''} />
            </button>
            <button
              className="pcg-action-btn"
              title="Stop"
              onClick={() => act('stop')}
              disabled={acting !== null}
            >
              <Square size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────

export function ProcessCardGrid({ processes, onAction }: ProcessCardGridProps) {
  if (processes.length === 0) {
    return <div className="pcg-empty">No services running</div>;
  }

  return (
    <div className="pcg-root">
      <div className="pcg-grid">
        {processes.map((p) => (
          <ProcessCard key={p.name} proc={p} onAction={onAction} />
        ))}
      </div>
    </div>
  );
}
