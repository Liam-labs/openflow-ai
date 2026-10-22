'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  Terminal, Cpu, Clock, RefreshCw, XCircle, AlertTriangle,
  Download, ChevronDown,
} from 'lucide-react';
import { StatusBadge } from './DataTable';
import type { TerminalTask } from '@/lib/types';
import type { SystemsNavState } from './systems-types';

interface AITaskDetailProps {
  taskId: string;
  initialTab?: string;
  onNavigate?: (state: Partial<SystemsNavState>) => void;
}

type DetailTab = 'output' | 'details';

export function AITaskDetail({ taskId, initialTab = 'output', onNavigate }: AITaskDetailProps) {
  const [task, setTask] = useState<TerminalTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DetailTab>(initialTab as DetailTab);
  const [cancelling, setCancelling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTask = useCallback(async () => {
    try {
      const res = await fetch('/api/terminal-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', taskId }),
      });
      const data = await res.json();
      setTask(data.task ?? null);
      return data.task as TerminalTask | null;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // Poll while running/pending
  useEffect(() => {
    fetchTask().then((t) => {
      if (t?.status === 'running' || t?.status === 'pending') {
        pollRef.current = setInterval(async () => {
          const updated = await fetchTask();
          if (updated?.status !== 'running' && updated?.status !== 'pending') {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          }
        }, 2000);
      }
    });
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchTask]);

  const cancelTask = async () => {
    setCancelling(true);
    try {
      await fetch('/api/terminal-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', taskId }),
      });
      await fetchTask();
    } finally {
      setCancelling(false);
    }
  };

  if (loading) return <TaskDetailSkeleton />;
  if (!task) return <TaskNotFound onBack={() => onNavigate?.({ section: 'ai-tasks', entityId: undefined })} />;

  const isLive = task.status === 'running' || task.status === 'pending';
  const statusMapped = mapStatus(task.status);

  return (
    <div className="detail-layout">
      {/* Header */}
      <div className="detail-header">
        <div className="detail-header__title-row">
          <div className="detail-header__title-group">
            <StatusBadge status={statusMapped} label={STATUS_LABELS[task.status] ?? task.status} />
            <span className="detail-header__title">{ENGINE_LABELS[task.engine] ?? task.engine}</span>
            <span className="detail-header__desc">{MODEL_LABELS[task.model] ?? task.model}</span>
          </div>
          <div className="detail-header__actions">
            {isLive && (
              <button
                className="systems-section__btn"
                onClick={cancelTask}
                disabled={cancelling}
                title="Cancel task"
              >
                {cancelling
                  ? <RefreshCw size={13} className="sjs-spin" />
                  : <XCircle size={13} />}
                <span>Cancel</span>
              </button>
            )}
            <button className="systems-section__btn" onClick={() => fetchTask()} title="Refresh">
              <RefreshCw size={13} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="detail-tabs" role="tablist">
          {(['output', 'details'] as DetailTab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`detail-tab${tab === t ? ' detail-tab--active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="detail-content">
        {tab === 'output' && <TaskOutputTab task={task} isLive={isLive} />}
        {tab === 'details' && <TaskDetailsTab task={task} />}
      </div>
    </div>
  );
}

// ─── Output Tab ───────────────────────────────────────────────────────────────

function TaskOutputTab({ task, isLive }: { task: TerminalTask; isLive: boolean }) {
  const outputRef = useRef<HTMLPreElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom while live
  useEffect(() => {
    if (autoScroll && outputRef.current && isLive) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [task.output, autoScroll, isLive]);

  const downloadOutput = () => {
    const blob = new Blob([task.output ?? ''], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `task-${task.id.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const hasOutput = task.output && task.output.trim().length > 0;
  const hasError = task.error && task.error.trim().length > 0;

  return (
    <div className="detail-output-layout">
      {/* Output toolbar */}
      <div className="detail-output-toolbar">
        <div className="detail-output-info">
          {isLive && (
            <span className="detail-output-live">
              <span className="detail-output-live__dot" />
              Live
            </span>
          )}
          {hasOutput && (
            <span className="detail-output-chars">
              {formatChars(task.output.length)}
            </span>
          )}
        </div>
        <div className="detail-output-controls">
          {isLive && (
            <label className="detail-output-autoscroll">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              Auto-scroll
            </label>
          )}
          {hasOutput && (
            <button className="systems-section__btn" onClick={downloadOutput} title="Download output">
              <Download size={12} />
            </button>
          )}
          {hasOutput && (
            <button
              className="systems-section__btn"
              onClick={() => outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' })}
              title="Scroll to bottom"
            >
              <ChevronDown size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Output pane */}
      {hasOutput ? (
        <pre ref={outputRef} className="detail-output-pane">
          {colorizeOutput(task.output)}
        </pre>
      ) : (
        <div className="detail-output-empty">
          {isLive ? (
            <>
              <RefreshCw size={20} className="sjs-spin" style={{ opacity: 0.4 }} />
              <span>Waiting for output…</span>
            </>
          ) : (
            <>
              <Terminal size={20} style={{ opacity: 0.3 }} />
              <span>No output</span>
            </>
          )}
        </div>
      )}

      {/* Error block */}
      {hasError && (
        <div className="detail-error-block detail-error-block--standalone">
          <AlertTriangle size={13} />
          <pre className="detail-error-text">{task.error}</pre>
        </div>
      )}
    </div>
  );
}

// ─── Details Tab ──────────────────────────────────────────────────────────────

function TaskDetailsTab({ task }: { task: TerminalTask }) {
  return (
    <div className="detail-overview">
      <div className="detail-meta-grid">
        <MetaSection title="Engine & Model">
          <MetaItem label="Engine" value={ENGINE_LABELS[task.engine] ?? task.engine} />
          <MetaItem label="Model" value={task.ollamaModel ?? MODEL_LABELS[task.model] ?? task.model} />
          <MetaItem label="Status" value={<StatusBadge status={mapStatus(task.status)} label={STATUS_LABELS[task.status]} />} />
        </MetaSection>

        <MetaSection title="Timing">
          <MetaItem label="Created" value={formatDatetime(task.createdAt)} />
          {task.startedAt && <MetaItem label="Started" value={formatDatetime(task.startedAt)} />}
          {task.completedAt && <MetaItem label="Completed" value={formatDatetime(task.completedAt)} />}
          {task.durationMs !== undefined && <MetaItem label="Duration" value={formatDuration(task.durationMs)} />}
          <MetaItem label="Timeout" value={`${task.timeout}s`} />
        </MetaSection>

        <MetaSection title="Metadata">
          <MetaItem label="Task ID" value={<code className="detail-inline-code">{task.id}</code>} />
          <MetaItem label="Created By" value={task.createdBy} />
          {task.workingDirectory && (
            <MetaItem label="Working Dir" value={<code className="detail-inline-code">{task.workingDirectory}</code>} />
          )}
          {task.pid && <MetaItem label="PID" value={String(task.pid)} />}
        </MetaSection>

        <MetaSection title="Prompt">
          <div className="detail-command-block">
            <pre className="detail-command">{task.prompt}</pre>
          </div>
        </MetaSection>

        {task.systemPrompt && (
          <MetaSection title="System Prompt">
            <div className="detail-command-block">
              <pre className="detail-command">{task.systemPrompt}</pre>
            </div>
          </MetaSection>
        )}
      </div>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function MetaSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="detail-meta-section">
      <h3 className="detail-meta-section__title">{title}</h3>
      <div className="detail-meta-section__body">{children}</div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="detail-meta-item">
      <span className="detail-meta-item__label">{label}</span>
      <span className="detail-meta-item__value">{value}</span>
    </div>
  );
}

function TaskDetailSkeleton() {
  return (
    <div className="detail-layout">
      <div className="detail-skeleton-header" />
      <div className="detail-skeleton-content" />
    </div>
  );
}

function TaskNotFound({ onBack }: { onBack?: () => void }) {
  return (
    <div className="detail-not-found">
      <AlertTriangle size={24} />
      <p>Task not found</p>
      {onBack && <button className="glass-button secondary" onClick={onBack}>← Back</button>}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ENGINE_LABELS: Record<string, string> = { claude: 'Claude', gemini: 'Gemini', ollama: 'Ollama' };
const MODEL_LABELS: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending', running: 'Running', completed: 'Done',
  failed: 'Failed', timeout: 'Timeout', cancelled: 'Cancelled',
};

function mapStatus(s: string): string {
  const m: Record<string, string> = {
    pending: 'pending', running: 'launching', completed: 'online',
    failed: 'errored', timeout: 'errored', cancelled: 'stopped',
  };
  return m[s] ?? 'unknown';
}

function formatDatetime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return iso; }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function formatChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

// Highlight ANSI-style patterns in output without a full ANSI parser
// (DevFlow output uses plain text — this just highlights key patterns)
function colorizeOutput(output: string): React.ReactNode {
  if (!output) return null;
  // Split on error/warning patterns and highlight
  const lines = output.split('\n');
  return lines.map((line, i) => {
    const isError = /\b(error|Error|ERROR|failed|FAILED|exception)\b/.test(line);
    const isWarning = /\b(warning|Warning|WARNING|warn|WARN)\b/.test(line);
    const isSuccess = /\b(success|Success|SUCCESS|done|Done|DONE|complete|Complete)\b/.test(line);
    const color = isError ? 'var(--error)' : isWarning ? 'var(--warning)' : isSuccess ? 'var(--success)' : undefined;
    return (
      <span key={i} style={color ? { color } : undefined}>
        {line}
        {i < lines.length - 1 ? '\n' : ''}
      </span>
    );
  });
}
