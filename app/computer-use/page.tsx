'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  Monitor,
  Wifi,
  WifiOff,
  Square,
  Check,
  RefreshCw,
  ArrowLeft,
  Loader2,
  Activity,
  MousePointer2,
  Keyboard,
  Camera,
  Scroll,
  Circle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Zap,
  X,
  Clock,
  User,
  Heart,
  Package,
  Terminal,
  Wand2,
} from 'lucide-react';
import { SetupWizardModal } from '@/components/SetupWizardModal';
import type {
  ComputerUseSession,
  ComputerUseTask,
  ComputerUseBridgeStatus,
  ComputerUseAction,
  ComputerUseActionType,
} from '@/lib/types';

// Lightweight session from list endpoint (no actions/screenshots)
type SessionListItem = Omit<ComputerUseSession, 'actions'> & {
  actionsCount: number;
  actions?: ComputerUseAction[]; // Only populated when expanded (lazy-loaded)
};

// Mirror of the structured progress shape returned by computer-use.task.status
// (server: app/api/agent/actions/computer-use.ts → computeTaskProgress).
// Computed client-side here because the agent API requires a Bearer token the
// browser doesn't have; the per-session GET on /api/computer-use is localhost-bypassed.
interface TaskProgress {
  actionsCount: number;
  lastAction: { type: ComputerUseActionType; timestamp: string } | null;
  elapsedMs: number;
  terminalState: boolean;
}

const STUCK_THRESHOLD_MS = 60_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function elapsedMs(startedAt: string): number {
  return Date.now() - new Date(startedAt).getTime();
}

function shortId(id: string): string {
  return id.slice(0, 10);
}

// ─── Action icon map ──────────────────────────────────────────────────────────

function ActionIcon({ type, className }: { type: ComputerUseActionType; className?: string }) {
  const cls = className ?? 'w-3.5 h-3.5';
  switch (type) {
    case 'screenshot': return <Camera className={cls} />;
    case 'click':
    case 'double_click':
    case 'right_click': return <MousePointer2 className={cls} />;
    case 'type':
    case 'key': return <Keyboard className={cls} />;
    case 'scroll': return <Scroll className={cls} />;
    case 'move': return <Activity className={cls} />;
    case 'drag': return <Activity className={cls} />;
    default: return <Circle className={cls} />;
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────

interface Toast {
  id: string;
  message: string;
  type: 'error' | 'success' | 'info';
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-3 px-4 py-3 rounded-xl border backdrop-blur-xl shadow-2xl ${
            t.type === 'error'
              ? 'bg-red-950/80 border-red-500/30 text-red-200'
              : t.type === 'success'
              ? 'bg-emerald-950/80 border-emerald-500/30 text-emerald-200'
              : 'bg-sky-950/80 border-sky-500/30 text-sky-200'
          }`}
          style={{ animation: 'slideUp 300ms cubic-bezier(0.16,1,0.3,1)' }}
        >
          {t.type === 'error' && <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          {t.type === 'success' && <Check className="w-4 h-4 mt-0.5 shrink-0" />}
          {t.type === 'info' && <Activity className="w-4 h-4 mt-0.5 shrink-0" />}
          <p className="text-sm flex-1">{t.message}</p>
          <button onClick={() => onDismiss(t.id)} className="text-white/40 hover:text-white/80 transition-colors shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function SessionStatusBadge({ status }: { status: ComputerUseSession['status'] }) {
  const configs = {
    active: { dot: 'bg-green-400 shadow-[0_0_6px_rgba(34,197,94,0.7)]', text: 'text-green-400', label: 'Active', pulse: true },
    closed: { dot: 'bg-white/30', text: 'text-white/40', label: 'Closed', pulse: false },
    error: { dot: 'bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.7)]', text: 'text-red-400', label: 'Error', pulse: false },
  };
  const cfg = configs[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cfg.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot} ${cfg.pulse ? 'animate-pulse' : ''}`} />
      {cfg.label}
    </span>
  );
}

function TaskStatusBadge({ status }: { status: ComputerUseTask['status'] }) {
  const configs = {
    running: { dot: 'bg-blue-400 shadow-[0_0_6px_rgba(59,130,246,0.7)]', text: 'text-blue-400', label: 'Running', pulse: true },
    completed: { dot: 'bg-green-400', text: 'text-green-400', label: 'Completed', pulse: false },
    failed: { dot: 'bg-red-400', text: 'text-red-400', label: 'Failed', pulse: false },
    timeout: { dot: 'bg-amber-400', text: 'text-amber-400', label: 'Timeout', pulse: false },
    killed: { dot: 'bg-orange-400', text: 'text-orange-400', label: 'Killed', pulse: false },
  };
  const cfg = configs[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cfg.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot} ${cfg.pulse ? 'animate-pulse' : ''}`} />
      {cfg.label}
    </span>
  );
}

// ─── Action log row ───────────────────────────────────────────────────────────

function ActionRow({ action, idx }: { action: ComputerUseAction; idx: number }) {
  const isSuccess = action.result.success;
  return (
    <tr
      className="border-b border-white/5 hover:bg-white/5 transition-colors"
      style={{ animationDelay: `${idx * 30}ms` }}
    >
      <td className="py-2 px-3">
        <div className={`p-1.5 rounded-lg inline-flex ${isSuccess ? 'bg-blue-500/15 text-blue-400' : 'bg-red-500/15 text-red-400'}`}>
          <ActionIcon type={action.type} className="w-3 h-3" />
        </div>
      </td>
      <td className="py-2 px-3">
        <span className="text-xs font-mono text-white/70">{action.type}</span>
      </td>
      <td className="py-2 px-3">
        {isSuccess ? (
          <Check className="w-3.5 h-3.5 text-green-400" />
        ) : (
          <X className="w-3.5 h-3.5 text-red-400" />
        )}
      </td>
      <td className="py-2 px-3">
        <span className="text-xs text-white/50 font-mono tabular-nums">{formatDuration(action.result.durationMs)}</span>
      </td>
      <td className="py-2 px-3">
        <span className="text-xs text-white/40">{relativeTime(action.timestamp)}</span>
      </td>
      {action.result.error && (
        <td className="py-2 px-3 max-w-[200px]">
          <span className="text-xs text-red-400 truncate block">{action.result.error}</span>
        </td>
      )}
    </tr>
  );
}

// ─── Session row ──────────────────────────────────────────────────────────────

function SessionRow({ session, isExpanded, onToggle }: {
  session: SessionListItem;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [loadingActions, setLoadingActions] = useState(false);
  const [actions, setActions] = useState<ComputerUseAction[] | null>(session.actions ?? null);

  const actionCount = session.actionsCount ?? actions?.length ?? 0;

  // Lazy-load full session data (with actions) when expanded
  useEffect(() => {
    if (!isExpanded || actions !== null) return;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return null;
      setLoadingActions(true);
      return fetch(`/api/computer-use?id=${encodeURIComponent(session.id)}`);
    })
      .then(res => res?.json())
      .then(data => {
        if (!cancelled && data?.success && data.session) {
          setActions(data.session.actions ?? []);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingActions(false); });
    return () => { cancelled = true; };
  }, [isExpanded, actions, session.id]);

  return (
    <>
      <div
        className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors border-b border-white/5 hover:bg-white/5 ${isExpanded ? 'bg-blue-500/5' : ''}`}
        onClick={onToggle}
        role="button"
        aria-expanded={isExpanded}
      >
        <div className="text-white/30 shrink-0">
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </div>
        <span className="text-xs font-mono text-white/50 shrink-0 w-24 truncate">{shortId(session.id)}</span>
        <div className="shrink-0">
          <SessionStatusBadge status={session.status} />
        </div>
        <span className="text-xs text-white/40 shrink-0 flex items-center gap-1">
          <User className="w-3 h-3" />
          {session.createdBy}
        </span>
        <span className="text-xs text-white/40 shrink-0 tabular-nums ml-auto">{actionCount} actions</span>
        <span className="text-xs text-white/30 shrink-0 tabular-nums">{formatDuration(session.closedAt ? new Date(session.closedAt).getTime() - new Date(session.createdAt).getTime() : elapsedMs(session.createdAt))}</span>
        <span className="text-xs text-white/30 shrink-0">{relativeTime(session.createdAt)}</span>
      </div>

      {isExpanded && (
        <div className="border-b border-white/5 bg-black/20">
          {loadingActions ? (
            <div className="flex items-center gap-2 px-10 py-4">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-white/30" />
              <span className="text-xs text-white/30">Loading actions...</span>
            </div>
          ) : !actions || actions.length === 0 ? (
            <p className="text-xs text-white/30 px-10 py-4">No actions recorded.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wider text-white/30 w-10">Type</th>
                    <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wider text-white/30">Action</th>
                    <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wider text-white/30 w-10">OK</th>
                    <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wider text-white/30">Duration</th>
                    <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wider text-white/30">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {actions.map((action, idx) => (
                    <ActionRow key={action.id} action={action} idx={idx} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ─── Task Progress Row ────────────────────────────────────────────────────────
// Live row for one in-flight (or just-finished) task. Polls the linked session
// every 1.5s while the task is running, computes structured progress client-side,
// surfaces a stuck warning at >60s since the last bridge action, and freezes
// final values once the task hits a terminal state.

interface TaskProgressRowProps {
  task: ComputerUseTask;
  tick: number;                          // wall-clock tick from parent for live elapsed
  onStop: (taskId: string) => void;
  stopping: boolean;
}

function actionShortLabel(type: ComputerUseActionType): string {
  switch (type) {
    case 'screenshot': return 'screenshot';
    case 'click': return 'click';
    case 'double_click': return 'double click';
    case 'right_click': return 'right click';
    case 'type': return 'type';
    case 'key': return 'keypress';
    case 'scroll': return 'scroll';
    case 'move': return 'move';
    case 'drag': return 'drag';
    default: return String(type);
  }
}

function TaskProgressRow({ task, tick, onStop, stopping }: TaskProgressRowProps) {
  const isRunning = task.status === 'running';
  const [sessionProgress, setProgress] = useState<TaskProgress>(() => ({
    actionsCount: task.actionsCount ?? 0,
    lastAction: null,
    elapsedMs: elapsedMs(task.startedAt),
    terminalState: !isRunning,
  }));

  const progress: TaskProgress = {
    ...sessionProgress,
    actionsCount: isRunning && task.sessionId ? sessionProgress.actionsCount : (task.actionsCount ?? 0),
    lastAction: isRunning && task.sessionId ? sessionProgress.lastAction : null,
    elapsedMs: isRunning ? Math.max(0, tick - new Date(task.startedAt).getTime()) : (task.durationMs ?? sessionProgress.elapsedMs),
    terminalState: !isRunning,
  };

  // Only the linked session requires synchronization; task fields are derived above.
  useEffect(() => {
    if (!isRunning || !task.sessionId) return;

    let cancelled = false;
    const sessionUrl = `/api/computer-use?id=${encodeURIComponent(task.sessionId)}`;
    const taskStartedMs = new Date(task.startedAt).getTime();

    async function poll() {
      try {
        const res = await fetch(sessionUrl);
        if (!res.ok) return;
        const data = await res.json() as { success: boolean; session?: ComputerUseSession };
        if (cancelled || !data.success || !data.session) return;
        const actions = data.session.actions ?? [];
        // Filter to actions taken on or after task.startedAt — mirrors server-side computeTaskProgress.
        const taskActions = actions.filter(a => new Date(a.timestamp).getTime() >= taskStartedMs);
        const newest = taskActions.length > 0 ? taskActions[taskActions.length - 1] : null;
        setProgress({
          actionsCount: taskActions.length,
          lastAction: newest ? { type: newest.type, timestamp: newest.timestamp } : null,
          elapsedMs: elapsedMs(task.startedAt),
          terminalState: false,
        });
      } catch {
        /* swallow — next poll will retry */
      }
    }

    poll();
    const interval = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isRunning, task.sessionId, task.startedAt, task.actionsCount, task.durationMs]);

  // Recompute "stuck" — purely derived, no state needed.
  const lastActionAgeMs = progress.lastAction
    ? new Date(task.startedAt).getTime() + progress.elapsedMs - new Date(progress.lastAction.timestamp).getTime()
    : null;
  const isStuck = isRunning && lastActionAgeMs !== null && lastActionAgeMs > STUCK_THRESHOLD_MS;

  // Live elapsed for running tasks; frozen durationMs for terminal.
  const displayElapsedMs = isRunning ? progress.elapsedMs : (task.durationMs ?? progress.elapsedMs);

  return (
    <div
      className={`px-5 py-4 transition-all ${
        isStuck ? 'bg-amber-500/[0.04]' : 'hover:bg-white/[0.03]'
      } ${!isRunning ? 'opacity-90' : ''}`}
    >
      <div className="flex items-start gap-3">
        {/* Status indicator */}
        <div className={`mt-0.5 shrink-0 transition-opacity ${isStuck ? 'opacity-60' : ''}`}>
          {isRunning
            ? <Loader2 className={`w-4 h-4 animate-spin ${isStuck ? 'text-amber-400' : 'text-teal-400'}`} />
            : <TaskStatusBadge status={task.status} />}
        </div>

        {/* Body */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white/95 truncate" title={task.prompt}>
            {task.prompt}
          </p>

          {/* Live metrics row */}
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            <span className={`text-xs flex items-center gap-1 tabular-nums ${
              isRunning ? 'text-teal-300' : 'text-white/55'
            }`}>
              <Clock className="w-3 h-3" />
              {formatDuration(displayElapsedMs)}
            </span>

            <span className="text-xs text-white/55 tabular-nums">
              {progress.actionsCount} action{progress.actionsCount !== 1 ? 's' : ''}
            </span>

            {progress.lastAction ? (
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border ${
                  isStuck
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                    : 'bg-teal-500/10 border-teal-500/25 text-teal-300'
                }`}
                title={`${actionShortLabel(progress.lastAction.type)} at ${new Date(progress.lastAction.timestamp).toLocaleTimeString()}`}
              >
                <ActionIcon type={progress.lastAction.type} className="w-3 h-3" />
                last: {actionShortLabel(progress.lastAction.type)} · {relativeTime(progress.lastAction.timestamp)}
              </span>
            ) : isRunning ? (
              <span className="text-[11px] text-white/40 italic">starting…</span>
            ) : null}

            {isStuck && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-amber-500/15 border border-amber-500/35 text-amber-200">
                <AlertCircle className="w-3 h-3" />
                waiting…
              </span>
            )}

            <span className="text-xs text-white/40 flex items-center gap-1 ml-auto">
              <User className="w-3 h-3" />
              {task.createdBy}
            </span>
          </div>

          {/* Terminal-state outcome banner */}
          {!isRunning && (task.error || task.result) && (
            <div className={`mt-2.5 flex items-start gap-2 px-3 py-2 rounded-lg border text-xs leading-relaxed ${
              task.status === 'completed'
                ? 'bg-green-500/[0.06] border-green-500/20 text-green-200/90'
                : 'bg-red-500/[0.06] border-red-500/20 text-red-200/90'
            }`}>
              {task.status === 'completed'
                ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-green-400" />
                : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-400" />}
              <p className="flex-1 break-words line-clamp-3">
                {task.error || task.result}
              </p>
            </div>
          )}
        </div>

        {/* Stop button — only while running */}
        {isRunning && (
          <button
            onClick={() => onStop(task.id)}
            disabled={stopping}
            title="Stop this task"
            aria-label={`Stop task: ${task.prompt}`}
            className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 hover:border-red-500/40 text-red-300 hover:text-red-200 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {stopping ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Dependency Check Modal ───────────────────────────────────────────────────

interface DependencyCheckModalProps {
  missing: string[];
  state: 'missing' | 'installing' | 'install_fired' | 'checking';
  onInstall: () => void;
  onCheckAgain: () => void;
}

function DependencyCheckModal({ missing, state, onInstall, onCheckAgain }: DependencyCheckModalProps) {
  const manualCmd = `pip install ${missing.join(' ')}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xl">
      <div
        className="glass-card w-full max-w-lg mx-4 rounded-3xl border border-white/15 overflow-hidden"
        style={{ boxShadow: '0 0 60px rgba(59,130,246,0.15), 0 25px 50px rgba(0,0,0,0.8)' }}
      >
        {/* Header */}
        <div className="px-7 pt-7 pb-5 border-b border-white/8">
          <div className="flex items-start gap-4">
            <div className="p-2.5 rounded-xl bg-amber-500/20 border border-amber-500/30 shrink-0 mt-0.5">
              <Package className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">Python Dependencies Required</h2>
              <p className="text-sm text-white/50 mt-0.5">
                {missing.length} package{missing.length !== 1 ? 's' : ''} must be installed before Computer Use can run.
              </p>
            </div>
          </div>
        </div>

        {/* Package list */}
        <div className="px-7 py-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-white/30 mb-3">Missing packages</p>
          <div className="flex flex-wrap gap-2">
            {missing.map((pkg) => (
              <span
                key={pkg}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-500/15 border border-red-500/25 text-red-300 text-xs font-mono"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                {pkg}
              </span>
            ))}
          </div>
        </div>

        {/* Install-fired info banner */}
        {state === 'install_fired' && (
          <div className="mx-7 mb-5 flex items-start gap-3 px-4 py-3 rounded-xl bg-blue-500/10 border border-blue-500/25 text-blue-300 text-sm">
            <Activity className="w-4 h-4 mt-0.5 shrink-0 animate-pulse" />
            <span>
              A PowerShell window has opened and is installing packages. Click{' '}
              <strong className="text-blue-200">Check Again</strong> when it finishes.
            </span>
          </div>
        )}

        {/* Manual command fallback */}
        <div className="px-7 pb-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-white/30 mb-2">Manual install command</p>
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-black/50 border border-white/10">
            <Terminal className="w-3.5 h-3.5 text-white/30 shrink-0" />
            <code className="text-xs font-mono text-white/60 flex-1 truncate" title={manualCmd}>
              {manualCmd}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(manualCmd)}
              className="text-white/30 hover:text-white/70 transition-colors shrink-0 text-xs px-1.5 py-0.5 rounded hover:bg-white/10"
              title="Copy to clipboard"
            >
              Copy
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="px-7 pb-7 flex gap-3">
          <button
            onClick={onInstall}
            disabled={state === 'installing' || state === 'install_fired' || state === 'checking'}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-blue-500 hover:bg-blue-400 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-all shadow-[0_0_20px_rgba(59,130,246,0.4)] hover:shadow-[0_0_28px_rgba(59,130,246,0.6)]"
          >
            {state === 'installing' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Installing…</>
            ) : (
              <><Zap className="w-4 h-4" /> Install Now</>
            )}
          </button>
          <button
            onClick={onCheckAgain}
            disabled={state === 'checking'}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-white/5 border border-white/15 hover:bg-white/10 hover:border-blue-500/30 text-white/70 hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {state === 'checking' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Checking…</>
            ) : (
              <><RefreshCw className="w-4 h-4" /> Check Again</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

const ALL_REQUIRED_PACKAGES = ['fastapi', 'uvicorn', 'mss', 'Pillow', 'pyautogui'];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ComputerUsePage() {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [tasks, setTasks] = useState<ComputerUseTask[]>([]);
  const [bridge, setBridge] = useState<ComputerUseBridgeStatus | null>(null);
  const [computerUseEnabled, setComputerUseEnabled] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [killConfirm, setKillConfirm] = useState(false);
  const [killing, setKilling] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [startingBridge, setStartingBridge] = useState(false);

  // ── Dependency check state ─────────────────────────────────────────────────
  const [depModalState, setDepModalState] = useState<'checking' | 'missing' | 'installing' | 'install_fired'>('checking');
  const [missingDeps, setMissingDeps] = useState<string[]>([]);
  const [showDepModal, setShowDepModal] = useState(false);

  // ── Setup wizard state ─────────────────────────────────────────────────────
  const [showWizard, setShowWizard] = useState(false);
  const [wizardBackend, setWizardBackend] = useState<'api' | 'max'>('api');
  // Track wizardPassedAt so we can auto-launch on true first-run only.
  const [wizardPassedAt, setWizardPassedAt] = useState<string | null | undefined>(undefined);
  // Guard so the auto-launch fires at most once per session.
  const autoLaunchedRef = useRef(false);

  // Live elapsed timer for running tasks
  const [tick, setTick] = useState(() => Date.now());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Toast helpers ──────────────────────────────────────────────────────────
  const addToast = useCallback((message: string, type: Toast['type'] = 'error') => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── Fetch data ─────────────────────────────────────────────────────────────
  const fetchData = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const [cuRes, settingsRes] = await Promise.all([
        fetch('/api/computer-use'),
        fetch('/api/settings'),
      ]);
      const [cuData, settingsData] = await Promise.all([cuRes.json(), settingsRes.json()]);

      if (cuData.success) {
        setSessions(cuData.sessions ?? []);
        setTasks(cuData.tasks ?? []);
        setBridge(cuData.bridge ?? null);
      } else {
        addToast(cuData.error || 'Failed to load computer use data');
      }

      if (settingsData.success && settingsData.settings?.computerUse) {
        setComputerUseEnabled(settingsData.settings.computerUse.enabled ?? false);
        setWizardBackend(settingsData.settings.computerUse.backend ?? 'api');
        setWizardPassedAt(settingsData.settings.computerUse.wizardPassedAt ?? null);
      }

      setLastRefreshed(new Date());
    } catch {
      addToast('Could not reach the server');
    } finally {
      setLoading(false);
      if (showRefresh) setRefreshing(false);
    }
  }, [addToast]);

  // ── Polling every 5s ───────────────────────────────────────────────────────
  useEffect(() => {
    fetchData();
    const interval = setInterval(() => fetchData(), 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // ── Tick for live elapsed timers ───────────────────────────────────────────
  useEffect(() => {
    tickRef.current = setInterval(() => setTick(Date.now()), 1000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, []);

  // ── Toggle computer use enabled ────────────────────────────────────────────
  const handleToggleEnabled = async () => {
    setTogglingEnabled(true);
    const turningOn = !computerUseEnabled;
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerUse: { enabled: turningOn } }),
      });
      const data = await res.json();
      if (data.success) {
        setComputerUseEnabled(turningOn);
        // Silent — no success toast on either ON or OFF

        if (turningOn) {
          // Fire-and-forget bridge start.
          // startBridge() on the server polls for up to 15s before returning — do NOT await here.
          // The toggle re-enables immediately; error toast appears after bridge startup fails.
          fetch('/api/computer-use', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'bridge.start' }),
          })
            .then((r) => r.json())
            .then((d: { success: boolean; bridge?: ComputerUseBridgeStatus; error?: string }) => {
              if (d.success && d.bridge) {
                setBridge(d.bridge);
              } else if (!d.success) {
                addToast(`Bridge failed to start: ${d.error ?? 'Unknown error'}`);
              }
            })
            .catch(() => {
              addToast('Bridge failed to start: Could not reach server');
            });
        }
      } else {
        addToast(data.error || 'Failed to update setting');
      }
    } catch {
      addToast('Failed to update setting');
    } finally {
      setTogglingEnabled(false);
    }
  };

  // ── Kill all ───────────────────────────────────────────────────────────────
  const handleKillAll = async () => {
    setKillConfirm(false);
    setKilling(true);
    try {
      const res = await fetch('/api/computer-use/emergency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'kill_all' }),
      });
      const data = await res.json();
      if (data.success) {
        addToast('All active sessions killed', 'success');
        fetchData();
      } else {
        addToast(data.error || 'Kill command failed');
      }
    } catch {
      addToast('Failed to send kill command');
    } finally {
      setKilling(false);
    }
  };

  // ── Check bridge health ────────────────────────────────────────────────────
  const handleCheckHealth = async () => {
    setCheckingHealth(true);
    try {
      const res = await fetch('/api/computer-use', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bridge.health' }),
      });
      const data = await res.json();
      if (data.success) {
        addToast('Bridge health check complete', 'success');
        fetchData();
      } else {
        addToast(data.error || 'Health check failed');
      }
    } catch {
      addToast('Health check failed');
    } finally {
      setCheckingHealth(false);
    }
  };

  // ── Start bridge manually ──────────────────────────────────────────────────
  const handleStartBridge = async () => {
    setStartingBridge(true);
    try {
      const res = await fetch('/api/computer-use', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bridge.start' }),
      });
      const data = await res.json();
      if (data.success && data.bridge) {
        setBridge(data.bridge);
        addToast('Bridge started', 'success');
      } else {
        addToast(data.error || 'Failed to start bridge');
      }
    } catch {
      addToast('Failed to start bridge');
    } finally {
      setStartingBridge(false);
    }
  };

  // ── Check Python dependencies ──────────────────────────────────────────────
  const checkDependencies = useCallback(async (fromModal = false) => {
    if (fromModal) setDepModalState('checking');
    try {
      const capabilityResponse = await fetch('/api/computer-use/wizard');
      if (!capabilityResponse.ok) throw new Error('Could not check desktop setup support');
      const capability = await capabilityResponse.json();
      if (capability.supported === false) {
        setShowDepModal(false);
        return;
      }

      const res = await fetch('/api/computer-use', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deps.check' }),
      });
      const data = await res.json();
      if (!data.success) {
        // Fail-open: show modal with all packages if check itself fails
        setMissingDeps(ALL_REQUIRED_PACKAGES);
        setDepModalState('missing');
        setShowDepModal(true);
        return;
      }
      if (data.allInstalled) {
        setShowDepModal(false);
        setMissingDeps([]);
      } else {
        setMissingDeps(data.missing ?? []);
        setDepModalState('missing');
        setShowDepModal(true);
      }
    } catch {
      setShowDepModal(false);
      addToast('Could not check desktop setup. Use Setup Wizard to retry.');
    }
  }, [addToast]);

  // ── Trigger dependency install ─────────────────────────────────────────────
  const installDependencies = useCallback(async () => {
    setDepModalState('installing');
    try {
      const res = await fetch('/api/computer-use', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deps.install' }),
      });
      const data = await res.json();
      if (!data.success) {
        addToast(data.error || 'Failed to launch installer — use the manual command');
        setDepModalState('missing');
        return;
      }
      setDepModalState('install_fired');
    } catch {
      addToast('Failed to launch installer — use the manual command');
      setDepModalState('missing');
    }
  }, [addToast]);

  // ── Dep check on mount ─────────────────────────────────────────────────────
  useEffect(() => {
    checkDependencies();
  }, [checkDependencies]);

  // ── First-run wizard auto-launch ───────────────────────────────────────────
  // Open the setup wizard automatically when the user has never passed it AND
  // the bridge is offline. After the user runs it once (or dismisses it once
  // the bridge is online), the wizard becomes manual-only via the button.
  useEffect(() => {
    if (autoLaunchedRef.current) return;
    if (loading) return;
    if (wizardPassedAt === undefined) return; // settings not loaded yet
    if (showDepModal) return; // dep modal handles its own narrower case first
    if (!wizardPassedAt && bridge && !bridge.reachable) {
      autoLaunchedRef.current = true;
      setShowWizard(true);
    }
  }, [loading, wizardPassedAt, bridge, showDepModal]);

  // ── Toggle session expand ──────────────────────────────────────────────────
  const toggleSession = (id: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // ── Stop a single task ─────────────────────────────────────────────────────
  // /api/computer-use exposes task.stop via requireAuthOrLocal — the dashboard
  // calls without a Bearer token (audit task 5119f8a2).
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const handleStopTask = useCallback(async (taskId: string) => {
    setStoppingTaskId(taskId);
    try {
      const res = await fetch('/api/computer-use', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'task.stop', taskId }),
      });
      const data = await res.json() as { success: boolean; error?: string };
      if (data.success) {
        addToast('Task stopped', 'success');
        fetchData();
      } else {
        addToast(data.error || 'Failed to stop task');
      }
    } catch {
      addToast('Could not reach the server');
    } finally {
      setStoppingTaskId(null);
    }
  }, [addToast, fetchData]);

  // ── Derived values ─────────────────────────────────────────────────────────
  const activeSessions = sessions.filter((s) => s.status === 'active');
  const recentSessions = sessions.slice().sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ).slice(0, 10);
  const runningTasks = tasks.filter((t) => t.status === 'running');
  // Show running tasks plus any that hit terminal in the last 12s — gives the
  // user a moment to register the outcome before the row disappears.
  const RECENT_TERMINAL_GRACE_MS = 12_000;
  const now = Date.now();
  const tasksToShow = tasks
    .filter(t => {
      if (t.status === 'running') return true;
      if (!t.completedAt) return false;
      return (now - new Date(t.completedAt).getTime()) < RECENT_TERMINAL_GRACE_MS;
    })
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  // Screenshots are lazy-loaded per-session on expand — not available in the list view

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#050508]">
      {/* Background */}
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background:
            'radial-gradient(ellipse at 20% 15%, rgba(59,130,246,0.12) 0%, transparent 50%), radial-gradient(ellipse at 80% 85%, rgba(14,165,233,0.07) 0%, transparent 50%)',
        }}
      />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* ─── Header ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <Link
              href="/operations"
              className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-blue-500/30 transition-all shrink-0"
              title="Back to Dashboard"
            >
              <ArrowLeft className="w-4 h-4 text-white/70" />
            </Link>
            <div className="p-2.5 rounded-xl bg-blue-500/20 border border-blue-500/30 shrink-0">
              <Monitor className="w-6 h-6 text-blue-400" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-white tracking-tight">Computer Use</h1>
              <p className="text-sm text-white/50">Automated desktop control &mdash; sessions, tasks, and bridge status</p>
            </div>
          </div>

          {/* Bridge status badge — when offline, becomes a CTA to the wizard */}
          <div className="flex items-center gap-3 shrink-0">
            {loading ? (
              <div className="h-7 w-32 skeleton rounded-full" />
            ) : bridge?.reachable ? (
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/15 border border-green-500/25 text-green-400 text-sm font-medium">
                <Wifi className="w-3.5 h-3.5" />
                Bridge Online
                {bridge.screen && (
                  <span className="text-green-400/60 text-xs font-mono tabular-nums">
                    {bridge.screen.width}&times;{bridge.screen.height}
                  </span>
                )}
              </span>
            ) : (
              <button
                onClick={() => setShowWizard(true)}
                title="Open Setup Wizard to diagnose and fix"
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/15 border border-red-500/25 text-red-400 text-sm font-medium hover:bg-red-500/25 hover:border-red-500/40 hover:text-red-300 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
              >
                <WifiOff className="w-3.5 h-3.5" />
                Bridge Offline
                <span className="text-red-300/70 text-xs">— diagnose</span>
              </button>
            )}
          </div>
        </div>

        {/* ─── Status Strip ───────────────────────────────────────────────── */}
        <div className="glass-card px-4 py-3 rounded-2xl border border-white/10 mb-6 flex flex-wrap items-center gap-4">
          {/* Enable toggle */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-white/60 font-medium">Computer Use</span>
            <button
              onClick={handleToggleEnabled}
              disabled={togglingEnabled || loading}
              aria-label={computerUseEnabled ? 'Disable Computer Use' : 'Enable Computer Use'}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:opacity-50 disabled:cursor-not-allowed ${
                computerUseEnabled ? 'bg-blue-500' : 'bg-white/15'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  computerUseEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <span className={`text-xs font-medium ${computerUseEnabled ? 'text-blue-400' : 'text-white/30'}`}>
              {computerUseEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>

          <div className="w-px h-6 bg-white/10 shrink-0" />

          {/* Kill switch */}
          {killConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-400 font-medium">Kill all active sessions?</span>
              <button
                onClick={handleKillAll}
                disabled={killing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500 hover:bg-red-400 text-white transition-all"
              >
                {killing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                Confirm
              </button>
              <button
                onClick={() => setKillConfirm(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/50 hover:bg-white/10 transition-all"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setKillConfirm(true)}
              disabled={activeSessions.length === 0 || killing}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                activeSessions.length > 0
                  ? 'bg-red-500/90 hover:bg-red-500 text-white shadow-[0_0_20px_rgba(239,68,68,0.4)] hover:shadow-[0_0_28px_rgba(239,68,68,0.6)] border border-red-400/30'
                  : 'bg-red-500/20 border border-red-500/20 text-red-400/50'
              }`}
            >
              <Square className="w-4 h-4" />
              Stop All
              {activeSessions.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded bg-red-900/60 text-red-200 text-xs font-mono tabular-nums">
                  {activeSessions.length}
                </span>
              )}
            </button>
          )}

          {/* Setup wizard + timestamp + refresh */}
          <div className="flex items-center gap-2 ml-auto">
            {lastRefreshed && (
              <span className="text-xs text-white/40 hidden sm:block">
                Updated {relativeTime(lastRefreshed.toISOString())}
              </span>
            )}
            <button
              onClick={() => setShowWizard(true)}
              title="Run the Computer Use setup wizard"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-blue-500/30 text-white/70 hover:text-white text-xs transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
            >
              <Wand2 className="w-3.5 h-3.5" />
              Setup Wizard
            </button>
            <button
              onClick={() => fetchData(true)}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-blue-500/30 text-white/60 text-xs transition-all disabled:opacity-40"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* ─── Two-column layout ───────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">

          {/* Left column */}
          <div className="flex flex-col gap-4 min-w-0">

            {/* Active Tasks */}
            <section className="glass-card rounded-2xl border border-white/10 overflow-hidden">
              <div className="flex items-center gap-3 px-5 py-4 border-b border-white/5">
                <div className="p-1.5 rounded-lg bg-blue-500/15">
                  <Activity className="w-4 h-4 text-blue-400" />
                </div>
                <h2 className="text-sm font-semibold text-white">Active Tasks</h2>
                {runningTasks.length > 0 && (
                  <span className="ml-auto px-2 py-0.5 rounded-full bg-blue-500/20 border border-blue-500/30 text-blue-300 text-xs font-mono tabular-nums">
                    {runningTasks.length}
                  </span>
                )}
              </div>

              {loading ? (
                <div className="px-5 py-4 space-y-3">
                  {[1, 2].map((i) => (
                    <div key={i} className="h-14 rounded-xl skeleton" />
                  ))}
                </div>
              ) : tasksToShow.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
                  <div className="p-3 rounded-full bg-white/5">
                    <Monitor className="w-5 h-5 text-white/20" />
                  </div>
                  <p className="text-sm text-white/55">No active tasks</p>
                  <p className="text-xs text-white/40">Tasks will appear here when running</p>
                </div>
              ) : (
                <div className="divide-y divide-white/5">
                  {tasksToShow.map(task => (
                    <TaskProgressRow
                      key={task.id}
                      task={task}
                      tick={tick}
                      onStop={handleStopTask}
                      stopping={stoppingTaskId === task.id}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* Recent Sessions */}
            <section className="glass-card rounded-2xl border border-white/10 overflow-hidden">
              <div className="flex items-center gap-3 px-5 py-4 border-b border-white/5">
                <div className="p-1.5 rounded-lg bg-white/5">
                  <Monitor className="w-4 h-4 text-white/50" />
                </div>
                <h2 className="text-sm font-semibold text-white">Recent Sessions</h2>
                <span className="text-xs text-white/30 ml-auto">last 10</span>
              </div>

              {loading ? (
                <div className="divide-y divide-white/5">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="px-5 py-3">
                      <div className="h-5 w-3/4 skeleton rounded" />
                    </div>
                  ))}
                </div>
              ) : recentSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
                  <div className="p-3 rounded-full bg-white/5">
                    <Circle className="w-5 h-5 text-white/20" />
                  </div>
                  <p className="text-sm text-white/40">No sessions yet</p>
                </div>
              ) : (
                <div>
                  {recentSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      isExpanded={expandedSessions.has(session.id)}
                      onToggle={() => toggleSession(session.id)}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">

            {/* Live Screenshot */}
            <section className="glass-card rounded-2xl border border-white/10 overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/5">
                <div className="p-1.5 rounded-lg bg-purple-500/15">
                  <Camera className="w-4 h-4 text-purple-400" />
                </div>
                <h2 className="text-sm font-semibold text-white">Live Screenshot</h2>
                {activeSessions.length > 0 && (
                  <span className="ml-auto flex items-center gap-1.5 text-xs text-green-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    Live
                  </span>
                )}
              </div>

              <div className="p-3">
                <div className="rounded-xl bg-black/40 border border-white/5 flex flex-col items-center justify-center py-12 gap-3">
                  <div className="p-3 rounded-full bg-white/5 border border-white/5">
                    <Camera className="w-6 h-6 text-white/20" />
                  </div>
                  <p className="text-xs text-white/30">Waiting for screenshot&hellip;</p>
                  {activeSessions.length === 0 && (
                    <p className="text-xs text-white/20">No active sessions</p>
                  )}
                </div>
              </div>
            </section>

            {/* Bridge Status */}
            <section className="glass-card rounded-2xl border border-white/10 overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/5">
                <div className={`p-1.5 rounded-lg ${bridge?.reachable ? 'bg-green-500/15' : 'bg-red-500/15'}`}>
                  {bridge?.reachable ? (
                    <Wifi className="w-4 h-4 text-green-400" />
                  ) : (
                    <WifiOff className="w-4 h-4 text-red-400" />
                  )}
                </div>
                <h2 className="text-sm font-semibold text-white">Bridge Status</h2>
              </div>

              <div className="px-4 py-4 space-y-3">
                {loading ? (
                  <div className="space-y-2">
                    <div className="h-4 skeleton rounded w-3/4" />
                    <div className="h-4 skeleton rounded w-1/2" />
                    <div className="h-4 skeleton rounded w-2/3" />
                  </div>
                ) : bridge ? (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-white/40">Status</span>
                      <span className={`text-xs font-medium ${bridge.reachable ? 'text-green-400' : 'text-red-400'}`}>
                        {bridge.reachable ? 'Reachable' : 'Unreachable'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-white/40">URL</span>
                      <span className="text-xs font-mono text-white/60 truncate max-w-[180px]" title={bridge.url}>
                        {bridge.url}
                      </span>
                    </div>
                    {bridge.screen && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-white/40">Screen</span>
                        <span className="text-xs font-mono text-white/60 tabular-nums">
                          {bridge.screen.width}&times;{bridge.screen.height}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-white/40">Checked</span>
                      <span className="text-xs text-white/50">{relativeTime(bridge.lastCheckedAt)}</span>
                    </div>
                    {bridge.startupError && (
                      <div className="mt-1 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20">
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                        <p className="text-xs text-red-300 leading-relaxed break-words">{bridge.startupError}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-4 gap-2 text-center">
                    <Heart className="w-5 h-5 text-white/15" />
                    <p className="text-xs text-white/30">No bridge data</p>
                  </div>
                )}

                <div className="pt-1 flex gap-2">
                  <button
                    onClick={handleStartBridge}
                    disabled={startingBridge || bridge?.reachable}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                      bridge?.reachable
                        ? 'bg-green-500/10 border border-green-500/20 text-green-400'
                        : 'bg-orange-500/10 border border-orange-500/20 hover:bg-orange-500/20 hover:border-orange-500/40 text-orange-400 hover:text-orange-300'
                    }`}
                  >
                    {startingBridge ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : bridge?.reachable ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Wifi className="w-3.5 h-3.5" />
                    )}
                    {startingBridge ? 'Starting...' : bridge?.reachable ? 'Online' : 'Start Bridge'}
                  </button>
                  <button
                    onClick={handleCheckHealth}
                    disabled={checkingHealth}
                    className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium bg-white/5 border border-white/10 hover:bg-white/10 hover:border-blue-500/30 text-white/60 hover:text-white/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {checkingHealth ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Zap className="w-3.5 h-3.5" />
                    )}
                    {checkingHealth ? 'Checking...' : 'Check Health'}
                  </button>
                </div>
              </div>
            </section>

            {/* Quick stats strip */}
            <div className="grid grid-cols-3 gap-2">
              <div className="glass-card px-3 py-3 rounded-xl border border-white/10 text-center">
                <p className="text-xs text-white/40 uppercase tracking-wider font-medium mb-1">Sessions</p>
                <p className="text-xl font-bold text-white tabular-nums">
                  {loading ? <span className="inline-block w-6 h-5 skeleton rounded" /> : sessions.length}
                </p>
              </div>
              <div className="glass-card px-3 py-3 rounded-xl border border-white/10 text-center">
                <p className="text-xs text-white/40 uppercase tracking-wider font-medium mb-1">Active</p>
                <p className={`text-xl font-bold tabular-nums ${activeSessions.length > 0 ? 'text-green-400' : 'text-white'}`}>
                  {loading ? <span className="inline-block w-6 h-5 skeleton rounded" /> : activeSessions.length}
                </p>
              </div>
              <div className="glass-card px-3 py-3 rounded-xl border border-white/10 text-center">
                <p className="text-xs text-white/40 uppercase tracking-wider font-medium mb-1">Tasks</p>
                <p className="text-xl font-bold text-white tabular-nums">
                  {loading ? <span className="inline-block w-6 h-5 skeleton rounded" /> : tasks.length}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showDepModal && (
        <DependencyCheckModal
          missing={missingDeps}
          state={depModalState}
          onInstall={installDependencies}
          onCheckAgain={() => checkDependencies(true)}
        />
      )}

      {showWizard && (
        <SetupWizardModal
          initialBackend={wizardBackend}
          onClose={() => {
            setShowWizard(false);
            // Wizard may have flipped wizardPassedAt and started the bridge; pull fresh state.
            fetchData();
          }}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
