'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import './ProjectOverview.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type Priority = 'Low' | 'Med' | 'High' | 'Urgent';
type TaskStatus = 'To Do' | 'In Progress' | 'Done';
type SortKey = 'title' | 'assignee' | 'priority' | 'status' | 'due';
type SortDir = 'asc' | 'desc';

interface Task {
  id: string;
  title: string;
  assignee: string;
  assigneeColor: string;
  priority: Priority;
  status: TaskStatus;
  due: string; // ISO date
  overdue?: boolean;
}

interface FeedEntry {
  id: string;
  user: string;
  initials: string;
  color: string;
  text: string;
  time: string;
}

// ─── Mock data ────────────────────────────────────────────────────────────────

const TASKS: Task[] = [
  { id: 't1', title: 'Final cut — hero sequence edit',     assignee: 'Sam',   assigneeColor: 'a', priority: 'Urgent', status: 'In Progress', due: '2026-03-28', overdue: true },
  { id: 't2', title: 'Client review deck v4',              assignee: 'Alex',  assigneeColor: 'b', priority: 'High',   status: 'In Progress', due: '2026-04-01' },
  { id: 't3', title: 'Motion graphics — title cards',      assignee: 'Maya',  assigneeColor: 'c', priority: 'High',   status: 'To Do',       due: '2026-04-03' },
  { id: 't4', title: 'Sound design pass',                  assignee: 'Dom',   assigneeColor: 'd', priority: 'Med',    status: 'To Do',       due: '2026-04-05' },
  { id: 't5', title: 'Export deliverables — broadcast',    assignee: 'Sam',   assigneeColor: 'a', priority: 'High',   status: 'To Do',       due: '2026-04-07' },
  { id: 't6', title: 'Instagram cut (30s)',                 assignee: 'Maya',  assigneeColor: 'c', priority: 'Med',    status: 'Done',        due: '2026-03-29' },
  { id: 't7', title: 'Draft shot list review',             assignee: 'Alex',  assigneeColor: 'b', priority: 'Low',    status: 'Done',        due: '2026-03-27' },
  { id: 't8', title: 'Colour grade — exterior scenes',     assignee: 'Dom',   assigneeColor: 'd', priority: 'Urgent', status: 'In Progress', due: '2026-04-02' },
];

const FEED: FeedEntry[] = [
  { id: 'f1', user: 'Sam',    initials: 'S', color: 'a', text: 'uploaded <strong>final_edit_v3.mp4</strong> to hero sequence', time: '2m ago' },
  { id: 'f2', user: 'Client', initials: 'C', color: 'e', text: '<strong>Client</strong> approved deliverable — Instagram 30s cut', time: '18m ago' },
  { id: 'f3', user: 'Alex',   initials: 'A', color: 'b', text: 'added a comment on <strong>Shot List v2</strong>', time: '1h ago' },
  { id: 'f4', user: 'Dom',    initials: 'D', color: 'd', text: 'started colour grade on exterior scenes', time: '2h ago' },
  { id: 'f5', user: 'Maya',   initials: 'M', color: 'c', text: 'completed <strong>Instagram cut (30s)</strong>', time: '3h ago' },
  { id: 'f6', user: 'Alex',   initials: 'A', color: 'b', text: 'moved deadline for broadcast export to Apr 7', time: '5h ago' },
];

const TEAM_COLORS = ['a', 'b', 'c', 'd', 'e'] as const;

const PRIORITY_ORDER: Record<Priority, number> = { Low: 0, Med: 1, High: 2, Urgent: 3 };
const STATUS_ORDER: Record<TaskStatus, number> = { 'To Do': 0, 'In Progress': 1, 'Done': 2 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function useCountUp(target: number, delay = 0): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const t0 = setTimeout(() => {
      const start = performance.now();
      const dur = 500;
      const tick = (now: number) => {
        const p = Math.min((now - start) / dur, 1);
        const ease = 1 - Math.pow(1 - p, 3);
        setValue(Math.round(ease * target));
        if (p < 1) requestAnimationFrame(tick);
        else setValue(target);
      };
      requestAnimationFrame(tick);
    }, delay);
    return () => clearTimeout(t0);
  }, [target, delay]);
  return value;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function isOverdue(iso: string): boolean {
  return new Date(iso) < new Date(new Date().toDateString());
}

// ─── Progress ring ───────────────────────────────────────────────────────────

function ProgressRing({ completed, total, delay = 0 }: { completed: number; total: number; delay?: number }) {
  const r = 18;
  const circ = 2 * Math.PI * r;
  const [dash, setDash] = useState(circ);

  useEffect(() => {
    const t = setTimeout(() => {
      setDash(circ - (completed / total) * circ);
    }, delay);
    return () => clearTimeout(t);
  }, [completed, total, circ, delay]);

  return (
    <div className="po-ring-wrap">
      <svg width="44" height="44" className="po-ring" aria-hidden="true">
        <circle className="po-ring-track" cx="22" cy="22" r={r} />
        <circle
          className="po-ring-fill"
          cx="22" cy="22" r={r}
          strokeDasharray={circ}
          strokeDashoffset={dash}
          transform="rotate(-90 22 22)"
        />
      </svg>
      <div>
        <div className="po-stat-value" style={{ animationDelay: `${delay}ms` }}>
          {completed}<span style={{ fontSize: 16, color: 'var(--oc-text-m)', fontWeight: 400 }}>/{total}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Avatar ──────────────────────────────────────────────────────────────────

function Avatar({ initials, color, size = 'md' }: { initials: string; color: string; size?: 'sm' | 'md' }) {
  return (
    <div className={`po-avatar po-avatar--color-${color} ${size === 'sm' ? 'po-avatar--sm' : ''}`}>
      {initials}
    </div>
  );
}

// ─── Badge ───────────────────────────────────────────────────────────────────

function PriorityBadge({ p }: { p: Priority }) {
  const cls = p === 'Low' ? 'po-badge--low' : p === 'Med' ? 'po-badge--med' : p === 'High' ? 'po-badge--high' : 'po-badge--urgent';
  return <span className={`po-badge ${cls}`}>{p}</span>;
}

function StatusBadge({ s }: { s: TaskStatus }) {
  const cls = s === 'To Do' ? 'po-badge--todo' : s === 'In Progress' ? 'po-badge--inprog' : 'po-badge--done-s';
  return <span className={`po-badge ${cls}`}>{s}</span>;
}

// ─── Budget bar ──────────────────────────────────────────────────────────────

function BudgetBar({ spent, total, delay = 0 }: { spent: number; total: number; delay?: number }) {
  const [width, setWidth] = useState(0);
  const pct = Math.round((spent / total) * 100);

  useEffect(() => {
    const t = setTimeout(() => setWidth(pct), delay);
    return () => clearTimeout(t);
  }, [pct, delay]);

  return (
    <div className="po-budget-wrap">
      <div className="po-budget-bar-track">
        <div className="po-budget-bar-fill" style={{ width: `${width}%` }} />
      </div>
      <div className="po-budget-label">
        <span>£{spent.toLocaleString()} of £{total.toLocaleString()}</span>
        <span className="po-budget-pct">{pct}%</span>
      </div>
    </div>
  );
}

// ─── Task table ──────────────────────────────────────────────────────────────

function TaskTable({ tasks }: { tasks: Task[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('priority');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = useCallback((key: SortKey) => {
    setSortDir(d => sortKey === key ? (d === 'asc' ? 'desc' : 'asc') : 'desc');
    setSortKey(key);
  }, [sortKey]);

  const sorted = [...tasks].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'title':    cmp = a.title.localeCompare(b.title); break;
      case 'assignee': cmp = a.assignee.localeCompare(b.assignee); break;
      case 'priority': cmp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]; break;
      case 'status':   cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]; break;
      case 'due':      cmp = new Date(a.due).getTime() - new Date(b.due).getTime(); break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const cols: { key: SortKey; label: string }[] = [
    { key: 'title',    label: 'Task' },
    { key: 'assignee', label: 'Assignee' },
    { key: 'priority', label: 'Priority' },
    { key: 'status',   label: 'Status' },
    { key: 'due',      label: 'Due' },
  ];

  return (
    <table className="po-table" role="grid" aria-label="Project tasks">
      <thead className="po-table-head">
        <tr>
          {cols.map(c => (
            <th
              key={c.key}
              tabIndex={0}
              className={`po-th-sortable ${sortKey === c.key ? 'po-th-active' : ''}`}
              onClick={() => handleSort(c.key)}
              onKeyDown={e => e.key === 'Enter' && handleSort(c.key)}
              aria-sort={sortKey === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              {c.label}
              <i className="po-sort-icon" aria-hidden="true">
                {sortKey === c.key ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
              </i>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map(task => (
          <tr
            key={task.id}
            className={task.overdue ? 'po-row--overdue' : ''}
          >
            <td>
              <div className="po-task-title">
                {task.overdue && <span className="po-task-overdue-dot" aria-label="Overdue" />}
                <span className="po-task-title-text" title={task.title}>{task.title}</span>
              </div>
            </td>
            <td>
              <div className="po-assignee-cell">
                <Avatar initials={task.assignee[0]} color={task.assigneeColor} size="sm" />
                <span className="po-assignee-name">{task.assignee}</span>
              </div>
            </td>
            <td><PriorityBadge p={task.priority} /></td>
            <td><StatusBadge s={task.status} /></td>
            <td>
              <span className={task.overdue ? 'po-date-overdue' : 'po-date-normal'} title={task.due}>
                {formatDate(task.due)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Quick-add modal ──────────────────────────────────────────────────────────

interface ModalProps { onClose: () => void; }

function QuickAddModal({ onClose }: ModalProps) {
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { firstRef.current?.focus(); }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  return (
    <div
      className="po-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Add new task"
      onClick={e => e.target === e.currentTarget && onClose()}
      onKeyDown={handleKeyDown}
    >
      <div className="po-modal">
        <div className="po-modal-header">
          <span className="po-modal-title">New Task</span>
          <button className="po-modal-close" onClick={onClose} aria-label="Close modal">×</button>
        </div>
        <div className="po-modal-body">
          <div className="po-field">
            <label className="po-label" htmlFor="task-title">Title</label>
            <input
              ref={firstRef}
              id="task-title"
              className="po-input"
              placeholder="Task description..."
              autoComplete="off"
            />
          </div>
          <div className="po-field-row">
            <div className="po-field">
              <label className="po-label" htmlFor="task-assignee">Assignee</label>
              <select id="task-assignee" className="po-select">
                <option value="">Select...</option>
                <option>Sam</option>
                <option>Alex</option>
                <option>Maya</option>
                <option>Dom</option>
              </select>
            </div>
            <div className="po-field">
              <label className="po-label" htmlFor="task-priority">Priority</label>
              <select id="task-priority" className="po-select">
                <option>Low</option>
                <option>Med</option>
                <option>High</option>
                <option>Urgent</option>
              </select>
            </div>
          </div>
          <div className="po-field">
            <label className="po-label" htmlFor="task-due">Due Date</label>
            <input id="task-due" type="date" className="po-input" />
          </div>
          <div className="po-field">
            <label className="po-label" htmlFor="task-desc">Description</label>
            <textarea
              id="task-desc"
              className="po-textarea"
              placeholder="Optional notes..."
            />
          </div>
        </div>
        <div className="po-modal-footer">
          <button className="po-btn po-btn--ghost" onClick={onClose}>Cancel</button>
          <button className="po-btn po-btn--primary" onClick={onClose}>Save Task</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProjectOverview() {
  const [showModal, setShowModal]     = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  const hours     = useCountUp(127, 300);
  const daysLeft  = useCountUp(14, 400);

  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      const el = document.querySelector('.po-topbar-right');
      if (el && !el.contains(e.target as Node)) setShowDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDropdown]);

  return (
    <div className="po-root">
      {/* Top bar */}
      <header>
        <div className="po-topbar po-anim po-anim-1">
          <div className="po-logo">Acme</div>

          <nav className="po-breadcrumb" aria-label="Breadcrumb">
            <span>Projects</span>
            <span className="po-breadcrumb-sep">›</span>
            <span className="po-breadcrumb-active">Meridian Campaign</span>
          </nav>

          <div className="po-topbar-right">
            <button
              className="po-avatar-btn"
              onClick={() => setShowDropdown(d => !d)}
              aria-expanded={showDropdown}
              aria-haspopup="menu"
            >
              <Avatar initials="LW" color="b" />
              <span className="po-avatar-name">Alex</span>
            </button>
            {showDropdown && (
              <div className="po-user-dropdown" role="menu">
                <button className="po-dropdown-item" role="menuitem">Profile</button>
                <button className="po-dropdown-item" role="menuitem">Settings</button>
                <div className="po-dropdown-sep" />
                <button className="po-dropdown-item po-dropdown-item--danger" role="menuitem">Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="po-page">
        {/* Project header */}
        <section className="po-project-header po-anim po-anim-2" aria-label="Project details">
          <div className="po-project-meta">
            <span className="po-client-name">Acme Homes — Meridian</span>
            <span className="po-badge po-badge--active">Active</span>
          </div>

          <h1 className="po-project-name">Meridian Campaign</h1>

          <div className="po-project-details">
            <div className="po-detail-item">
              <span className="po-detail-label">Deadline</span>
              <span className="po-detail-val">13 Apr 2026</span>
            </div>
            <div className="po-detail-item">
              <span className="po-detail-label">Project Manager</span>
              <span className="po-detail-val">Alex Weston</span>
            </div>
            <div className="po-detail-item" style={{ flex: 1 }}>
              <span className="po-detail-label">Budget</span>
              <BudgetBar spent={18400} total={28000} delay={400} />
            </div>
          </div>
        </section>

        {/* Stats row */}
        <div className="po-stats po-anim po-anim-3" role="region" aria-label="Project statistics">
          {/* Hours logged */}
          <div className="po-stat-card">
            <span className="po-stat-label">Hours logged</span>
            <div className="po-stat-value" style={{ animationDelay: '300ms' }}>
              {hours}
            </div>
            <span className="po-stat-sub">this week</span>
          </div>

          {/* Tasks completed */}
          <div className="po-stat-card">
            <span className="po-stat-label">Tasks completed</span>
            <ProgressRing completed={12} total={18} delay={200} />
            <span className="po-stat-sub">of 18 tasks</span>
          </div>

          {/* Team members */}
          <div className="po-stat-card">
            <span className="po-stat-label">Team members</span>
            <div className="po-stat-value" style={{ animationDelay: '350ms' }}>5</div>
            <div className="po-avatar-stack" aria-label="Team avatars">
              {(['S','L','M','D','R'] as const).map((init, i) => (
                <Avatar key={i} initials={init} color={TEAM_COLORS[i]} size="sm" />
              ))}
            </div>
          </div>

          {/* Days until deadline */}
          <div className="po-stat-card">
            <span className="po-stat-label">Days until deadline</span>
            <div className={`po-stat-value ${daysLeft < 7 ? 'po-stat-value--danger' : ''}`} style={{ animationDelay: '400ms' }}>
              {daysLeft}
            </div>
            <span className="po-stat-sub">Apr 13, 2026</span>
          </div>
        </div>

        {/* Body: task list + activity feed */}
        <div className="po-body">
          {/* Task list */}
          <section className="po-tasks po-anim po-anim-5" aria-label="Task list">
            <div className="po-tasks-header">
              <span className="po-tasks-title">Tasks</span>
              <span className="po-tasks-count">{TASKS.filter(t => t.status !== 'Done').length} open · {TASKS.filter(t => t.status === 'Done').length} done</span>
            </div>
            <TaskTable tasks={TASKS} />
          </section>

          {/* Activity feed */}
          <aside className="po-feed po-anim po-anim-6" aria-label="Recent activity">
            <div className="po-feed-header">
              <span className="po-feed-title">Activity</span>
              <div className="po-feed-live" aria-label="Live updates">
                <span className="po-feed-live-dot" />
                <span>Live</span>
              </div>
            </div>
            <div className="po-feed-list">
              {FEED.map(entry => (
                <div key={entry.id} className="po-feed-entry">
                  <Avatar initials={entry.initials} color={entry.color} size="sm" />
                  <div className="po-feed-entry-content">
                    <div
                      className="po-feed-entry-text"
                      title={`${entry.user} ${entry.text.replace(/<[^>]+>/g, '')}`}
                      dangerouslySetInnerHTML={{
                        __html: `<strong>${entry.user}</strong> ${entry.text}`
                      }}
                    />
                    <span className="po-feed-entry-time">{entry.time}</span>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>

      {/* FAB */}
      <button
        className="po-fab po-anim po-anim-7"
        onClick={() => setShowModal(true)}
        aria-label="Add new task"
        title="Add new task"
      >
        +
      </button>

      {/* Modal */}
      {showModal && <QuickAddModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
