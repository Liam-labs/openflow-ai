'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import './AgentActivityDashboard.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type TimeRange = '1h' | '6h' | '24h' | '7d';
type AgentStatus = 'online' | 'idle' | 'offline';

interface Agent {
  name: string;
  role: string;
  status: AgentStatus;
  task: string | null;
  completed: number;
  activity: number[]; // 24 hourly bars, 0-10
}

interface ActivityEvent {
  time: string;
  agent: string;
  action: 'completed' | 'claimed' | 'updated' | 'blocked' | 'started';
  target: string;
}

interface Phase {
  name: string;
  label: string;
  pct: number;
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

const AGENTS: Agent[] = [
  {
    name: 'Ada', role: 'Backend Dev', status: 'online',
    task: 'T5: Auth middleware refactor',
    completed: 15,
    activity: [1,0,2,1,0,3,2,4,6,8,9,7,5,8,10,9,7,6,8,9,7,5,4,3],
  },
  {
    name: 'Daniel', role: 'Frontend Dev', status: 'online',
    task: 'T7: Agent Activity Dashboard',
    completed: 8,
    activity: [0,0,1,0,2,1,3,5,4,7,8,6,9,7,8,10,8,7,6,5,4,3,2,1],
  },
  {
    name: 'Grace', role: 'QA / Research', status: 'online',
    task: 'T2: Frontend spec validation',
    completed: 9,
    activity: [0,1,0,2,1,2,3,4,5,6,7,8,7,6,5,8,9,8,7,6,5,4,3,2],
  },
  {
    name: 'Worf', role: 'Security', status: 'online',
    task: 'T4: Security audit — RLS policies',
    completed: 12,
    activity: [2,1,3,2,1,4,3,5,7,9,8,6,7,9,10,8,6,5,7,8,6,4,3,2],
  },
  {
    name: 'Teyla', role: 'Integration', status: 'idle',
    task: null,
    completed: 6,
    activity: [0,0,0,1,0,1,2,3,4,5,4,3,2,3,4,5,4,3,2,1,0,0,0,0],
  },
];

const EVENTS: ActivityEvent[] = [
  { time: '14:23', agent: 'Ada',    action: 'completed', target: 'T5: API validation endpoint' },
  { time: '14:18', agent: 'Worf',     action: 'claimed',   target: 'T4: Security audit — RLS policies' },
  { time: '14:15', agent: 'Grace', action: 'completed', target: 'T2: Research spec — System 1' },
  { time: '14:09', agent: 'Daniel',   action: 'started',   target: 'T7: Agent Activity Dashboard' },
  { time: '14:01', agent: 'Ada',    action: 'completed', target: 'T5: Auth middleware — token refresh' },
  { time: '13:54', agent: 'Teyla',    action: 'updated',   target: 'T6: Integration test matrix' },
  { time: '13:48', agent: 'Worf',     action: 'completed', target: 'T3: Penetration test report' },
  { time: '13:40', agent: 'Grace', action: 'claimed',   target: 'T2: Frontend spec validation' },
  { time: '13:35', agent: 'Ada',    action: 'blocked',   target: 'T5: DB migration — awaiting schema' },
  { time: '13:28', agent: 'Daniel',   action: 'completed', target: 'T1: SupabaseSection polish' },
];

const PHASES: Phase[] = [
  { name: 'Phase 1', label: 'Foundation',  pct: 100 },
  { name: 'Phase 2', label: 'Core Build',  pct: 60  },
  { name: 'Phase 3', label: 'Polish',      pct: 0   },
];

const SPARKLINE_DATA = [4,6,5,8,7,10,9,12,11,15,13,18,16,20,18,22,19,24,21,26,23,25,24,27,25,28,26,30];

const STATUS_COLORS: Record<AgentStatus, string> = {
  online:  'var(--cc-success)',
  idle:    'var(--cc-warning)',
  offline: 'var(--cc-text-muted)',
};

const ACTION_COLORS: Record<ActivityEvent['action'], string> = {
  completed: 'var(--cc-success)',
  claimed:   'var(--cc-accent)',
  started:   'var(--cc-info)',
  updated:   'var(--cc-text-secondary)',
  blocked:   'var(--cc-error)',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function Sparkline({ data, width = 120, height = 36 }: { data: number[]; width?: number; height?: number }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pad = 2;
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / range) * (height - pad * 2);
    return `${x},${y}`;
  });
  const fill = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / range) * (height - pad * 2);
    return `${x},${y}`;
  });

  return (
    <svg width={width} height={height} className="aad-sparkline" aria-hidden="true">
      <defs>
        <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(34,211,238,0.3)" />
          <stop offset="100%" stopColor="rgba(34,211,238,0)" />
        </linearGradient>
      </defs>
      <path
        d={`M${fill.join(' L')} L${width - pad},${height} L${pad},${height} Z`}
        fill="url(#spark-grad)"
      />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="#22d3ee"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MiniBarChart({ data }: { data: number[] }) {
  const max = Math.max(...data) || 1;
  const W = 96, H = 24;
  const barW = W / data.length - 1;
  return (
    <svg width={W} height={H} className="aad-mini-bars" aria-hidden="true">
      {data.map((v, i) => {
        const h = Math.max(2, (v / max) * H);
        return (
          <rect
            key={i}
            x={i * (barW + 1)}
            y={H - h}
            width={barW}
            height={h}
            rx={1}
            fill={v > 6 ? 'rgba(34,211,238,0.7)' : v > 3 ? 'rgba(34,211,238,0.35)' : 'rgba(255,255,255,0.08)'}
          />
        );
      })}
    </svg>
  );
}

function AgentCard({ agent, delay }: { agent: Agent; delay: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <button
      className={`aad-agent-card ${expanded ? 'aad-agent-card--expanded' : ''}`}
      style={{ animationDelay: `${delay}ms` }}
      onClick={() => setExpanded(e => !e)}
      aria-expanded={expanded}
    >
      <div className="aad-agent-top">
        <div className="aad-agent-left">
          <span className="aad-status-dot" style={{ background: STATUS_COLORS[agent.status] }} />
          <div>
            <div className="aad-agent-name">{agent.name}</div>
            <div className="aad-agent-role">{agent.role}</div>
          </div>
        </div>
        <div className="aad-agent-count">
          <span className="aad-agent-num">{agent.completed}</span>
          <span className="aad-agent-num-label">tasks</span>
        </div>
      </div>

      <div className="aad-agent-task">
        {agent.task
          ? <span className="aad-task-text">{agent.task}</span>
          : <span className="aad-task-idle">— idle —</span>
        }
      </div>

      <MiniBarChart data={agent.activity} />

      {expanded && (
        <div className="aad-agent-detail">
          <div className="aad-detail-row">
            <span className="aad-detail-label">Status</span>
            <span className="aad-detail-val" style={{ color: STATUS_COLORS[agent.status] }}>
              {agent.status}
            </span>
          </div>
          <div className="aad-detail-row">
            <span className="aad-detail-label">Completed today</span>
            <span className="aad-detail-val">{agent.completed}</span>
          </div>
          <div className="aad-detail-row">
            <span className="aad-detail-label">Peak hour</span>
            <span className="aad-detail-val">
              {agent.activity.indexOf(Math.max(...agent.activity))}:00
            </span>
          </div>
        </div>
      )}
    </button>
  );
}

function PhaseBar({ phase, delay }: { phase: Phase; delay: number }) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setWidth(phase.pct), delay);
    return () => clearTimeout(t);
  }, [phase.pct, delay]);

  return (
    <div className="aad-phase">
      <div className="aad-phase-meta">
        <span className="aad-phase-name">{phase.name}</span>
        <span className="aad-phase-label">{phase.label}</span>
        <span className="aad-phase-pct">{phase.pct}%</span>
      </div>
      <div className="aad-phase-track">
        <div
          className="aad-phase-fill"
          style={{
            width: `${width}%`,
            transition: `width 600ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`,
            background: phase.pct === 100
              ? 'var(--cc-success)'
              : phase.pct > 0
              ? 'var(--cc-accent)'
              : 'transparent',
          }}
        />
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AgentActivityDashboard() {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [paused, setPaused] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  const totalCompleted = AGENTS.reduce((s, a) => s + a.completed, 0);

  // Auto-scroll feed
  useEffect(() => {
    if (paused) return;
    const el = feedRef.current;
    if (!el) return;
    const id = setInterval(() => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
        el.scrollTop = 0;
      } else {
        el.scrollTop += 1;
      }
    }, 40);
    return () => clearInterval(id);
  }, [paused]);

  return (
    <div className="aad-root">
      {/* Header */}
      <header className="aad-header aad-fade-in" style={{ animationDelay: '0ms' }}>
        <div className="aad-header-left">
          <h1 className="aad-title">Agent Activity</h1>
          <span className="aad-title-sub">SG-1 Command Center</span>
        </div>
        <nav className="aad-time-nav" aria-label="Time range">
          {(['1h', '6h', '24h', '7d'] as TimeRange[]).map(r => (
            <button
              key={r}
              className={`aad-time-btn ${timeRange === r ? 'aad-time-btn--active' : ''}`}
              onClick={() => setTimeRange(r)}
              aria-pressed={timeRange === r}
            >
              {r}
            </button>
          ))}
        </nav>
      </header>

      {/* Bento grid: hero (span-2) + sprint */}
      <div className="aad-bento">
        {/* Hero metric */}
        <div className="aad-hero aad-fade-in" style={{ animationDelay: '50ms' }}>
          <div className="aad-hero-label">Tasks Completed Today</div>
          <div className="aad-hero-metric">
            <span className="aad-hero-number">{totalCompleted}</span>
            <span className="aad-hero-unit">tasks</span>
          </div>
          <div className="aad-hero-meta">
            <span className="aad-hero-delta">+12 vs yesterday</span>
            <span className="aad-hero-range">{timeRange} window</span>
          </div>
          <Sparkline data={SPARKLINE_DATA} width={280} height={48} />
        </div>

        {/* Sprint progress */}
        <div className="aad-sprint aad-fade-in" style={{ animationDelay: '100ms' }}>
          <div className="aad-card-header">
            <h2 className="aad-card-title">Sprint 28</h2>
            <span className="aad-card-badge">Active</span>
          </div>
          <div className="aad-phases">
            {PHASES.map((phase, i) => (
              <PhaseBar key={phase.name} phase={phase} delay={200 + i * 120} />
            ))}
          </div>
          <div className="aad-sprint-footer">
            <span className="aad-sprint-stat">
              <span className="aad-sprint-num">3</span> phases
            </span>
            <span className="aad-sprint-stat">
              <span className="aad-sprint-num">18</span> tasks open
            </span>
          </div>
        </div>
      </div>

      {/* Agent roster */}
      <section className="aad-section">
        <h2 className="aad-section-title aad-fade-in" style={{ animationDelay: '150ms' }}>
          Agent Roster
          <span className="aad-section-count">{AGENTS.filter(a => a.status === 'online').length} online</span>
        </h2>
        <div className="aad-agent-grid">
          {AGENTS.map((agent, i) => (
            <AgentCard key={agent.name} agent={agent} delay={200 + i * 50} />
          ))}
        </div>
      </section>

      {/* Activity feed */}
      <section className="aad-section">
        <h2 className="aad-section-title aad-fade-in" style={{ animationDelay: '450ms' }}>
          Recent Activity
          <span className="aad-section-count">live</span>
        </h2>
        <div
          className={`aad-feed aad-fade-in`}
          style={{ animationDelay: '500ms' }}
          ref={feedRef}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          aria-label="Activity feed, auto-scrolling — hover to pause"
        >
          {[...EVENTS, ...EVENTS].map((ev, i) => (
            <div key={i} className="aad-feed-row">
              <span className="aad-feed-time">{ev.time}</span>
              <span className="aad-feed-agent">{ev.agent}</span>
              <span
                className="aad-feed-action"
                style={{ color: ACTION_COLORS[ev.action] }}
              >
                {ev.action}
              </span>
              <span className="aad-feed-target">{ev.target}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
