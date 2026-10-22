'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { BarChart3, ChevronRight, Clock, Terminal } from 'lucide-react';
import type { SystemsNavState } from './systems-types';

// ─── Shared types ──────────────────────────────────────────────────────────────

interface PM2ProcessSlim {
  name: string;
  status: string;
  category?: string;
  monit?: { cpu: number; memory: number };
}

export interface SidebarActivityItem {
  id: string;
  kind: 'ai-task' | 'cron';
  title: string;
  meta: string;
  status: string;
  time: string;
  onClick: () => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const abs = Math.abs(diff);
    if (abs < 60_000) return '<1m ago';
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`;
    return `${Math.round(abs / 86_400_000)}d ago`;
  } catch { return ''; }
}

const STATUS_DOT_COLOR: Record<string, string> = {
  online: '#22c55e', active: '#22c55e', running: '#3b82f6', launching: '#3b82f6',
  pending: '#3b82f6', errored: '#ef4444', error: '#ef4444',
  stopped: '#71717a', cancelled: '#71717a', completed: '#22c55e',
  timeout: '#eab308', failed: '#ef4444',
};

// ─── 1. Process Health Widget ──────────────────────────────────────────────────

interface ProcessSummary {
  totalProcesses: number;
  totalThreads:   number;
  zombies:        number;
  orphans:        number;
  forkErrors1hr:  number;
  processLimit:   number;
  status:         string;
}

interface ProcessHealthWidgetProps {
  onNavigate: (state: Partial<SystemsNavState>) => void;
}

export function ProcessHealthWidget({ onNavigate }: ProcessHealthWidgetProps) {
  const [summary, setSummary] = useState<ProcessSummary | null>(null);
  const [loading, setLoading]  = useState(true);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/process-health');
      if (!res.ok) return;
      const data = await res.json();
      if (data.summary) setSummary(data.summary as ProcessSummary);
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => clearInterval(id);
  }, [fetch_]);

  // Uptime: approximate from process uptime
  const uptimeDisplay = summary
    ? (() => {
        const limit = summary.processLimit;
        const ratio = limit > 0 ? summary.totalProcesses / limit : 0;
        if (ratio > 0.9) return <span style={{ color: '#ef4444' }}>{summary.totalProcesses}/{limit}</span>;
        return <span>{summary.totalProcesses.toLocaleString()}/{limit.toLocaleString()}</span>;
      })()
    : '—';

  const cells = summary
    ? [
        { label: 'Procs',   value: summary.totalProcesses.toLocaleString(), color: summary.totalProcesses > 600 ? '#ef4444' : '#e5e7f6' },
        { label: 'Threads', value: summary.totalThreads.toLocaleString(),   color: summary.totalThreads > 3000 ? '#eab308' : '#e5e7f6' },
        { label: 'Zombies', value: String(summary.zombies),                 color: summary.zombies > 0 ? '#ef4444' : '#e5e7f6' },
        { label: 'Uptime',  value: uptimeDisplay,                           color: '#69f6b8' },
      ]
    : null;

  return (
    <div className="sw-widget">
      <div className="sw-widget__header">
        <span className="sw-widget__title">Process Health</span>
        <BarChart3 className="sw-widget__icon" size={18} aria-hidden="true" />
      </div>

      {loading ? (
        <div className="sw-stat-grid">
          {[1, 2, 3, 4].map(i => <div key={i} className="sw-stat-cell sw-stat-cell--skel" />)}
        </div>
      ) : cells ? (
        <>
          <div className="sw-stat-grid">
            {cells.map((c) => (
              <div key={c.label} className="sw-stat-cell">
                <span className="sw-stat-label">{c.label}</span>
                <span className="sw-stat-value" style={{ color: c.color }}>{c.value}</span>
              </div>
            ))}
          </div>
          <button className="sw-widget__footer" onClick={() => onNavigate({ section: 'process-health' })}>
            Details <ChevronRight size={11} />
          </button>
        </>
      ) : (
        <div className="sw-empty">API unavailable</div>
      )}
    </div>
  );
}

// ─── 2. Memory Topology Bar ───────────────────────────────────────────────────

interface MemoryTopologyBarProps {
  processes: PM2ProcessSlim[];
}

const CATEGORY_COLOR: Record<string, string> = {
  ai:             '#69f6b8',
  agent:          '#69f6b8',
  development:    '#85adff',
  infrastructure: '#85adff',
  automation:     '#eab308',
  monitoring:     '#eab308',
  media:          '#f97316',
  default:        '#71717a',
};

function catColor(cat?: string): string {
  return CATEGORY_COLOR[cat ?? 'default'] ?? CATEGORY_COLOR.default;
}

export function MemoryTopologyBar({ processes }: MemoryTopologyBarProps) {
  const online = processes.filter(p => p.status === 'online' && p.monit?.memory);

  // Group by category
  type Segment = { label: string; bytes: number; color: string };
  const grouped: Record<string, Segment> = {};
  for (const p of online) {
    const cat = p.category ?? 'default';
    const bytes = p.monit?.memory ?? 0;
    if (!grouped[cat]) grouped[cat] = { label: cat, bytes: 0, color: catColor(cat) };
    grouped[cat].bytes += bytes;
  }

  const segments = Object.values(grouped).sort((a, b) => b.bytes - a.bytes);
  const totalBytes = segments.reduce((s, seg) => s + seg.bytes, 0);

  const fmtBytes = (b: number) => {
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(0)}MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  };

  if (totalBytes === 0) {
    return (
      <div className="sw-widget">
        <div className="sw-widget__header">
          <span className="sw-widget__title">Memory Topology</span>
          <span className="sw-widget__sub">PM2 SERVICES</span>
        </div>
        <div className="sw-empty">No memory data</div>
      </div>
    );
  }

  return (
    <div className="sw-widget">
      <div className="sw-widget__header">
        <span className="sw-widget__title">Memory Topology</span>
        <span className="sw-widget__sub">{fmtBytes(totalBytes)} TOTAL</span>
      </div>

      {/* Segmented bar */}
      <div className="sw-mem-bar">
        {segments.map((seg) => (
          <div
            key={seg.label}
            className="sw-mem-segment"
            style={{
              width: `${((seg.bytes / totalBytes) * 100).toFixed(1)}%`,
              background: seg.color,
            }}
            title={`${seg.label}: ${fmtBytes(seg.bytes)}`}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="sw-mem-legend">
        {segments.map((seg) => (
          <div key={seg.label} className="sw-mem-legend-row">
            <div className="sw-mem-legend-dot" style={{ background: seg.color }} />
            <span className="sw-mem-legend-label">{seg.label}</span>
            <span className="sw-mem-legend-value">{fmtBytes(seg.bytes)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 3. Recent Activity Timeline ──────────────────────────────────────────────

interface RecentActivityTimelineProps {
  items: SidebarActivityItem[];
}

export function RecentActivityTimeline({ items }: RecentActivityTimelineProps) {
  const display = items.slice(0, 5);

  return (
    <div className="sw-widget">
      <div className="sw-widget__header">
        <span className="sw-widget__title">Recent Activity</span>
      </div>

      {display.length === 0 ? (
        <div className="sw-empty">No recent activity</div>
      ) : (
        <div className="sw-timeline">
          <div className="sw-timeline__line" />
          {display.map((item, i) => {
            const dot  = STATUS_DOT_COLOR[item.status] ?? '#71717a';
            const Icon = item.kind === 'cron' ? Clock : Terminal;
            return (
              <button
                key={item.id}
                className="sw-timeline__item"
                onClick={item.onClick}
                style={{ opacity: i >= 4 ? 0.5 : 1 }}
              >
                <div
                  className="sw-timeline__dot"
                  style={{ background: dot, boxShadow: `0 0 0 3px rgba(10,14,24,1)` }}
                />
                <div className="sw-timeline__body">
                  <span className="sw-timeline__kind">
                    <Icon size={10} />
                  </span>
                  <div className="sw-timeline__text">
                    <span className="sw-timeline__title">{item.title}</span>
                    <span className="sw-timeline__meta" style={{ color: dot }}>
                      {item.meta} · {fmtRelative(item.time)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 4. Core Load Mini Bar Chart ──────────────────────────────────────────────

interface CoreLoadChartProps {
  processes: PM2ProcessSlim[];
}

export function CoreLoadChart({ processes }: CoreLoadChartProps) {
  const online = processes
    .filter(p => p.status === 'online' && (p.monit?.cpu ?? 0) > 0)
    .sort((a, b) => (b.monit?.cpu ?? 0) - (a.monit?.cpu ?? 0))
    .slice(0, 9);

  const avgCpu = online.length > 0
    ? online.reduce((s, p) => s + (p.monit?.cpu ?? 0), 0) / online.length
    : 0;

  const maxCpu = online.length > 0
    ? Math.max(...online.map(p => p.monit?.cpu ?? 0), 1)
    : 1;

  // If fewer than 9 online processes, pad with zeros
  const bars: number[] = [
    ...online.map(p => p.monit?.cpu ?? 0),
    ...Array(Math.max(0, 9 - online.length)).fill(0),
  ];

  const barColor = (pct: number) => {
    if (pct > 80) return '#ef4444';
    if (pct > 40) return '#eab308';
    return '#69f6b8';
  };

  return (
    <div className="sw-widget">
      <div className="sw-widget__header">
        <span className="sw-widget__title">Core Load</span>
        <span className="sw-widget__sub">{avgCpu.toFixed(0)}% AVG</span>
      </div>

      <div className="sw-core-bars">
        {bars.map((cpu, i) => {
          const pct = maxCpu > 0 ? (cpu / maxCpu) * 100 : 0;
          return (
            <div
              key={i}
              className="sw-core-bar"
              title={online[i] ? `${online[i].name}: ${cpu.toFixed(1)}%` : ''}
            >
              <div
                className="sw-core-bar__fill"
                style={{
                  height: `${Math.max(2, pct)}%`,
                  background: barColor(cpu),
                  opacity: cpu === 0 ? 0.15 : 0.7 + (pct / 100) * 0.3,
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
