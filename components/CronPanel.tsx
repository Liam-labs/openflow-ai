'use client';

import { useEffect, useState, useCallback } from 'react';
import { useEventStream } from '@/lib/contexts/EventStreamContext';
import type { CronJob, CronExecution } from '@/lib/types';
import {
  Clock,
  Play,
  Pause,
  Terminal,
  Globe,
  Send,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  RotateCw,
  ChevronDown,
  ChevronRight,
  Zap,
  History,
  Plus,
} from 'lucide-react';
import { CreateCronJobDialog } from './CreateCronJobDialog';

interface CronPanelProps {
  onJobCountChange?: (count: number) => void;
  onActiveCountChange?: (count: number) => void;
}

interface CronSSEData {
  type?: string;
  jobId?: string;
  jobName?: string;
  execution?: CronExecution;
}

const JOB_TYPE_ICONS: Record<string, typeof Terminal> = {
  shell: Terminal,
  'tmux-send': Send,
  'api-call': Globe,
};

const JOB_TYPE_LABELS: Record<string, string> = {
  shell: 'Shell',
  'tmux-send': 'Tmux',
  'api-call': 'API Call',
};

export function CronPanel({ onJobCountChange, onActiveCountChange }: CronPanelProps) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [jobHistory, setJobHistory] = useState<Record<string, CronExecution[]>>({});
  const [loadingHistory, setLoadingHistory] = useState<string | null>(null);
  const [triggeringJob, setTriggeringJob] = useState<string | null>(null);
  const [togglingJob, setTogglingJob] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // SSE subscription for real-time cron events
  const { data: sseData } = useEventStream<CronSSEData>('cron:status', {
    fallbackUrl: '/api/cron',
    fallbackInterval: 30000,
    fallbackTransform: (response: unknown) => {
      // Fallback polling returns the full job list
      const data = response as { jobs?: CronJob[] };
      if (data?.jobs) {
        setJobs(data.jobs);
      }
      return {} as CronSSEData;
    },
  });

  // Process SSE updates
  useEffect(() => {
    if (!sseData) return;
    // Refresh job list on any cron event
    fetchJobs();
  }, [sseData]);

  // Fetch all jobs
  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/cron');
      if (!res.ok) return;
      const data = await res.json();
      if (data.jobs) {
        setJobs(data.jobs);
      }
    } catch {
      // Silently ignore
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Report counts to parent
  useEffect(() => {
    onJobCountChange?.(jobs.length);
  }, [jobs, onJobCountChange]);

  useEffect(() => {
    onActiveCountChange?.(jobs.filter(j => j.enabled).length);
  }, [jobs, onActiveCountChange]);

  // Fetch execution history for a job
  const fetchHistory = async (jobId: string) => {
    setLoadingHistory(jobId);
    try {
      const res = await fetch(`/api/cron?history=${jobId}&limit=10`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.executions) {
        setJobHistory(prev => ({ ...prev, [jobId]: data.executions }));
      }
    } catch {
      // Silently ignore
    } finally {
      setLoadingHistory(null);
    }
  };

  // Toggle expand/collapse for a job
  const toggleExpand = (jobId: string) => {
    if (expandedJob === jobId) {
      setExpandedJob(null);
    } else {
      setExpandedJob(jobId);
      if (!jobHistory[jobId]) {
        fetchHistory(jobId);
      }
    }
  };

  // Trigger a job manually
  const triggerJob = async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTriggeringJob(jobId);
    try {
      await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trigger', jobId }),
      });
      // Refresh history if expanded
      if (expandedJob === jobId) {
        setTimeout(() => fetchHistory(jobId), 2000);
      }
      fetchJobs();
    } catch {
      // Silently ignore
    } finally {
      setTimeout(() => setTriggeringJob(null), 1500);
    }
  };

  // Toggle job enabled/disabled
  const toggleJob = async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTogglingJob(jobId);
    try {
      await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', jobId }),
      });
      fetchJobs();
    } catch {
      // Silently ignore
    } finally {
      setTimeout(() => setTogglingJob(null), 500);
    }
  };

  const formatRelative = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) {
      // Future time
      const absDiff = Math.abs(diff);
      if (absDiff < 60_000) return 'in <1m';
      if (absDiff < 3_600_000) return `in ${Math.floor(absDiff / 60_000)}m`;
      if (absDiff < 86_400_000) return `in ${Math.floor(absDiff / 3_600_000)}h`;
      return `in ${Math.floor(absDiff / 86_400_000)}d`;
    }
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  };

  const getStatusBadge = (job: CronJob) => {
    if (!job.enabled) {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-white/40 bg-white/5 border border-white/10">
          <Pause className="w-2.5 h-2.5" /> Paused
        </span>
      );
    }
    if (job.status === 'error' || (job.lastRunExitCode !== undefined && job.lastRunExitCode !== 0)) {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-red-400 bg-red-400/10 border border-red-400/25">
          <XCircle className="w-2.5 h-2.5" /> Error
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-green-400 bg-green-400/10 border border-green-400/25">
        <CheckCircle className="w-2.5 h-2.5" /> Active
      </span>
    );
  };

  const getExecStatusIcon = (status: CronExecution['status']) => {
    switch (status) {
      case 'success': return <CheckCircle className="w-3 h-3 text-green-400" />;
      case 'failed': return <XCircle className="w-3 h-3 text-red-400" />;
      case 'timeout': return <AlertTriangle className="w-3 h-3 text-amber-400" />;
      case 'running': return <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />;
    }
  };

  const isServiceJob = (job: CronJob) => job.tags?.some(t => t.startsWith('service:'));

  if (isLoading) {
    return (
      <div className="p-4 text-center text-muted text-sm">
        Loading cron jobs...
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <>
        <div className="text-center text-muted text-sm py-4 px-3">
          <Clock className="w-5 h-5 mx-auto mb-2 opacity-40" />
          <p>No cron jobs configured.</p>
          <p className="mt-1 text-xs opacity-60">
            Create jobs via the API or add <code className="bg-black/30 px-1 rounded">cronJobs</code> to a service config.
          </p>
          <button
            onClick={() => setShowCreateDialog(true)}
            className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/30 text-indigo-300 rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Job
          </button>
        </div>
        {showCreateDialog && (
          <CreateCronJobDialog
            onClose={() => setShowCreateDialog(false)}
            onCreated={() => { fetchJobs(); }}
          />
        )}
      </>
    );
  }

  const enabledJobs = jobs.filter(j => j.enabled);
  const disabledJobs = jobs.filter(j => !j.enabled);
  const sortedJobs = [...enabledJobs, ...disabledJobs];

  return (
    <>
    {showCreateDialog && (
      <CreateCronJobDialog
        onClose={() => setShowCreateDialog(false)}
        onCreated={() => { fetchJobs(); }}
      />
    )}
    <div className="p-3 space-y-1.5">
      {/* Summary badges */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-xs text-white/50">
          {enabledJobs.length} active / {jobs.length} total
        </span>
        {jobs.some(j => j.lastRunExitCode !== undefined && j.lastRunExitCode !== 0) && (
          <span className="inline-flex items-center gap-1 text-xs text-red-400">
            <AlertTriangle className="w-3 h-3" />
            {jobs.filter(j => j.lastRunExitCode !== undefined && j.lastRunExitCode !== 0).length} with errors
          </span>
        )}
        <button
          onClick={() => setShowCreateDialog(true)}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-[11px] bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/25 text-indigo-300/80 hover:text-indigo-300 rounded-lg transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add Job
        </button>
      </div>

      {/* Job list */}
      {sortedJobs.map(job => {
        const TypeIcon = JOB_TYPE_ICONS[job.jobType] || Terminal;
        const isExpanded = expandedJob === job.id;
        const history = jobHistory[job.id] || [];
        const svcJob = isServiceJob(job);

        return (
          <div
            key={job.id}
            className={`rounded border transition-colors ${
              !job.enabled
                ? 'border-white/5 bg-white/[0.02] opacity-60'
                : job.status === 'error'
                  ? 'border-red-500/15 bg-red-500/[0.03]'
                  : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.05]'
            }`}
          >
            {/* Job header */}
            <button
              onClick={() => toggleExpand(job.id)}
              className="w-full flex items-center gap-2 px-2.5 py-2 text-left"
            >
              {isExpanded
                ? <ChevronDown className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
                : <ChevronRight className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
              }
              <TypeIcon className="w-3.5 h-3.5 text-white/50 flex-shrink-0" />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-white/80 truncate">
                    {job.name}
                  </span>
                  {getStatusBadge(job)}
                  {svcJob && (
                    <span className="text-[10px] text-white/30 px-1 py-0.5 bg-white/5 rounded">
                      service
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-[10px] text-white/40">
                  <span className="font-mono">{job.schedule}</span>
                  <span>{JOB_TYPE_LABELS[job.jobType]}</span>
                  {job.lastRun && (
                    <span>Last: {formatRelative(job.lastRun)}</span>
                  )}
                  {job.nextRun && job.enabled && (
                    <span>Next: {formatRelative(job.nextRun)}</span>
                  )}
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={(e) => triggerJob(job.id, e)}
                  disabled={!!triggeringJob}
                  className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-blue-400 transition-colors disabled:opacity-30"
                  title="Run now"
                >
                  {triggeringJob === job.id
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Zap className="w-3.5 h-3.5" />
                  }
                </button>
                <button
                  onClick={(e) => toggleJob(job.id, e)}
                  disabled={!!togglingJob}
                  className={`p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-30 ${
                    job.enabled ? 'text-green-400 hover:text-amber-400' : 'text-white/30 hover:text-green-400'
                  }`}
                  title={job.enabled ? 'Pause' : 'Enable'}
                >
                  {togglingJob === job.id
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : job.enabled
                      ? <Pause className="w-3.5 h-3.5" />
                      : <Play className="w-3.5 h-3.5" />
                  }
                </button>
              </div>
            </button>

            {/* Expanded detail */}
            {isExpanded && (
              <div className="border-t border-white/5 px-3 py-2 space-y-2">
                {/* Job details */}
                {job.description && (
                  <p className="text-xs text-white/50">{job.description}</p>
                )}

                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                  {job.command && (
                    <div className="col-span-2">
                      <span className="text-white/40">Command: </span>
                      <code className="text-white/70 bg-black/30 px-1 rounded text-[10px]">{job.command}</code>
                    </div>
                  )}
                  {job.tmuxTarget && (
                    <div>
                      <span className="text-white/40">Target: </span>
                      <span className="text-white/70">{job.tmuxTarget}</span>
                    </div>
                  )}
                  {job.apiUrl && (
                    <div className="col-span-2">
                      <span className="text-white/40">URL: </span>
                      <span className="text-white/70">{job.apiMethod || 'GET'} {job.apiUrl}</span>
                    </div>
                  )}
                  {job.lastRunDurationMs !== undefined && (
                    <div>
                      <span className="text-white/40">Last duration: </span>
                      <span className="text-white/70">{formatDuration(job.lastRunDurationMs)}</span>
                    </div>
                  )}
                  {job.lastRunError && (
                    <div className="col-span-2">
                      <span className="text-red-400/80">Error: </span>
                      <span className="text-red-400/60 text-[10px]">{job.lastRunError}</span>
                    </div>
                  )}
                  {job.tags && job.tags.length > 0 && (
                    <div className="col-span-2">
                      <span className="text-white/40">Tags: </span>
                      {job.tags.map(tag => (
                        <span key={tag} className="inline-block mr-1 px-1 py-0.5 bg-white/5 rounded text-[10px] text-white/40">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Execution history */}
                <div className="mt-2">
                  <div className="flex items-center gap-1.5 text-[11px] text-white/50 mb-1.5">
                    <History className="w-3 h-3" />
                    <span>Recent Executions</span>
                    <button
                      onClick={() => fetchHistory(job.id)}
                      className="ml-auto text-white/30 hover:text-white/60 transition-colors"
                      title="Refresh history"
                    >
                      <RotateCw className={`w-3 h-3 ${loadingHistory === job.id ? 'animate-spin' : ''}`} />
                    </button>
                  </div>

                  {loadingHistory === job.id && history.length === 0 ? (
                    <div className="text-[10px] text-white/30 py-2 text-center">Loading...</div>
                  ) : history.length === 0 ? (
                    <div className="text-[10px] text-white/30 py-2 text-center">No executions yet</div>
                  ) : (
                    <div className="space-y-0.5 max-h-40 overflow-y-auto">
                      {history.slice().reverse().map(exec => (
                        <div
                          key={exec.id}
                          className="flex items-center gap-2 text-[10px] px-1.5 py-1 rounded bg-black/20"
                        >
                          {getExecStatusIcon(exec.status)}
                          <span className="text-white/50 font-mono w-14 flex-shrink-0">
                            {exec.trigger === 'manual' ? 'manual' : 'sched'}
                          </span>
                          <span className="text-white/60 flex-1 min-w-0 truncate">
                            {exec.status === 'success'
                              ? exec.durationMs !== undefined ? formatDuration(exec.durationMs) : 'ok'
                              : exec.error || exec.output?.slice(0, 80) || exec.status
                            }
                          </span>
                          <span className="text-white/30 flex-shrink-0" title={exec.startedAt}>
                            {formatRelative(exec.startedAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
    </>
  );
}
