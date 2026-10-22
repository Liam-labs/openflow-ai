'use client';

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import './ProjectOverviewV4.css';

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
  isoTime: string;
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

// ── Sort maps ──────────────────────────────────────────────────

const PRIORITY_RANK: Record<Priority, number> = {
  Urgent: 4, High: 3, Med: 2, Low: 1,
};
const STATUS_RANK: Record<TaskStatus, number> = {
  'To Do': 1, 'In Progress': 2, Done: 3,
};

// ── Mock data ──────────────────────────────────────────────────

const INITIAL_TASKS: Task[] = [
  {
    id: 't1', title: 'Campaign strategy document', assignee: 'Sam Chen',
    priority: 'Urgent', status: 'To Do', dueDate: 'Apr 1',
    dueDateSort: 20260401, overdue: true,
  },
  {
    id: 't2', title: 'Brand shoot — Day 1', assignee: 'Alex Walsh',
    priority: 'High', status: 'In Progress', dueDate: 'Apr 3',
    dueDateSort: 20260403, overdue: false,
  },
  {
    id: 't3', title: 'Client brief review', assignee: 'Alex Park',
    priority: 'Med', status: 'Done', dueDate: 'Mar 29',
    dueDateSort: 20260329, overdue: false,
  },
  {
    id: 't4', title: 'Social content calendar', assignee: 'Jordan Mills',
    priority: 'High', status: 'In Progress', dueDate: 'Apr 8',
    dueDateSort: 20260408, overdue: false,
  },
  {
    id: 't5', title: 'Intro reel — video edit', assignee: 'Alex Walsh',
    priority: 'High', status: 'To Do', dueDate: 'Apr 10',
    dueDateSort: 20260410, overdue: false,
  },
  {
    id: 't6', title: 'Print collateral layout', assignee: 'Sam Chen',
    priority: 'Med', status: 'To Do', dueDate: 'Apr 12',
    dueDateSort: 20260412, overdue: false,
  },
  {
    id: 't7', title: 'Digital ad set', assignee: 'Jordan Mills',
    priority: 'Low', status: 'To Do', dueDate: 'Apr 18',
    dueDateSort: 20260418, overdue: false,
  },
  {
    id: 't8', title: 'Final deliverable pack', assignee: 'Alex Park',
    priority: 'Urgent', status: 'To Do', dueDate: 'Apr 20',
    dueDateSort: 20260420, overdue: false,
  },
];

const ACTIVITY: ActivityEntry[] = [
  {
    id: 'a1', user: 'Alex', action: 'uploaded day1_shoot_raw.zip',
    timestamp: '1h ago', initials: 'AW', isoTime: '2026-03-31T13:30:00',
  },
  {
    id: 'a2', user: 'Client', action: 'approved the brand brief',
    timestamp: '3h ago', initials: 'EX', isoTime: '2026-03-31T11:30:00',
  },
  {
    id: 'a3', user: 'Sam', action: 'added Campaign strategy v2',
    timestamp: 'Yesterday', initials: 'SC', isoTime: '2026-03-30T16:00:00',
  },
  {
    id: 'a4', user: 'Alex', action: 'completed Client brief review',
    timestamp: 'Yesterday', initials: 'AP', isoTime: '2026-03-30T14:00:00',
  },
  {
    id: 'a5', user: 'Jordan', action: 'created Social content calendar draft',
    timestamp: '2 days ago', initials: 'JM', isoTime: '2026-03-29T10:00:00',
  },
  {
    id: 'a6', user: 'Client', action: 'left feedback on shoot brief',
    timestamp: '3 days ago', initials: 'EX', isoTime: '2026-03-28T09:00:00',
  },
];

const TEAM: TeamMember[] = [
  { id: 'm1', name: 'Sam Chen',    role: 'Lead Strategist',   initials: 'SC', hue: 50  },
  { id: 'm2', name: 'Alex Walsh',  role: 'Videographer',      initials: 'AW', hue: 270 },
  { id: 'm3', name: 'Alex Park',   role: 'Creative Director', initials: 'AP', hue: 155 },
  { id: 'm4', name: 'Jordan Mills',role: 'Content Designer',  initials: 'JM', hue: 220 },
];

const BUDGET_TOTAL = 85000;
const BUDGET_SPENT = 31000;
const BUDGET_PCT   = Math.round((BUDGET_SPENT / BUDGET_TOTAL) * 100);
const BUDGET_SCALE = BUDGET_SPENT / BUDGET_TOTAL; // ~0.365

const FORM_DEFAULT: AddTaskForm = {
  title: '', assignee: '', priority: 'Med', dueDate: '', description: '',
};

// ── Count-up hook (ease-out-quart) ─────────────────────────────

function useCountUp(target: number, duration = 900, enabled = true): number {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 4); // ease-out-quart
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

export default function ProjectOverviewV4() {
  const [tasks, setTasks]       = useState<Task[]>(INITIAL_TASKS);
  const [sortKey, setSortKey]   = useState<SortKey>('dueDate');
  const [sortDir, setSortDir]   = useState<SortDir>('asc');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm]         = useState<AddTaskForm>(FORM_DEFAULT);
  const [mounted, setMounted]   = useState(false);

  const modalRef      = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLInputElement>(null);

  // Trigger entrance animations after first paint
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const budgetDisplay = useCountUp(BUDGET_SPENT, 900, mounted);

  const handleSort = useCallback((key: SortKey) => {
    setSortDir(prev =>
      sortKey === key ? (prev === 'asc' ? 'desc' : 'asc') : 'asc'
    );
    setSortKey(key);
  }, [sortKey]);

  const sorted = sortTasks(tasks, sortKey, sortDir);
  const overdueCount = tasks.filter(t => t.overdue).length;
  const doneCount    = tasks.filter(t => t.status === 'Done').length;

  // Modal: Escape + focus trap
  useEffect(() => {
    if (!showModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setShowModal(false); setForm(FORM_DEFAULT); return; }
      if (e.key === 'Tab' && modalRef.current) {
        const els = modalRef.current.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!els.length) return;
        const first = els[0];
        const last  = els[els.length - 1];
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

  const closeModal = () => { setShowModal(false); setForm(FORM_DEFAULT); };

  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) closeModal();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    const rawDate    = form.dueDate ? new Date(form.dueDate + 'T00:00:00') : null;
    const dueLabel   = rawDate
      ? rawDate.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
      : 'No date';
    const dueDateSort = rawDate ? Number(form.dueDate.replace(/-/g, '')) : 99999999;
    const isoTime     = rawDate ? rawDate.toISOString() : new Date().toISOString();

    setTasks(prev => [
      ...prev,
      {
        id: `t${Date.now()}`,
        title: form.title.trim(),
        assignee: form.assignee || 'Unassigned',
        priority: form.priority,
        status: 'To Do',
        dueDate: dueLabel,
        dueDateSort,
        overdue: false,
      },
    ]);
    closeModal();
    void isoTime; // suppress unused var
  };

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className={`pov4-shell${mounted ? ' pov4-mounted' : ''}`}>

      {/* ── Top navigation bar ────────────────────────────────── */}
      <nav className="pov4-topbar" aria-label="Application navigation">
        <div className="pov4-topbar-inner">
          <div className="pov4-brand" role="img" aria-label="Acme Studio">
            <span className="pov4-brand-mark" aria-hidden="true">AF</span>
            <span className="pov4-brand-name">ACME</span>
          </div>

          <nav className="pov4-breadcrumb" aria-label="Page breadcrumb">
            <span className="pov4-crumb">Projects</span>
            <span className="pov4-crumb-sep" aria-hidden="true">›</span>
            <span className="pov4-crumb pov4-crumb-current" aria-current="page">
              Meridian Campaign
            </span>
          </nav>

          <div className="pov4-topbar-end">
            <div
              className="pov4-user-chip"
              role="img"
              aria-label="Signed in as Alex Walsh"
            >
              <span className="pov4-user-avatar" aria-hidden="true">LW</span>
              <span className="pov4-user-name">Alex</span>
            </div>
          </div>
        </div>
      </nav>

      {/* ── Main content ──────────────────────────────────────── */}
      <main className="pov4-content">

        {/* Project header */}
        <header className="pov4-header pov4-enter pov4-enter-1">
          <div className="pov4-header-row">
            <div className="pov4-header-left">
              <h1 className="pov4-project-name">Meridian Campaign</h1>
              <div className="pov4-header-meta">
                <span className="pov4-client-label">Acme Events</span>
                <span className="pov4-meta-sep" aria-hidden="true">·</span>
                <span
                  className="pov4-status-badge pov4-status-at-risk"
                  role="status"
                  aria-label="Project status: At Risk"
                >
                  <span className="pov4-status-dot" aria-hidden="true" />
                  At Risk
                </span>
                <span className="pov4-meta-sep" aria-hidden="true">·</span>
                <span className="pov4-meta-item">
                  Deadline <strong>Apr 20</strong>
                </span>
                <span className="pov4-meta-sep" aria-hidden="true">·</span>
                <span className="pov4-meta-item">
                  <span className="pov4-tabnum">{doneCount}/{tasks.length}</span> tasks done
                </span>
              </div>
            </div>
          </div>

          {/* Overdue alert strip */}
          {overdueCount > 0 && (
            <div className="pov4-overdue-strip" role="alert">
              <span className="pov4-overdue-icon" aria-hidden="true" role="presentation">⚠</span>
              <span className="pov4-overdue-body">
                <strong>Campaign strategy document</strong> is overdue — was due Apr 1
              </span>
              <span className="pov4-overdue-pill">{overdueCount} overdue</span>
            </div>
          )}
        </header>

        {/* Content grid */}
        <div className="pov4-layout">

          {/* ─ Main column ──────────────────────────────────── */}
          <div className="pov4-main">

            {/* Budget — inline pair, no card */}
            <section
              className="pov4-budget pov4-enter pov4-enter-2"
              aria-label="Project budget"
            >
              <div className="pov4-budget-row">
                <span className="pov4-section-label">BUDGET</span>
                <div className="pov4-budget-nums">
                  <span
                    className="pov4-budget-spent pov4-tabnum"
                    aria-label={`Spent: $${BUDGET_SPENT.toLocaleString()}`}
                  >
                    ${budgetDisplay.toLocaleString()}
                  </span>
                  <span className="pov4-budget-of" aria-hidden="true"> / </span>
                  <span className="pov4-budget-total pov4-tabnum">
                    ${BUDGET_TOTAL.toLocaleString()}
                  </span>
                </div>
                <span className="pov4-budget-pct pov4-tabnum">{BUDGET_PCT}%</span>
              </div>
              <div
                className="pov4-budget-track"
                role="progressbar"
                aria-valuenow={BUDGET_PCT}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${BUDGET_PCT}% of budget used`}
              >
                <div
                  className={`pov4-budget-fill${mounted ? ' pov4-fill-in' : ''}`}
                  style={{ '--scale-x': String(BUDGET_SCALE) } as React.CSSProperties}
                />
              </div>
            </section>

            {/* Task table */}
            <section
              className="pov4-tasks pov4-enter pov4-enter-3"
              aria-label="Task list"
            >
              <div className="pov4-tasks-head">
                <span className="pov4-section-label">TASKS</span>
                <span className="pov4-tasks-count pov4-tabnum">
                  {tasks.length} tasks · {overdueCount} overdue
                </span>
              </div>

              <div className="pov4-table-wrap">
                <table className="pov4-table" aria-label="Project tasks — click column headers to sort">
                  <thead>
                    <tr>
                      {(
                        [
                          ['title',    'TASK'],
                          ['assignee', 'ASSIGNEE'],
                          ['priority', 'PRIORITY'],
                          ['status',   'STATUS'],
                          ['dueDate',  'DUE'],
                        ] as [SortKey, string][]
                      ).map(([key, label]) => (
                        <th
                          key={key}
                          scope="col"
                          aria-sort={
                            sortKey === key
                              ? (sortDir === 'asc' ? 'ascending' : 'descending')
                              : 'none'
                          }
                        >
                          <button
                            className={`pov4-sort-btn${sortKey === key ? ' pov4-sort-on' : ''}`}
                            onClick={() => handleSort(key)}
                          >
                            {label}
                            <span className="pov4-sort-arrow" aria-hidden="true">
                              {sortKey === key ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
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
                          'pov4-row',
                          task.overdue          ? 'pov4-row-overdue' : '',
                          task.status === 'Done'? 'pov4-row-done'    : '',
                        ].filter(Boolean).join(' ')}
                        style={{ '--row-delay': `${idx * 25}ms` } as React.CSSProperties}
                      >
                        {/* Title cell — inner div for flex (td stays table-cell) */}
                        <td className="pov4-col-title">
                          <div className="pov4-title-cell">
                            {task.overdue && (
                              <span className="pov4-overdue-dot" aria-hidden="true" />
                            )}
                            <span className="pov4-task-name" title={task.title}>
                              {task.title}
                            </span>
                          </div>
                        </td>

                        <td className="pov4-col-assignee">
                          <div className="pov4-assignee-cell">
                            <span
                              className="pov4-avatar-xs"
                              aria-hidden="true"
                              title={task.assignee}
                            >
                              {task.assignee.split(' ').map(n => n[0]).join('')}
                            </span>
                            <span className="pov4-assignee-name">
                              {task.assignee.split(' ')[0]}
                            </span>
                          </div>
                        </td>

                        <td>
                          <span
                            className={`pov4-priority-badge pov4-pri-${task.priority.toLowerCase()}`}
                          >
                            {task.priority}
                          </span>
                        </td>

                        <td>
                          <span
                            className={`pov4-status-pill pov4-st-${
                              task.status.replace(/\s+/g, '-').toLowerCase()
                            }`}
                          >
                            {task.status}
                          </span>
                        </td>

                        <td
                          className={`pov4-col-due pov4-tabnum${
                            task.overdue ? ' pov4-due-overdue' : ''
                          }`}
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

          {/* ─ Sidebar ──────────────────────────────────────── */}
          <aside className="pov4-sidebar" aria-label="Project details">

            {/* Activity feed */}
            <section
              className="pov4-activity pov4-enter pov4-enter-2"
              aria-label="Recent activity"
            >
              <span className="pov4-section-label">RECENT ACTIVITY</span>
              <ul className="pov4-feed" role="list">
                {ACTIVITY.map((entry, idx) => (
                  <li
                    key={entry.id}
                    className="pov4-feed-item"
                    style={{ '--feed-delay': `${idx * 40 + 120}ms` } as React.CSSProperties}
                  >
                    <span className="pov4-feed-avatar" aria-hidden="true">
                      {entry.initials}
                    </span>
                    <div className="pov4-feed-body">
                      <p className="pov4-feed-text">
                        <strong className="pov4-feed-user">{entry.user}</strong>{' '}
                        {entry.action}
                      </p>
                      <time className="pov4-feed-time" dateTime={entry.isoTime}>
                        {entry.timestamp}
                      </time>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {/* Team */}
            <section
              className="pov4-team pov4-enter pov4-enter-3"
              aria-label="Team members"
            >
              <div className="pov4-team-head">
                <span className="pov4-section-label">TEAM</span>
                <span className="pov4-team-meta pov4-tabnum">
                  {TEAM.length} members · 41 hrs/wk
                </span>
              </div>
              <ul className="pov4-team-list" role="list">
                {TEAM.map(member => (
                  <li key={member.id} className="pov4-team-item">
                    <span
                      className="pov4-team-avatar"
                      style={{ '--m-hue': String(member.hue) } as React.CSSProperties}
                      aria-hidden="true"
                      title={member.name}
                    >
                      {member.initials}
                    </span>
                    <div className="pov4-team-info">
                      <span className="pov4-team-name">{member.name}</span>
                      <span className="pov4-team-role">{member.role}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </main>

      {/* ── Floating Action Button ────────────────────────────── */}
      <button
        className={`pov4-fab${showModal ? ' pov4-fab-hidden' : ''}`}
        onClick={() => setShowModal(true)}
        aria-label="Add new task"
        title="New Task"
      >
        <span className="pov4-fab-icon" aria-hidden="true">+</span>
      </button>

      {/* ── Add Task Modal ─────────────────────────────────────── */}
      {showModal && (
        <div
          className="pov4-backdrop"
          onClick={handleBackdrop}
        >
          <div
            className="pov4-modal"
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pov4-modal-title"
          >
            <div className="pov4-modal-head">
              <h2 id="pov4-modal-title" className="pov4-modal-title">
                New Task
              </h2>
              <button
                className="pov4-modal-close"
                onClick={closeModal}
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>

            <form className="pov4-modal-form" onSubmit={handleSubmit} noValidate>
              <div className="pov4-field">
                <label htmlFor="pov4-f-title" className="pov4-field-label">
                  Title
                </label>
                <input
                  id="pov4-f-title"
                  ref={firstFocusRef}
                  className="pov4-input"
                  type="text"
                  placeholder="Task title"
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  required
                  autoComplete="off"
                />
              </div>

              <div className="pov4-field-row">
                <div className="pov4-field">
                  <label htmlFor="pov4-f-assignee" className="pov4-field-label">
                    Assignee
                  </label>
                  <select
                    id="pov4-f-assignee"
                    className="pov4-select"
                    value={form.assignee}
                    onChange={e => setForm(f => ({ ...f, assignee: e.target.value }))}
                  >
                    <option value="">Unassigned</option>
                    {TEAM.map(m => (
                      <option key={m.id} value={m.name}>{m.name}</option>
                    ))}
                  </select>
                </div>
                <div className="pov4-field">
                  <label htmlFor="pov4-f-priority" className="pov4-field-label">
                    Priority
                  </label>
                  <select
                    id="pov4-f-priority"
                    className="pov4-select"
                    value={form.priority}
                    onChange={e =>
                      setForm(f => ({ ...f, priority: e.target.value as Priority }))
                    }
                  >
                    {(['Low', 'Med', 'High', 'Urgent'] as Priority[]).map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="pov4-field">
                <label htmlFor="pov4-f-due" className="pov4-field-label">
                  Due Date
                </label>
                <input
                  id="pov4-f-due"
                  className="pov4-input"
                  type="date"
                  value={form.dueDate}
                  onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                />
              </div>

              <div className="pov4-field">
                <label htmlFor="pov4-f-desc" className="pov4-field-label">
                  Description
                </label>
                <textarea
                  id="pov4-f-desc"
                  className="pov4-textarea"
                  placeholder="Optional description…"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  rows={3}
                />
              </div>

              <div className="pov4-modal-actions">
                <button type="button" className="pov4-btn-ghost" onClick={closeModal}>
                  Cancel
                </button>
                <button type="submit" className="pov4-btn-primary">
                  Add Task
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
