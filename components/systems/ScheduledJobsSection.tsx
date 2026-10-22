'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { Play, Pause, Trash2, Zap, RefreshCw, Plus } from 'lucide-react';
import { DataTable, StatusBadge } from './DataTable';
import type { ColumnDef } from './DataTable';
import type { CronJob } from '@/lib/types';
import type { SystemsNavState } from './systems-types';
import { useEventStream } from '@/lib/contexts/EventStreamContext';
import { SectionLoadingSkeleton } from './SectionLoadingSkeleton';

interface CronStatusSSE {
  jobs: CronJob[];
  enabledCount: number;
  timestamp: string;
}

interface ScheduledJobsSectionProps {
  onNavigate?: (state: Partial<SystemsNavState>) => void;
}

export function ScheduledJobsSection({ onNavigate }: ScheduledJobsSectionProps) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // SSE live updates — fires on cron job changes (10s interval from server)
  const { data: sseData } = useEventStream<CronStatusSSE>('cron:status', {
    fallbackUrl: '/api/cron',
    fallbackInterval: 15000,
    fallbackTransform: (res) => res as CronStatusSSE,
  });
  useEffect(() => {
    if (!sseData?.jobs) return;
    setJobs(sseData.jobs);
    setLoading(false);
  }, [sseData]);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/cron');
      const data = await res.json();
      setJobs(data.jobs ?? []);
      setError(null);
    } catch {
      setError('Failed to load scheduled jobs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const triggerJob = async (id: string) => {
    setActionLoading(id);
    try {
      await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trigger', jobId: id }),
      });
      await fetchJobs();
    } finally {
      setActionLoading(null);
    }
  };

  const toggleJob = async (id: string, enabled: boolean) => {
    setActionLoading(id);
    try {
      await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: enabled ? 'disable' : 'enable', jobId: id }),
      });
      await fetchJobs();
    } finally {
      setActionLoading(null);
    }
  };

  const deleteJob = async (id: string) => {
    if (!confirm('Delete this scheduled job?')) return;
    setActionLoading(id);
    try {
      await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', jobId: id }),
      });
      await fetchJobs();
    } finally {
      setActionLoading(null);
    }
  };

  const columns: ColumnDef<CronJob>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      render: (job) => (
        <div className="sjs-name-cell">
          <span className="sjs-name">{job.name}</span>
          {job.description && <span className="sjs-desc">{job.description}</span>}
        </div>
      ),
      getValue: (job) => job.name,
    },
    {
      key: 'schedule',
      header: 'Schedule',
      sortable: false,
      render: (job) => <code className="sjs-schedule">{job.schedule}</code>,
    },
    {
      key: 'jobType',
      header: 'Type',
      sortable: true,
      render: (job) => (
        <span className="sjs-type-badge">{JOB_TYPE_LABELS[job.jobType] ?? job.jobType}</span>
      ),
      getValue: (job) => job.jobType,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (job) => (
        <StatusBadge
          status={job.enabled ? (job.status === 'error' ? 'errored' : 'active') : 'stopped'}
          label={job.enabled ? (job.status === 'error' ? 'Error' : 'Active') : 'Paused'}
        />
      ),
      getValue: (job) => job.status,
    },
    {
      key: 'lastRun',
      header: 'Last Run',
      sortable: true,
      render: (job) => (
        <span className="sjs-time">{job.lastRun ? formatRelative(job.lastRun) : '—'}</span>
      ),
      getValue: (job) => job.lastRun ?? '',
    },
    {
      key: 'nextRun',
      header: 'Next Run',
      sortable: true,
      render: (job) => (
        <span className="sjs-time">{job.nextRun ? formatRelative(job.nextRun) : '—'}</span>
      ),
      getValue: (job) => job.nextRun ?? '',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (job) => {
        const busy = actionLoading === job.id;
        return (
          <div className="sjs-actions">
            <button
              className="sjs-action sjs-action--trigger"
              onClick={(e) => { e.stopPropagation(); triggerJob(job.id); }}
              disabled={busy}
              title="Run now"
            >
              {busy ? <RefreshCw size={12} className="sjs-spin" /> : <Zap size={12} />}
            </button>
            <button
              className={`sjs-action ${job.enabled ? 'sjs-action--pause' : 'sjs-action--resume'}`}
              onClick={(e) => { e.stopPropagation(); toggleJob(job.id, job.enabled); }}
              disabled={busy}
              title={job.enabled ? 'Pause' : 'Resume'}
            >
              {job.enabled ? <Pause size={12} /> : <Play size={12} />}
            </button>
            <button
              className="sjs-action sjs-action--delete"
              onClick={(e) => { e.stopPropagation(); deleteJob(job.id); }}
              disabled={busy}
              title="Delete"
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      },
    },
  ];

  if (loading) return <SectionLoadingSkeleton rows={6} />;

  return (
    <div className="systems-section">
      <div className="systems-section__header">
        <div className="systems-section__title-group">
          <h2 className="systems-section__title">Scheduled Jobs</h2>
          <span className="systems-section__count">{jobs.length}</span>
        </div>
        <div className="systems-section__toolbar">
          <button className="systems-section__btn" onClick={fetchJobs} title="Refresh">
            <RefreshCw size={13} />
          </button>
          <button
            className="systems-section__btn systems-section__btn--primary"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={13} />
            <span>New Job</span>
          </button>
        </div>
      </div>


      <p className="systems-section__desc">Cron-based automation tasks. Schedule, monitor, and troubleshoot recurring jobs across the system.</p>      <DataTable
        columns={columns}
        data={jobs}
        rowKey={(job) => job.id}
        onRowClick={(job) => onNavigate?.({ section: 'scheduled-jobs', entityId: job.id, entityType: 'scheduled-job', tab: 'overview' })}
        pageSize={15}
        initialSort={{ key: 'name', direction: 'asc' }}
        emptyMessage={error ?? 'No scheduled jobs found'}
        footer={
          error ? (
            <div className="systems-section__error">{error}</div>
          ) : undefined
        }
      />

      {showCreate && (
        <CreateJobModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); fetchJobs(); }}
        />
      )}
    </div>
  );
}

// ─── Create Job Modal ────────────────────────────────────────────────────────

interface CreateJobModalProps {
  onClose: () => void;
  onCreated: () => void;
}

function CreateJobModal({ onClose, onCreated }: CreateJobModalProps) {
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('0 4 * * *');
  const [jobType, setJobType] = useState<'shell' | 'tmux-send' | 'api-call'>('shell');
  const [command, setCommand] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !command.trim()) { setErr('Name and command are required.'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name, schedule, jobType, command }),
      });
      const data = await res.json();
      if (!data.success) { setErr(data.error ?? 'Failed to create job'); return; }
      onCreated();
    } catch {
      setErr('Failed to create job');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="systems-modal-overlay" onClick={onClose}>
      <div className="systems-modal" onClick={(e) => e.stopPropagation()}>
        <div className="systems-modal__header">
          <h3>New Scheduled Job</h3>
          <button className="systems-modal__close" onClick={onClose}>✕</button>
        </div>
        <form className="systems-modal__form" onSubmit={submit}>
          <label className="systems-modal__label">
            Name
            <input className="glass-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly cleanup" />
          </label>
          <label className="systems-modal__label">
            Schedule (cron)
            <input className="glass-input font-mono" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 4 * * *" />
          </label>
          <label className="systems-modal__label">
            Type
            <select className="glass-input" value={jobType} onChange={(e) => setJobType(e.target.value as 'shell' | 'tmux-send' | 'api-call')}>
              <option value="shell">Shell</option>
              <option value="tmux-send">Tmux Send</option>
              <option value="api-call">API Call</option>
            </select>
          </label>
          <label className="systems-modal__label">
            Command
            <input className="glass-input font-mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="bash /home/you/scripts/cleanup.sh" />
          </label>
          {err && <p className="systems-modal__error">{err}</p>}
          <div className="systems-modal__footer">
            <button type="button" className="glass-button secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="glass-button primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create Job'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const JOB_TYPE_LABELS: Record<string, string> = {
  shell: 'Shell',
  'tmux-send': 'Tmux',
  'api-call': 'API',
};

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const abs = Math.abs(diff);
    const future = diff < 0;
    if (abs < 60_000) return future ? 'in <1m' : '<1m ago';
    if (abs < 3_600_000) return `${future ? 'in ' : ''}${Math.round(abs / 60_000)}m${future ? '' : ' ago'}`;
    if (abs < 86_400_000) return `${future ? 'in ' : ''}${Math.round(abs / 3_600_000)}h${future ? '' : ' ago'}`;
    return `${future ? 'in ' : ''}${Math.round(abs / 86_400_000)}d${future ? '' : ' ago'}`;
  } catch {
    return iso;
  }
}
