'use client';

import { useState, useEffect } from 'react';
import { PM2Process, Project, WatchdogState, CronJob } from '@/lib/types';
import { getStatusColor } from '@/lib/pm2-utils';
import { PM2MetricBar } from './PM2MetricBar';
import {
  ChevronRight,
  ChevronDown,
  Square,
  RotateCw,
  ExternalLink,
  Loader2,
  AlertTriangle,
  Play,
  Settings,
  Check,
  X,
  Eye,
  Shield,
  Clock,
  Zap,
  Wand2,
} from 'lucide-react';

interface PM2ProcessRowProps {
  process: PM2Process | null;
  project?: Project | null;
  portConflict?: { port: number; ownedBy: string } | null;
  onStop: (name: string) => Promise<void>;
  onRestart: (name: string) => Promise<void>;
  onStart: (name: string) => Promise<void>;
  onStartConfigured?: () => Promise<void>;
  onPortChange?: (projectId: string, newPort: number) => Promise<void>;
  isLoading?: boolean;
  watchdogState?: WatchdogState;
  serviceCronJobs?: CronJob[];
  onWatchdogToggle?: (projectId: string, enabled: boolean) => void;
}

export function PM2ProcessRow({
  process,
  project,
  portConflict,
  onStop,
  onRestart,
  onStart,
  onStartConfigured,
  onPortChange,
  isLoading = false,
  watchdogState,
  serviceCronJobs,
  onWatchdogToggle,
}: PM2ProcessRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editPort, setEditPort] = useState('');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSuccess, setSettingsSuccess] = useState(false);
  const [watchdogToggleLoading, setWatchdogToggleLoading] = useState(false);
  const [cronTriggerLoading, setCronTriggerLoading] = useState<string | null>(null);
  const [cronToggleLoading, setCronToggleLoading] = useState<string | null>(null);
  const [localCronJobs, setLocalCronJobs] = useState<CronJob[]>(serviceCronJobs || []);

  useEffect(() => {
    setLocalCronJobs(serviceCronJobs || []);
  }, [serviceCronJobs]);

  // Determine if this is a configured-only server (not in PM2 yet)
  const isConfiguredOnly = !process && project;

  // Get display values
  const name = process?.name || project?.server?.pm2Name || project?.name || 'Unknown';
  const status = process?.status || 'not_started';
  const isOnline = process?.status === 'online';
  const port = process?.port || project?.server?.port || null;
  const cwd = process?.cwd || project?.path || '';

  const handleAction = async (action: 'stop' | 'restart' | 'start') => {
    setActionLoading(action);
    try {
      if (action === 'stop') await onStop(name);
      else if (action === 'restart') await onRestart(name);
      else if (action === 'start') {
        if (isConfiguredOnly && onStartConfigured) {
          await onStartConfigured();
        } else {
          await onStart(name);
        }
      }
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className={`pm2-row ${expanded ? 'expanded' : ''}`}>
      {/* Main Row */}
      <div
        className="pm2-row-main"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Expand Icon */}
        <div className="pm2-cell pm2-cell-icon">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted" />
          )}
        </div>

        {/* Name */}
        <div className="pm2-cell pm2-cell-name">
          <span className="font-medium">{name}</span>
          {project && (
            <span className="text-xs text-muted ml-2">({project.name})</span>
          )}
          {project?.autoRegistered && (
            <span
              className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-500/10 text-sky-400/80 border border-sky-500/20"
              title="Auto-detected and registered by the PM2 discovery daemon"
            >
              <Wand2 className="w-2.5 h-2.5" />
              auto
            </span>
          )}
          {project?.portConflict && (
            <span
              className="inline-flex items-center gap-1 ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400/80 border border-amber-500/20"
              title={`Port ${project.portConflict.port} conflicts with "${project.portConflict.conflictsWith}"`}
            >
              <AlertTriangle className="w-2.5 h-2.5" />
              port conflict
            </span>
          )}
        </div>

        {/* Status */}
        <div className="pm2-cell pm2-cell-status">
          {isConfiguredOnly ? (
            <span className="pm2-status not-started">
              <span className="status-dot offline" />
              not started
            </span>
          ) : (
            <span className={`pm2-status ${status}`}>
              <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
              {status}
            </span>
          )}
          {(project?.server?.watchdog?.enabled || watchdogState?.enabled) && (
            <span className="ml-1.5" title={`Watchdog active${watchdogState?.restartCount ? ` (${watchdogState.restartCount} restarts)` : ''}`}>
              <Eye className={`w-3.5 h-3.5 ${
                watchdogState?.cooldownUntil && new Date(watchdogState.cooldownUntil) > new Date()
                  ? 'text-amber-400'
                  : watchdogState?.lastCheckStatus === 'offline' ? 'text-red-400' : 'text-cyan-400'
              }`} />
            </span>
          )}
        </div>

        {/* Port */}
        <div className="pm2-cell pm2-cell-port">
          {port ? (
            <span className={`font-mono text-sm ${portConflict ? 'text-amber-400' : ''}`}>
              :{port}
              {portConflict && <AlertTriangle className="w-3 h-3 inline ml-1 text-amber-400" />}
            </span>
          ) : (
            <span className="text-muted">--</span>
          )}
        </div>

        {/* CPU */}
        <div className="pm2-cell pm2-cell-cpu">
          {isOnline && process ? (
            <PM2MetricBar value={process.cpu} type="cpu" />
          ) : (
            <span className="text-muted text-sm">--</span>
          )}
        </div>

        {/* Memory */}
        <div className="pm2-cell pm2-cell-memory">
          {isOnline && process ? (
            <span className="text-sm tabular-nums">{process.memoryFormatted}</span>
          ) : (
            <span className="text-muted text-sm">--</span>
          )}
        </div>

        {/* Uptime */}
        <div className="pm2-cell pm2-cell-uptime">
          {isOnline && process ? (
            <span className="text-sm tabular-nums">{process.uptimeFormatted}</span>
          ) : (
            <span className="text-muted text-sm">--</span>
          )}
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="pm2-row-details">
          {/* Port Conflict Warning */}
          {portConflict && (
            <div className="pm2-conflict-warning">
              <AlertTriangle className="w-4 h-4" />
              <span>
                Port {portConflict.port} is in use by <strong>{portConflict.ownedBy}</strong>
              </span>
            </div>
          )}

          {/* Info */}
          <div className="pm2-details-info">
            <div className="pm2-details-item">
              <span className="text-muted">Path:</span>
              <span className="font-mono text-sm truncate">{cwd || '--'}</span>
            </div>
            {process && (
              <>
                <div className="pm2-details-item">
                  <span className="text-muted">Restarts:</span>
                  <span>{process.restarts}</span>
                </div>
                <div className="pm2-details-item">
                  <span className="text-muted">Mode:</span>
                  <span>{process.execMode}</span>
                </div>
                <div className="pm2-details-item">
                  <span className="text-muted">PID:</span>
                  <span className="font-mono">{process.pid || '--'}</span>
                </div>
              </>
            )}
            {isConfiguredOnly && project?.server && (
              <div className="pm2-details-item">
                <span className="text-muted">Start Command:</span>
                <span className="font-mono text-sm">{project.server.startCommand}</span>
              </div>
            )}
          </div>

          {/* Service Cron Jobs */}
          {localCronJobs.length > 0 && (
            <div className="mt-3 pt-2 border-t border-white/5">
              <div className="text-xs text-muted uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5">
                <Clock className="w-3 h-3" />
                Scheduled Jobs
              </div>
              <div className="space-y-1.5">
                {localCronJobs.map(job => (
                  <div key={job.id} className="flex items-center gap-2 text-xs bg-white/[0.02] rounded px-2 py-1.5 border border-white/[0.05]">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${job.enabled ? 'bg-green-400' : 'bg-gray-500'}`} />
                    <span className="flex-1 min-w-0 truncate text-white/80">{job.name.replace(/^\[.*?\]\s*/, '')}</span>
                    <span className="text-white/30 font-mono">{job.schedule}</span>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        setCronToggleLoading(job.id);
                        try {
                          const res = await fetch('/api/cron', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'toggle', jobId: job.id }),
                          });
                          const d = await res.json();
                          if (d.success && d.job) {
                            setLocalCronJobs(prev => prev.map(j => j.id === job.id ? { ...j, enabled: d.job.enabled } : j));
                          }
                        } catch {} finally { setCronToggleLoading(null); }
                      }}
                      disabled={cronToggleLoading === job.id}
                      className={`flex-shrink-0 p-1 rounded transition-colors ${job.enabled ? 'text-green-400 hover:bg-green-500/10' : 'text-white/30 hover:bg-white/5'}`}
                      title={job.enabled ? 'Disable' : 'Enable'}
                    >
                      {cronToggleLoading === job.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shield className={`w-3 h-3 ${job.enabled ? '' : 'opacity-40'}`} />}
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        setCronTriggerLoading(job.id);
                        try {
                          await fetch('/api/cron', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'trigger', jobId: job.id }),
                          });
                        } catch {} finally { setCronTriggerLoading(null); }
                      }}
                      disabled={cronTriggerLoading === job.id}
                      className="flex-shrink-0 p-1 rounded text-indigo-400 hover:bg-indigo-500/10 transition-colors"
                      title="Trigger now"
                    >
                      {cronTriggerLoading === job.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Watchdog Status */}
          {(project?.server?.watchdog || watchdogState) && (
            <div className="mt-3 pt-2 border-t border-white/5">
              <div className="text-xs text-muted uppercase tracking-wider font-semibold mb-2 flex items-center gap-2">
                <Eye className="w-3 h-3" />
                Watchdog
              </div>

              {/* Status row */}
              <div className="flex items-center gap-3 text-xs mb-2">
                {/* Toggle */}
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    const projectId = project?.id || name;
                    const newEnabled = !(watchdogState?.enabled ?? project?.server?.watchdog?.enabled ?? false);
                    setWatchdogToggleLoading(true);
                    try {
                      await onWatchdogToggle?.(projectId, newEnabled);
                    } finally { setWatchdogToggleLoading(false); }
                  }}
                  disabled={watchdogToggleLoading || !onWatchdogToggle}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md border transition-colors ${
                    (watchdogState?.enabled ?? project?.server?.watchdog?.enabled)
                      ? 'text-cyan-400 bg-cyan-400/10 border-cyan-400/25 hover:bg-cyan-400/15'
                      : 'text-white/40 bg-white/[0.03] border-white/10 hover:bg-white/[0.06]'
                  }`}
                  title="Toggle watchdog monitoring"
                >
                  {watchdogToggleLoading
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Eye className="w-3 h-3" />
                  }
                  {(watchdogState?.enabled ?? project?.server?.watchdog?.enabled) ? 'Watching' : 'Off'}
                </button>

                {/* Stats */}
                {watchdogState && watchdogState.enabled && (
                  <>
                    {watchdogState.restartCount > 0 && (
                      <span className="text-white/50">
                        <RotateCw className="w-3 h-3 inline mr-1" />
                        {watchdogState.restartCount} restart{watchdogState.restartCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    {watchdogState.lastRestartAt && (
                      <span className="text-white/40">
                        Last: {new Date(watchdogState.lastRestartAt).toLocaleTimeString()}
                      </span>
                    )}
                    {watchdogState.cooldownUntil && new Date(watchdogState.cooldownUntil) > new Date() && (
                      <span className="text-amber-400">
                        <Clock className="w-3 h-3 inline mr-1" />
                        Cooldown until {new Date(watchdogState.cooldownUntil).toLocaleTimeString()}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Settings Panel */}
          {showSettings && onPortChange && (
            <div className="pm2-settings-panel" onClick={(e) => e.stopPropagation()}>
              <div className="pm2-settings-row">
                <label className="text-muted text-sm">Port:</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={editPort}
                    onChange={(e) => setEditPort(e.target.value)}
                    className="glass-input w-24 text-sm py-1 px-2"
                    placeholder="Port"
                  />
                  <button
                    className="pm2-action-btn pm2-action-start"
                    onClick={async () => {
                      const newPort = parseInt(editPort, 10);
                      if (!newPort || newPort < 1 || newPort > 65535) {
                        setSettingsError('Invalid port number');
                        return;
                      }
                      setSettingsError(null);
                      setSettingsSuccess(false);
                      setActionLoading('port');
                      try {
                        const projectId = project?.id || name;
                        await onPortChange(projectId, newPort);
                        setSettingsSuccess(true);
                        setTimeout(() => {
                          setShowSettings(false);
                          setSettingsSuccess(false);
                        }, 1500);
                      } catch (err) {
                        setSettingsError(err instanceof Error ? err.message : 'Failed to update port');
                      } finally {
                        setActionLoading(null);
                      }
                    }}
                    disabled={actionLoading === 'port'}
                  >
                    {actionLoading === 'port' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : settingsSuccess ? (
                      <Check className="w-4 h-4 text-green-400" />
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                    {settingsSuccess ? 'Saved' : 'Save'}
                  </button>
                  {settingsError && (
                    <span className="text-xs text-red-400">{settingsError}</span>
                  )}
                  {settingsSuccess && (
                    <span className="text-xs text-green-400">Port updated</span>
                  )}
                  {!project && !settingsError && !settingsSuccess && (
                    <span className="text-xs text-white/30">Creates config entry</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="pm2-actions">
            {isOnline && process ? (
              <>
                <button
                  className="pm2-action-btn pm2-action-stop"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAction('stop');
                  }}
                  disabled={isLoading || actionLoading !== null}
                >
                  {actionLoading === 'stop' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Square className="w-4 h-4" />
                  )}
                  Stop
                </button>
                <button
                  className="pm2-action-btn pm2-action-restart"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAction('restart');
                  }}
                  disabled={isLoading || actionLoading !== null}
                >
                  {actionLoading === 'restart' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RotateCw className="w-4 h-4" />
                  )}
                  Restart
                </button>
                {port && (
                  <a
                    href={`http://localhost:${port}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="pm2-action-btn pm2-action-open"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink className="w-4 h-4" />
                    Open :{port}
                  </a>
                )}
              </>
            ) : (
              <button
                className="pm2-action-btn pm2-action-start"
                onClick={(e) => {
                  e.stopPropagation();
                  handleAction('start');
                }}
                disabled={isLoading || actionLoading !== null || !!portConflict}
              >
                {actionLoading === 'start' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                Start
              </button>
            )}
            {/* Settings Cog - show for all processes */}
            {onPortChange && (
              <button
                className="pm2-action-btn pm2-action-settings"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditPort(String(project?.server?.port || port || ''));
                  const toggling = !showSettings;
                  setShowSettings(toggling);
                  if (toggling && !expanded) setExpanded(true);
                }}
                title="Server settings"
              >
                <Settings className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
