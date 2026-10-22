'use client';

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import './ProjectOverviewV3.css';

// ── Types ──────────────────────────────────────────────────────

type Priority = 'Low' | 'Med' | 'High' | 'Urgent';
type TaskStatus = 'To Do' | 'In Progress' | 'Done';
type SortKey = 'title' | 'assignee' | 'priority' | 'status' | 'dueDate';
type SortDir = 'asc' | 'desc';

interface Task {
  id: string;
  title: string;
  assignee: string;
  priority: Priority;
  status: TaskStatus;
  dueDate: string;
  dueDateSort: number;
  overdue: boolean;
}

interface ActivityEntry {
  id: string;
  user: string;
  action: string;
  timestamp: string;
  initials: string;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
  initials: string;
  hue: number;
}

interface AddTaskForm {
  title: string;
  assignee: string;
  priority: Priority;
  dueDate: string;
  description: string;
}

// ── Sort order maps ────────────────────────────────────────────

const PRIORITY_RANK: Record<Priority, number> = {
  Urgent: 4, High: 3, Med: 2, Low: 1,
};
const STATUS_RANK: Record<TaskStatus, number> = {
  'To Do': 1, 'In Progress': 2, Done: 3,
};

// ── Static mock data ───────────────────────────────────────────

const INITIAL_TASKS: Task[] = [
  {
    id: 't1', title: 'Brand Guidelines PDF', assignee: 'Sam Chen',
    priority: 'Urgent', status: 'To Do',
    dueDate: 'Mar 28', dueDateSort: 20260328, overdue: true,
  },
  {
    id: 't2', title: 'Hero imagery shoot', assignee: 'Alex Walsh',
    priority: 'High', status: 'In Progress',
    dueDate: 'Apr 5', dueDateSort: 20260405, overdue: false,
  },
  {
    id: 't3', title: 'Typeface selection', assignee: 'Sam Chen',
    priority: 'Med', status: 'Done',
    dueDate: 'Mar 25', dueDateSort: 20260325, overdue: false,
  },
  {
    id: 't4', title: 'Color system', assignee: 'Alex Park',
    priority: 'High', status: 'Done',
    dueDate: 'Mar 22', dueDateSort: 20260322, overdue: false,
  },
  {
    id: 't5', title: 'Website mockups', assignee: 'Alex Walsh',
    priority: 'High', status: 'In Progress',
    dueDate: 'Apr 12', dueDateSort: 20260412, overdue: false,
  },
  {
    id: 't6', title: 'Client presentation deck', assignee: 'Alex Park',
    priority: 'Med', status: 'To Do',
    dueDate: 'Apr 8', dueDateSort: 20260408, overdue: false,
  },
  {
    id: 't7', title: 'Social media templates', assignee: 'Jordan Mills',
    priority: 'Low', status: 'To Do',
    dueDate: 'Apr 15', dueDateSort: 20260415, overdue: false,
  },
  {
    id: 't8', title: 'Motion design guidelines', assignee: 'Jordan Mills',
    priority: 'Med', status: 'To Do',
    dueDate: 'Apr 15', dueDateSort: 20260415, overdue: false,
  },
];

const ACTIVITY: ActivityEntry[] = [
  { id: 'a1', user: 'Sam', action: 'uploaded final_edit_v3.mp4', timestamp: '2h ago', initials: 'SC' },
  { id: 'a2', user: 'Client', action: 'approved the deliverable', timestamp: '4h ago', initials: 'TW' },
  { id: 'a3', user: 'Alex', action: 'added a comment on Shot List', timestamp: 'Yesterday', initials: 'AW' },
  { id: 'a4', user: 'Alex', action: 'completed Color system', timestamp: 'Yesterday', initials: 'AP' },
  { id: 'a5', user: 'Jordan', action: 'was added to the project', timestamp: '2 days ago', initials: 'JM' },
  { id: 'a6', user: 'Client', action: 'left feedback on mockups', timestamp: '3 days ago', initials: 'TW' },
];

const TEAM: TeamMember[] = [
  { id: 'm1', name: 'Sam Chen', role: 'Lead Designer', initials: 'SC', hue: 195 },
  { id: 'm2', name: 'Alex Walsh', role: 'Videographer', initials: 'AW', hue: 270 },
  { id: 'm3', name: 'Alex Park', role: 'Art Director', initials: 'AP', hue: 155 },
  { id: 'm4', name: 'Jordan Mills', role: 'Motion Designer', initials: 'JM', hue: 45 },
];

const BUDGET_TOTAL = 60000;
const BUDGET_SPENT = 42000;
const BUDGET_PCT = Math.round((BUDGET_SPENT / BUDGET_TOTAL) * 100);

const FORM_DEFAULT: AddTaskForm = {
  title: '', assignee: '', priority: 'Med', dueDate: '', description: '',
};

// ── Count-up hook ──────────────────────────────────────────────

function useCountUp(target: number, duration = 800, enabled = true): number {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out-cubic
      setValue(Math.round(target * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration, enabled]);

  return value;
}

// ── Sort helper ────────────────────────────────────────────────

function sortTasks(tasks: Task[], key: SortKey, dir: SortDir): Task[] {
  return [...tasks].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case 'title':    cmp = a.title.localeCompare(b.title); break;
      case 'assignee': cmp = a.assignee.localeCompare(b.assignee); break;
      case 'priority': cmp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]; break;
      case 'status':   cmp = STATUS_RANK[a.status] - STATUS_RANK[b.status]; break;
      case 'dueDate':  cmp = a.dueDateSort - b.dueDateSort; break;
    }
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ── Component ──────────────────────────────────────────────────

export default function ProjectOverviewV3() {
  const [tasks, setTasks] = useState<Task[]>(INITIAL_TASKS);
  const [sortKey, setSortKey] = useState<SortKey>('dueDate');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<AddTaskForm>(FORM_DEFAULT);
  const [mounted, setMounted] = useState(false);

  const modalRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLInputElement>(null);

  // Trigger entrance animations + count-up after mount
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const budgetDisplay = useCountUp(BUDGET_SPENT, 800, mounted);

  const handleSort = useCallback((key: SortKey) => {
    setSortDir(prev =>
      sortKey === key ? (prev === 'asc' ? 'desc' : 'asc') : 'asc'
    );
    setSortKey(key);
  }, [sortKey]);

  const sorted = sortTasks(tasks, sortKey, sortDir);

  // Modal: Escape key + focus trap
  useEffect(() => {
    if (!showModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowModal(false);
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => firstFocusRef.current?.focus(), 50);
    return () => document.removeEventListener('keydown', onKey);
  }, [showModal]);

  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) setShowModal(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;

    const rawDate = form.dueDate
      ? new Date(form.dueDate + 'T00:00:00')
      : null;
    const dueLabel = rawDate
      ? rawDate.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
      : 'No date';
    const dueDateSort = rawDate
      ? Number(form.dueDate.replace(/-/g, ''))
      : 99999999;

    const newTask: Task = {
      id: `t${Date.now()}`,
      title: form.title.trim(),
      assignee: form.assignee || 'Unassigned',
      priority: form.priority,
      status: 'To Do',
      dueDate: dueLabel,
      dueDateSort,
      overdue: false,
    };

    setTasks(prev => [...prev, newTask]);
    setShowModal(false);
    setForm(FORM_DEFAULT);
  };

  const overdueCount = tasks.filter(t => t.overdue).length;
  const doneCount = tasks.filter(t => t.status === 'Done').length;

  // ── Render ─────────────────────────────────────────────────

  return (
    <main className={`pov3-root${mounted ? ' pov3-mounted' : ''}`}>
      <div className="pov3-layout">

        {/* ─ Main column ──────────────────────────────────────── */}
        <div className="pov3-main">

          {/* Project header — carries the visual weight */}
          <header className="pov3-header pov3-enter pov3-enter-1">
            <div className="pov3-header-row">
              <div className="pov3-header-left">
                <div className="pov3-breadcrumb">
                  <span className="pov3-breadcrumb-item">Acme Homes</span>
                  <span className="pov3-breadcrumb-sep" aria-hidden="true">/</span>
                  <span className="pov3-breadcrumb-item pov3-breadcrumb-active">Project Overview</span>
                </div>
                <h1 className="pov3-project-name">Horizon Brand Refresh</h1>
                <div className="pov3-header-meta">
                  <span
                    className="pov3-status-badge pov3-status-at-risk"
                    role="status"
                    aria-label="Project status: At Risk"
                  >
                    <span className="pov3-status-dot" aria-hidden="true" />
                    At Risk
                  </span>
                  <span className="pov3-meta-sep" aria-hidden="true">·</span>
                  <span className="pov3-meta-pair">
                    <span className="pov3-meta-label">Due</span>
                    <span className="pov3-meta-value">Apr 15, 2026</span>
                  </span>
                  <span className="pov3-meta-sep" aria-hidden="true">·</span>
                  <span className="pov3-meta-pair">
                    <span className="pov3-meta-label">Progress</span>
                    <span className="pov3-meta-value pov3-tabnum">
                      {doneCount}/{tasks.length} tasks
                    </span>
                  </span>
                </div>
              </div>
              <div className="pov3-header-right">
                <button
                  className="pov3-btn-primary"
                  onClick={() => setShowModal(true)}
                  aria-label="Add new task"
                >
                  + Add Task
                </button>
              </div>
            </div>

            {/* Overdue strip — NOT a card, NOT a metric hero */}
            {overdueCount > 0 && (
              <div className="pov3-overdue-strip" role="alert">
                <span className="pov3-overdue-icon" aria-hidden="true">⚠</span>
                <span className="pov3-overdue-text">
                  <strong>Brand Guidelines PDF</strong>{' '}
                  is overdue — was due Mar 28
                </span>
                <span className="pov3-overdue-badge">{overdueCount} overdue</span>
              </div>
            )}
          </header>

          {/* Budget — inline data pair with progress bar, NO card wrapper */}
          <section
            className="pov3-budget pov3-enter pov3-enter-2"
            aria-label="Project budget"
          >
            <div className="pov3-budget-row">
              <span className="pov3-section-label">BUDGET</span>
              <div className="pov3-budget-figures">
                <span
                  className="pov3-budget-spent pov3-tabnum"
                  aria-label={`Spent: $${BUDGET_SPENT.toLocaleString()}`}
                >
                  ${budgetDisplay.toLocaleString()}
                </span>
                <span className="pov3-budget-of" aria-hidden="true"> / </span>
                <span className="pov3-budget-total pov3-tabnum">${BUDGET_TOTAL.toLocaleString()}</span>
              </div>
              <span className="pov3-budget-pct-badge pov3-tabnum">{BUDGET_PCT}%</span>
            </div>
            <div
              className="pov3-budget-track"
              role="progressbar"
              aria-valuenow={BUDGET_PCT}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${BUDGET_PCT}% of budget used`}
            >
              <div
                className={`pov3-budget-fill${mounted ? ' pov3-fill-animate' : ''}`}
                style={{ '--fill-pct': `${BUDGET_PCT}%` } as React.CSSProperties}
              />
            </div>
          </section>

          {/* Task table */}
          <section
            className="pov3-tasks pov3-enter pov3-enter-3"
            aria-label="Task list"
          >
            <div className="pov3-tasks-header">
              <span className="pov3-section-label">TASKS</span>
              <span className="pov3-tasks-meta pov3-tabnum">
                {tasks.length} tasks · {overdueCount} overdue
              </span>
            </div>

            <div className="pov3-table-wrap">
              <table className="pov3-table" aria-label="Project tasks, sortable">
                <thead>
                  <tr>
                    {(
                      [
                        ['title', 'TASK'],
                        ['assignee', 'ASSIGNEE'],
                        ['priority', 'PRIORITY'],
                        ['status', 'STATUS'],
                        ['dueDate', 'DUE'],
                      ] as [SortKey, string][]
                    ).map(([key, label]) => (
                      <th key={key} scope="col">
                        <button
                          className={`pov3-sort-btn${sortKey === key ? ' pov3-sort-active' : ''}`}
                          onClick={() => handleSort(key)}
                          aria-sort={
                            sortKey === key
                              ? sortDir === 'asc' ? 'ascending' : 'descending'
                              : 'none'
                          }
                        >
                          {label}
                          <span
                            className={`pov3-sort-arrow${sortKey === key ? ' pov3-sort-arrow-active' : ''}`}
                            aria-hidden="true"
                          >
                            {sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'}
                          </span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((task, idx) => (
                    <tr
                      key={task.id}
                      className={[
                        'pov3-task-row',
                        task.overdue ? 'pov3-row-overdue' : '',
                        task.status === 'Done' ? 'pov3-row-done' : '',
                      ].filter(Boolean).join(' ')}
                      style={{ '--row-delay': `${idx * 25}ms` } as React.CSSProperties}
                    >
                      <td className="pov3-col-title">
                        {task.overdue && (
                          <span className="pov3-overdue-marker" aria-label="Overdue" title="Overdue" />
                        )}
                        <span className="pov3-task-name" title={task.title}>
                          {task.title}
                        </span>
                      </td>
                      <td className="pov3-col-assignee">
                        <div className="pov3-assignee-cell">
                          <span
                            className="pov3-avatar-sm"
                            aria-hidden="true"
                            title={task.assignee}
                          >
                            {task.assignee.split(' ').map(n => n[0]).join('')}
                          </span>
                          <span className="pov3-assignee-name">{task.assignee.split(' ')[0]}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`pov3-priority-badge pov3-pri-${task.priority.toLowerCase()}`}>
                          {task.priority}
                        </span>
                      </td>
                      <td>
                        <span className={`pov3-status-pill pov3-st-${task.status.replace(/\s+/g, '-').toLowerCase()}`}>
                          {task.status}
                        </span>
                      </td>
                      <td
                        className={`pov3-col-due pov3-tabnum${task.overdue ? ' pov3-due-overdue' : ''}`}
                      >
                        {task.dueDate}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* ─ Sidebar ──────────────────────────────────────────── */}
        <aside className="pov3-sidebar" aria-label="Project details">

          {/* Activity feed */}
          <section className="pov3-activity pov3-enter pov3-enter-2" aria-label="Recent activity">
            <span className="pov3-section-label">RECENT ACTIVITY</span>
            <ul className="pov3-feed" role="list">
              {ACTIVITY.map((entry, idx) => (
                <li
                  key={entry.id}
                  className="pov3-feed-item"
                  style={{ '--feed-delay': `${idx * 40 + 120}ms` } as React.CSSProperties}
                >
                  <span className="pov3-feed-avatar" aria-hidden="true">{entry.initials}</span>
                  <div className="pov3-feed-body">
                    <p className="pov3-feed-text">
                      <strong className="pov3-feed-user">{entry.user}</strong>{' '}
                      {entry.action}
                    </p>
                    <time className="pov3-feed-time" dateTime={entry.timestamp}>
                      {entry.timestamp}
                    </time>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* Team */}
          <section className="pov3-team pov3-enter pov3-enter-3" aria-label="Team members">
            <div className="pov3-team-header">
              <span className="pov3-section-label">TEAM</span>
              <span className="pov3-section-meta pov3-tabnum">
                {TEAM.length} members · 34 hrs this week
              </span>
            </div>
            <ul className="pov3-team-list" role="list">
              {TEAM.map(member => (
                <li key={member.id} className="pov3-team-member">
                  <span
                    className="pov3-team-avatar"
                    style={{ '--member-hue': String(member.hue) } as React.CSSProperties}
                    aria-hidden="true"
                    title={member.name}
                  >
                    {member.initials}
                  </span>
                  <div className="pov3-team-info">
                    <span className="pov3-team-name">{member.name}</span>
                    <span className="pov3-team-role">{member.role}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      {/* ─ Add Task Modal ─────────────────────────────────────── */}
      {showModal && (
        <div
          className="pov3-backdrop"
          onClick={handleBackdrop}
          role="dialog"
          aria-modal="true"
          aria-labelledby="pov3-modal-title"
        >
          <div className="pov3-modal" ref={modalRef}>
            <div className="pov3-modal-head">
              <h2 id="pov3-modal-title" className="pov3-modal-title">Add Task</h2>
              <button
                className="pov3-modal-close"
                onClick={() => setShowModal(false)}
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>
            <form className="pov3-modal-form" onSubmit={handleSubmit} noValidate>
              <div className="pov3-form-field">
                <label htmlFor="pov3-f-title" className="pov3-form-label">Title</label>
                <input
                  id="pov3-f-title"
                  ref={firstFocusRef}
                  className="pov3-form-input"
                  type="text"
                  placeholder="Task title"
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  required
                  autoComplete="off"
                />
              </div>
              <div className="pov3-form-row">
                <div className="pov3-form-field">
                  <label htmlFor="pov3-f-assignee" className="pov3-form-label">Assignee</label>
                  <select
                    id="pov3-f-assignee"
                    className="pov3-form-select"
                    value={form.assignee}
                    onChange={e => setForm(f => ({ ...f, assignee: e.target.value }))}
                  >
                    <option value="">Unassigned</option>
                    {TEAM.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                  </select>
                </div>
                <div className="pov3-form-field">
                  <label htmlFor="pov3-f-priority" className="pov3-form-label">Priority</label>
                  <select
                    id="pov3-f-priority"
                    className="pov3-form-select"
                    value={form.priority}
                    onChange={e => setForm(f => ({ ...f, priority: e.target.value as Priority }))}
                  >
                    {(['Low', 'Med', 'High', 'Urgent'] as Priority[]).map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="pov3-form-field">
                <label htmlFor="pov3-f-due" className="pov3-form-label">Due Date</label>
                <input
                  id="pov3-f-due"
                  className="pov3-form-input"
                  type="date"
                  value={form.dueDate}
                  onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                />
              </div>
              <div className="pov3-form-field">
                <label htmlFor="pov3-f-desc" className="pov3-form-label">Description</label>
                <textarea
                  id="pov3-f-desc"
                  className="pov3-form-textarea"
                  placeholder="Optional description…"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  rows={3}
                />
              </div>
              <div className="pov3-modal-actions">
                <button
                  type="button"
                  className="pov3-btn-ghost"
                  onClick={() => { setShowModal(false); setForm(FORM_DEFAULT); }}
                >
                  Cancel
                </button>
                <button type="submit" className="pov3-btn-primary">
                  Add Task
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
