'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { RefreshCw, Plus, XCircle, Terminal, Clock, Cpu } from 'lucide-react';
import { DataTable, StatusBadge } from './DataTable';
import type { ColumnDef } from './DataTable';
import type { TerminalTask, TerminalTaskStatus, TerminalTaskEngine, TerminalTaskModel } from '@/lib/types';
import type { SystemsNavState } from './systems-types';
import { useEventStream } from '@/lib/contexts/EventStreamContext';
import { SectionLoadingSkeleton } from './SectionLoadingSkeleton';
import { JevSection } from './JevSection';

import { getHomeDir } from '@/lib/home-dir';
interface TerminalStatusSSE {
  tasks: Array<{
    id: string;
    status: TerminalTaskStatus;
    engine: TerminalTaskEngine;
    prompt: string;
    model: TerminalTaskModel;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
  }>;
  runningCount: number;
  timestamp: string;
}

interface AITasksSectionProps {
  onNavigate?: (state: Partial<SystemsNavState>) => void;
}

type AITasksTab = 'terminal' | 'jev';

export function AITasksSection({ onNavigate }: AITasksSectionProps) {
  const [tab, setTab] = useState<AITasksTab>('terminal');
  return (
    <div className="aits-tabbed">
      <div className="systems-tab-strip aits-tabs" role="tablist" aria-label="AI Tasks views">
        {([['terminal', 'Terminal Tasks'], ['jev', 'Jev']] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`systems-tab-strip__tab${tab === id ? ' systems-tab-strip__tab--active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'terminal' ? <TerminalTasksView onNavigate={onNavigate} /> : <JevSection />}
    </div>
  );
}

function TerminalTasksView({ onNavigate }: AITasksSectionProps) {
  const [tasks, setTasks] = useState<TerminalTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);
  const [cancelLoading, setCancelLoading] = useState<string | null>(null);

  // SSE live updates — fires on task status changes (5s interval from server)
  const { data: sseData } = useEventStream<TerminalStatusSSE>('terminal:status', {
    fallbackUrl: '/api/terminal-tasks',
    fallbackInterval: 10000,
    fallbackTransform: (res) => res as TerminalStatusSSE,
  });
  useEffect(() => {
    if (!sseData?.tasks) return;
    // Merge SSE summary into existing task state, preserving fields the summary omits
    setTasks(prev => {
      const sseMap = new Map(sseData.tasks.map(t => [t.id, t]));
      // Update existing tasks with fresh SSE data; append new tasks not yet in state
      const updated = prev.map(t => {
        const fresh = sseMap.get(t.id);
        return fresh ? { ...t, ...fresh } : t;
      });
      const existingIds = new Set(prev.map(t => t.id));
      const newTasks = sseData.tasks
        .filter(t => !existingIds.has(t.id))
        .map(t => ({ ...t, output: '', timeout: 0, createdBy: '' } as TerminalTask));
      return [...updated, ...newTasks];
    });
    setLoading(false);
  }, [sseData]);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/terminal-tasks');
      const data = await res.json();
      setTasks(data.tasks ?? []);
      setError(null);
    } catch {
      setError('Failed to load AI tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const cancelTask = async (id: string) => {
    setCancelLoading(id);
    try {
      await fetch('/api/terminal-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', taskId: id }),
      });
      await fetchTasks();
    } finally {
      setCancelLoading(null);
    }
  };

  const columns: ColumnDef<TerminalTask>[] = [
    {
      key: 'prompt',
      header: 'Prompt',
      sortable: false,
      render: (task) => (
        <div className="aits-prompt-cell">
          <span className="aits-prompt">{truncate(task.prompt, 80)}</span>
          {task.workingDirectory && (
            <span className="aits-workdir">{task.workingDirectory}</span>
          )}
        </div>
      ),
    },
    {
      key: 'engine',
      header: 'Engine',
      sortable: true,
      render: (task) => (
        <div className="aits-engine-cell">
          <span className="aits-engine">{ENGINE_LABELS[task.engine] ?? task.engine}</span>
          <span className="aits-model">{task.ollamaModel ?? MODEL_LABELS[task.model] ?? task.model}</span>
        </div>
      ),
      getValue: (task) => task.engine,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (task) => <StatusBadge status={mapTaskStatus(task.status)} label={STATUS_LABELS[task.status] ?? task.status} />,
      getValue: (task) => task.status,
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortable: true,
      render: (task) => <span className="aits-time">{formatTime(task.createdAt)}</span>,
      getValue: (task) => task.createdAt,
    },
    {
      key: 'duration',
      header: 'Duration',
      sortable: true,
      align: 'right',
      render: (task) => (
        <span className="aits-duration">
          {task.durationMs ? formatDuration(task.durationMs) : task.status === 'running' ? <RunningTimer startedAt={task.startedAt} /> : '—'}
        </span>
      ),
      getValue: (task) => task.durationMs ?? 0,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (task) => {
        const cancellable = task.status === 'running' || task.status === 'pending';
        if (!cancellable) return null;
        return (
          <button
            className="sjs-action sjs-action--delete"
            onClick={(e) => { e.stopPropagation(); cancelTask(task.id); }}
            disabled={cancelLoading === task.id}
            title="Cancel task"
          >
            {cancelLoading === task.id
              ? <RefreshCw size={12} className="sjs-spin" />
              : <XCircle size={12} />}
          </button>
        );
      },
    },
  ];

  if (loading) return <SectionLoadingSkeleton rows={5} />;

  return (
    <div className="systems-section">
      <div className="systems-section__header">
        <div className="systems-section__title-group">
          <h2 className="systems-section__title">AI Tasks</h2>
          <span className="systems-section__count">{tasks.length}</span>
        </div>
        <div className="systems-section__toolbar">
          <button className="systems-section__btn" onClick={fetchTasks} title="Refresh">
            <RefreshCw size={13} />
          </button>
          <button
            className="systems-section__btn systems-section__btn--primary"
            onClick={() => setShowSubmit(true)}
          >
            <Plus size={13} />
            <span>New Task</span>
          </button>
        </div>
      </div>


      <p className="systems-section__desc">Long-running Claude and AI terminal sessions. Submit prompts, track execution status, and review output.</p>      <DataTable
        columns={columns}
        data={tasks}
        rowKey={(t) => t.id}
        onRowClick={(t) => onNavigate?.({ section: 'ai-tasks', entityId: t.id, entityType: 'ai-task', tab: 'output' })}
        pageSize={15}
        initialSort={{ key: 'createdAt', direction: 'desc' }}
        emptyMessage={error ?? 'No AI tasks found'}
      />

      {showSubmit && (
        <SubmitTaskModal
          onClose={() => setShowSubmit(false)}
          onSubmitted={() => { setShowSubmit(false); fetchTasks(); }}
        />
      )}
    </div>
  );
}

// ─── Submit Task Modal ────────────────────────────────────────────────────────

interface SubmitTaskModalProps {
  onClose: () => void;
  onSubmitted: () => void;
}

function SubmitTaskModal({ onClose, onSubmitted }: SubmitTaskModalProps) {
  const [prompt, setPrompt] = useState('');
  const [engine, setEngine] = useState<'claude' | 'gemini' | 'ollama'>('claude');
  const [model, setModel] = useState<'haiku' | 'sonnet' | 'opus'>('haiku');
  const [workingDirectory, setWorkingDirectory] = useState(`${getHomeDir()}/SG-1`);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) { setErr('Prompt is required.'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/terminal-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit', prompt, engine, model, workingDirectory }),
      });
      const data = await res.json();
      if (!data.success) { setErr(data.error ?? 'Failed to submit task'); return; }
      onSubmitted();
    } catch {
      setErr('Failed to submit task');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="systems-modal-overlay" onClick={onClose}>
      <div className="systems-modal" onClick={(e) => e.stopPropagation()}>
        <div className="systems-modal__header">
          <h3>
            <Terminal size={14} />
            New AI Task
          </h3>
          <button className="systems-modal__close" onClick={onClose}>✕</button>
        </div>
        <form className="systems-modal__form" onSubmit={submit}>
          <label className="systems-modal__label">
            Prompt
            <textarea
              className="glass-input systems-modal__textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what you want the AI to do..."
              rows={4}
            />
          </label>
          <div className="systems-modal__row">
            <label className="systems-modal__label">
              Engine
              <select className="glass-input" value={engine} onChange={(e) => setEngine(e.target.value as 'claude' | 'gemini' | 'ollama')}>
                <option value="claude">Claude</option>
                <option value="gemini">Gemini</option>
                <option value="ollama">Ollama</option>
              </select>
            </label>
            {engine === 'claude' && (
              <label className="systems-modal__label">
                Model
                <select className="glass-input" value={model} onChange={(e) => setModel(e.target.value as 'haiku' | 'sonnet' | 'opus')}>
                  <option value="haiku">Haiku (fast)</option>
                  <option value="sonnet">Sonnet (balanced)</option>
                  <option value="opus">Opus (powerful)</option>
                </select>
              </label>
            )}
          </div>
          <label className="systems-modal__label">
            Working Directory
            <input className="glass-input font-mono" value={workingDirectory} onChange={(e) => setWorkingDirectory(e.target.value)} />
          </label>
          {err && <p className="systems-modal__error">{err}</p>}
          <div className="systems-modal__footer">
            <button type="button" className="glass-button secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="glass-button primary" disabled={saving}>
              {saving ? 'Submitting…' : 'Submit Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Running Timer ────────────────────────────────────────────────────────────

function RunningTimer({ startedAt }: { startedAt?: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const start = new Date(startedAt).getTime();
    const interval = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(interval);
  }, [startedAt]);
  return <span className="aits-running">{formatDuration(elapsed)}</span>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ENGINE_LABELS: Record<string, string> = { claude: 'Claude', gemini: 'Gemini', ollama: 'Ollama' };
const MODEL_LABELS: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending', running: 'Running', completed: 'Done',
  failed: 'Failed', timeout: 'Timeout', cancelled: 'Cancelled',
};

function mapTaskStatus(status: string): string {
  const map: Record<string, string> = {
    pending: 'pending', running: 'launching',
    completed: 'online', failed: 'errored', timeout: 'errored', cancelled: 'stopped',
  };
  return map[status] ?? 'unknown';
}

function truncate(str: string, max: number) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return iso; }
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
