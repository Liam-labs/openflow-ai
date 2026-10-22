'use client';

import React, { useState, useCallback, useEffect } from 'react';
import {
  Clock, Terminal, Globe, MessageSquare, RefreshCw,
  Play, Pause, Zap, Trash2, CheckCircle, XCircle, AlertTriangle,
} from 'lucide-react';
import { DataTable, StatusBadge } from './DataTable';
import type { ColumnDef } from './DataTable';
import type { CronJob, CronExecution } from '@/lib/types';
import type { SystemsNavState } from './systems-types';

interface ScheduledJobDetailProps {
  jobId: string;
  initialTab?: string;
  onNavigate?: (state: Partial<SystemsNavState>) => void;
}

type DetailTab = 'overview' | 'history' | 'config';

export function ScheduledJobDetail({ jobId, initialTab = 'overview', onNavigate }: ScheduledJobDetailProps) {
  const [job, setJob] = useState<CronJob | null>(null);
  const [executions, setExecutions] = useState<CronExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [tab, setTab] = useState<DetailTab>(initialTab as DetailTab);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/cron?jobId=${encodeURIComponent(jobId)}`);
      const data = await res.json();
      setJob(data.job ?? null);
    } catch {
      // handled by null state
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/cron?history=${encodeURIComponent(jobId)}&limit=50`);
      const data = await res.json();
      setExecutions(data.executions ?? []);
    } catch {
      setExecutions([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [jobId]);

  useEffect(() => { fetchJob(); }, [fetchJob]);
  useEffect(() => { if (tab === 'history') fetchHistory(); }, [tab, fetchHistory]);

  const runAction = async (action: string) => {
    setActionLoading(action);
    try {
      await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, jobId }),
      });
      await fetchJob();
      if (tab === 'history') fetchHistory();
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return <DetailSkeleton />;
  if (!job) return <NotFound entity="job" onBack={() => onNavigate?.({ section: 'scheduled-jobs', entityId: undefined })} />;

  return (
    <div className="detail-layout">
      {/* Header */}
      <div className="detail-header">
        <div className="detail-header__title-row">
          <div className="detail-header__title-group">
            <StatusBadge
              status={job.enabled ? (job.status === 'error' ? 'errored' : 'active') : 'stopped'}
              label={job.enabled ? (job.status === 'error' ? 'Error' : 'Active') : 'Paused'}
            />
            <h1 className="detail-header__title">{job.name}</h1>
            {job.description && <span className="detail-header__desc">{job.description}</span>}
          </div>
          <div className="detail-header__actions">
            <button
              className="systems-section__btn"
              onClick={() => runAction('trigger')}
              disabled={actionLoading !== null}
              title="Run now"
            >
              {actionLoading === 'trigger'
                ? <RefreshCw size={13} className="sjs-spin" />
                : <Zap size={13} />}
              <span>Run Now</span>
            </button>
            <button
              className="systems-section__btn"
              onClick={() => runAction(job.enabled ? 'disable' : 'enable')}
              disabled={actionLoading !== null}
            >
              {job.enabled ? <Pause size={13} /> : <Play size={13} />}
              <span>{job.enabled ? 'Pause' : 'Resume'}</span>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="detail-tabs" role="tablist">
          {(['overview', 'history', 'config'] as DetailTab[]).map((t) => (
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
        {tab === 'overview' && <JobOverviewTab job={job} />}
        {tab === 'history' && (
          <JobHistoryTab
            executions={executions}
            loading={historyLoading}
            onRefresh={fetchHistory}
          />
        )}
        {tab === 'config' && (
          <JobConfigTab job={job} onSaved={() => fetchJob()} />
        )}
      </div>
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function JobOverviewTab({ job }: { job: CronJob }) {
  const typeIcon = JOB_TYPE_ICONS[job.jobType];
  return (
    <div className="detail-overview">
      <div className="detail-meta-grid">
        <MetaSection title="Schedule">
          <MetaItem label="Expression" value={<code className="sjs-schedule">{job.schedule}</code>} />
          <MetaItem label="Next Run" value={job.nextRun ? formatDatetime(job.nextRun) : '—'} />
          <MetaItem label="Last Run" value={job.lastRun ? formatDatetime(job.lastRun) : 'Never'} />
          {job.lastRunDurationMs !== undefined && (
            <MetaItem label="Last Duration" value={formatDuration(job.lastRunDurationMs)} />
          )}
          {job.lastRunExitCode !== undefined && (
            <MetaItem
              label="Last Exit Code"
              value={
                <span style={{ color: job.lastRunExitCode === 0 ? 'var(--success)' : 'var(--error)' }}>
                  {job.lastRunExitCode}
                </span>
              }
            />
          )}
        </MetaSection>

        <MetaSection title="Configuration">
          <MetaItem label="Type" value={
            <span className="detail-type-badge">
              {typeIcon}
              {JOB_TYPE_LABELS[job.jobType] ?? job.jobType}
            </span>
          } />
          <MetaItem label="Enabled" value={job.enabled ? 'Yes' : 'No'} />
          {job.timeoutMs && <MetaItem label="Timeout" value={formatDuration(job.timeoutMs)} />}
          {job.tags && job.tags.length > 0 && (
            <MetaItem label="Tags" value={job.tags.join(', ')} />
          )}
          <MetaItem label="Created" value={formatDatetime(job.createdAt)} />
          <MetaItem label="Created By" value={job.createdBy} />
        </MetaSection>

        <MetaSection title="Command">
          {job.jobType === 'shell' && job.command && (
            <div className="detail-command-block">
              <pre className="detail-command">{job.command}</pre>
            </div>
          )}
          {job.jobType === 'tmux-send' && (
            <>
              {job.tmuxTarget && <MetaItem label="Target" value={<code className="detail-inline-code">{job.tmuxTarget}</code>} />}
              {job.tmuxText && <MetaItem label="Text" value={<code className="detail-inline-code">{job.tmuxText}</code>} />}
            </>
          )}
          {job.jobType === 'api-call' && (
            <>
              {job.apiUrl && <MetaItem label="URL" value={<code className="detail-inline-code">{job.apiUrl}</code>} />}
              {job.apiMethod && <MetaItem label="Method" value={job.apiMethod} />}
              {job.apiBody && (
                <div className="detail-command-block">
                  <pre className="detail-command">{job.apiBody}</pre>
                </div>
              )}
            </>
          )}
        </MetaSection>

        {job.lastRunError && (
          <MetaSection title="Last Error">
            <div className="detail-error-block">
              <AlertTriangle size={13} />
              <pre className="detail-error-text">{job.lastRunError}</pre>
            </div>
          </MetaSection>
        )}
      </div>
    </div>
  );
}

// ─── History Tab ──────────────────────────────────────────────────────────────

function JobHistoryTab({
  executions, loading, onRefresh,
}: {
  executions: CronExecution[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const columns: ColumnDef<CronExecution>[] = [
    {
      key: 'startedAt',
      header: 'Started',
      sortable: true,
      render: (e) => <span className="aits-time">{formatDatetime(e.startedAt)}</span>,
      getValue: (e) => e.startedAt,
    },
    {
      key: 'status',
      header: 'Result',
      sortable: true,
      render: (e) => (
        <div className="detail-exec-status">
          {e.status === 'success' ? (
            <CheckCircle size={13} style={{ color: 'var(--success)' }} />
          ) : e.status === 'failed' || e.status === 'timeout' ? (
            <XCircle size={13} style={{ color: 'var(--error)' }} />
          ) : (
            <RefreshCw size={13} style={{ color: 'var(--accent)' }} />
          )}
          <StatusBadge
            status={e.status === 'success' ? 'online' : e.status === 'running' ? 'launching' : 'errored'}
            label={e.status.charAt(0).toUpperCase() + e.status.slice(1)}
          />
        </div>
      ),
      getValue: (e) => e.status,
    },
    {
      key: 'durationMs',
      header: 'Duration',
      sortable: true,
      align: 'right',
      render: (e) => <span className="aits-duration">{e.durationMs ? formatDuration(e.durationMs) : '—'}</span>,
      getValue: (e) => e.durationMs ?? 0,
    },
    {
      key: 'trigger',
      header: 'Trigger',
      sortable: true,
      render: (e) => (
        <span className="sjs-type-badge">{e.trigger === 'manual' ? 'Manual' : 'Scheduled'}</span>
      ),
      getValue: (e) => e.trigger,
    },
    {
      key: 'exitCode',
      header: 'Exit',
      sortable: true,
      align: 'right',
      render: (e) => (
        e.exitCode !== undefined ? (
          <span style={{ color: e.exitCode === 0 ? 'var(--success)' : 'var(--error)', fontVariantNumeric: 'tabular-nums', fontSize: '12px' }}>
            {e.exitCode}
          </span>
        ) : <span className="aits-time">—</span>
      ),
      getValue: (e) => e.exitCode ?? -1,
    },
  ];

  return (
    <div className="detail-history">
      <div className="detail-history__toolbar">
        <button className="systems-section__btn" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={12} className={loading ? 'sjs-spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>
      <DataTable
        columns={columns}
        data={executions}
        rowKey={(e) => e.id}
        pageSize={20}
        initialSort={{ key: 'startedAt', direction: 'desc' }}
        emptyMessage={loading ? 'Loading history…' : 'No executions recorded yet'}
      />
    </div>
  );
}

// ─── Config Tab ───────────────────────────────────────────────────────────────

function JobConfigTab({ job, onSaved }: { job: CronJob; onSaved: () => void }) {
  const [name, setName] = useState(job.name);
  const [schedule, setSchedule] = useState(job.schedule);
  const [command, setCommand] = useState(job.command ?? job.tmuxText ?? job.apiBody ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      const res = await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', jobId: job.id, name, schedule, command }),
      });
      const data = await res.json();
      if (!data.success) { setErr(data.error ?? 'Save failed'); return; }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch {
      setErr('Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="detail-config">
      <form className="detail-config__form" onSubmit={save}>
        <label className="systems-modal__label">
          Name
          <input className="glass-input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="systems-modal__label">
          Schedule (cron expression)
          <input className="glass-input font-mono" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
        </label>
        {(job.jobType === 'shell' || job.jobType === 'tmux-send') && (
          <label className="systems-modal__label">
            {job.jobType === 'shell' ? 'Command' : 'Tmux Text'}
            <textarea
              className="glass-input systems-modal__textarea"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              rows={5}
            />
          </label>
        )}
        {err && <p className="systems-modal__error">{err}</p>}
        <div className="detail-config__footer">
          <button type="submit" className="glass-button primary" disabled={saving}>
            {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Changes'}
          </button>
        </div>
      </form>
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

function DetailSkeleton() {
  return (
    <div className="detail-layout">
      <div className="detail-skeleton-header" />
      <div className="detail-skeleton-content" />
    </div>
  );
}

function NotFound({ entity, onBack }: { entity: string; onBack?: () => void }) {
  return (
    <div className="detail-not-found">
      <AlertTriangle size={24} />
      <p>Could not find {entity}</p>
      {onBack && <button className="glass-button secondary" onClick={onBack}>← Back</button>}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const JOB_TYPE_LABELS: Record<string, string> = { shell: 'Shell', 'tmux-send': 'Tmux', 'api-call': 'API Call' };
const JOB_TYPE_ICONS: Record<string, React.ReactNode> = {
  shell: <Terminal size={12} />,
  'tmux-send': <MessageSquare size={12} />,
  'api-call': <Globe size={12} />,
};

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
