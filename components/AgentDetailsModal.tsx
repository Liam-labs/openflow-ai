'use client';

import React, { useEffect, useState } from 'react';
import { X, Bot, Cpu, Hash, FolderOpen, Terminal, Sparkles, Activity, User, CheckCircle2, Clock, AlertTriangle, Loader2, RotateCcw, Zap } from 'lucide-react';
import type { AgentRosterEntry, AgentRole, CollabTask } from '@/lib/types';

interface CrashEvent {
  id: string;
  timestamp: string;
  title: string;
  metadata: {
    event?: string;
    exitCode?: number;
    signal?: string;
    crashCount?: number;
    error?: string;
  };
}

interface AgentDetailsModalProps {
  roster: AgentRosterEntry;
  participantName: string;
  channelName?: string;
  roles: AgentRole[];
  onClose: () => void;
}

function Row({ label, value, icon }: { label: string; value: React.ReactNode; icon: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-white/5 last:border-0">
      <div className="w-4 h-4 mt-0.5 text-white/30 flex-shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-white/30 uppercase tracking-wider mb-0.5">{label}</div>
        <div className="text-xs text-white/80 font-mono break-all">{value ?? <span className="text-white/20 italic">—</span>}</div>
      </div>
    </div>
  );
}

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function AgentDetailsModal({ roster, participantName, channelName, roles, onClose }: AgentDetailsModalProps) {
  const role = roles.find(r => r.id === roster.roleId);
  const [tasks, setTasks] = useState<CollabTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [crashEvents, setCrashEvents] = useState<CrashEvent[]>([]);
  const [crashLoading, setCrashLoading] = useState(true);

  // Fetch task history for this participant
  useEffect(() => {
    async function fetchTasks() {
      try {
        const res = await fetch(`/api/collab/tasks?channelId=${roster.channelId}`);
        if (!res.ok) return;
        const data = await res.json();
        const allTasks: CollabTask[] = data.tasks ?? [];
        const mine = allTasks.filter(t => t.assigneeId === roster.participantId);
        setTasks(mine);
      } catch {
        // ignore
      } finally {
        setTasksLoading(false);
      }
    }
    fetchTasks();
  }, [roster.channelId, roster.participantId]);

  // Fetch crash history from event log
  useEffect(() => {
    async function fetchCrashes() {
      try {
        const params = new URLSearchParams({
          sources: 'agent',
          agentName: roster.name,
          limit: '20',
        });
        const res = await fetch(`/api/logs?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        const entries: CrashEvent[] = (data.entries ?? []).filter(
          (e: CrashEvent) => e.metadata?.event === 'crash'
        );
        setCrashEvents(entries.slice(0, 5));
      } catch {
        // ignore
      } finally {
        setCrashLoading(false);
      }
    }
    fetchCrashes();
  }, [roster.name]);

  const currentTask = tasks.find(t => t.status === 'in_progress');
  const allDone = tasks.filter(t => t.status === 'done')
    .sort((a, b) => new Date(b.completedAt ?? b.updatedAt).getTime() - new Date(a.completedAt ?? a.updatedAt).getTime());
  const recentDone = allDone.slice(0, 8);

  const statusColor: Record<string, string> = {
    running: 'text-green-400',
    stopped: 'text-white/30',
    crashed: 'text-red-400',
    starting: 'text-amber-400',
    away: 'text-blue-400',
    restarting: 'text-amber-400',
    'shutting-down': 'text-orange-400',
  };
  const statusColorClass = statusColor[roster.status] ?? 'text-white/30';

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 bg-[#0f1d32] border border-white/10 rounded-xl shadow-2xl max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 sticky top-0 bg-[#0f1d32] z-10">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold text-white">{participantName}</span>
            <span className={`text-[10px] font-mono uppercase ${statusColorClass}`}>{roster.status}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors" aria-label="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Details */}
        <div className="px-4 py-2">
          <Row label="Name" value={roster.name} icon={<User />} />
          <Row
            label="Model"
            value={
              <span className="capitalize">
                {roster.agentType && roster.agentType !== 'claude' ? roster.agentType + ' · ' : ''}
                {roster.model ?? 'default'}
              </span>
            }
            icon={<Sparkles />}
          />
          {roster.effort && (
            <Row
              label="Effort"
              value={<span className="capitalize">{roster.effort}</span>}
              icon={<Sparkles />}
            />
          )}
          {roster.personality && (
            <Row label="Personality" value={roster.personality} icon={<Bot />} />
          )}
          {roster.spawnMode === 'powershell' ? (
            /* Per-message agents spawn claude.exe per message — no persistent PID.
               Show honest mode + live turn state instead of "PID: not running". */
            <Row
              label="Session"
              value={
                roster.ptySessionStatus === 'responding' ? (
                  <span className="flex items-center gap-1.5 text-amber-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                    Per-message mode · Responding…
                  </span>
                ) : (
                  <span className="text-green-400/60">Per-message mode · Ready</span>
                )
              }
              icon={<Zap />}
            />
          ) : (
            <Row label="PID" value={roster.pid ?? 'not running'} icon={<Cpu />} />
          )}
          <Row label="Channel ID" value={roster.channelId} icon={<Hash />} />
          {channelName && (
            <Row label="Channel" value={channelName} icon={<Activity />} />
          )}
          <Row label="Working Directory" value={roster.workingDirectory} icon={<FolderOpen />} />
          {roster.tmuxSessionName && (
            <Row label="Tmux Session" value={roster.tmuxSessionName} icon={<Terminal />} />
          )}
          {role && (
            <Row label="Role" value={role.name} icon={<User />} />
          )}
        </div>

        {/* Task History */}
        <div className="px-4 pb-2 border-t border-white/5 mt-1">
          <div className="text-[10px] text-white/30 uppercase tracking-wider pt-3 pb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              Task History
            </span>
            {!tasksLoading && allDone.length > 0 && (
              <span className="text-[10px] font-mono text-green-400/50">{allDone.length} done</span>
            )}
          </div>
          {tasksLoading ? (
            <div className="flex items-center gap-2 py-2 text-white/20">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="text-[11px]">Loading…</span>
            </div>
          ) : (
            <>
              {currentTask && (
                <div className="mb-2 px-2.5 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    <span className="text-[10px] text-blue-400/70 uppercase tracking-wider">In Progress</span>
                  </div>
                  <p className="text-[11px] text-white/80 leading-snug">{currentTask.title}</p>
                </div>
              )}
              {recentDone.length > 0 ? (
                <div className="space-y-0.5 max-h-40 overflow-y-auto">
                  {recentDone.map(t => (
                    <div key={t.id} className="flex items-start gap-2 py-1.5">
                      <CheckCircle2 className="w-3 h-3 mt-0.5 text-green-400/60 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] text-white/60 truncate">{t.title}</p>
                      </div>
                      <span className="text-[10px] text-white/20 flex-shrink-0 font-mono">
                        {t.completedAt ? relativeTime(t.completedAt) : ''}
                      </span>
                    </div>
                  ))}
                  {allDone.length > 8 && (
                    <p className="text-[10px] text-white/20 py-1 text-center">
                      +{allDone.length - 8} more
                    </p>
                  )}
                </div>
              ) : (
                !currentTask && (
                  <p className="text-[11px] text-white/20 py-1">No tasks in this channel</p>
                )
              )}
            </>
          )}
        </div>

        {/* Crash History */}
        <div className="px-4 pb-3 border-t border-white/5 mt-1">
          <div className="text-[10px] text-white/30 uppercase tracking-wider pt-3 pb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" />
              Crash History
            </span>
            <span className={`text-[10px] font-mono ${roster.crashCount > 0 ? 'text-red-400/70' : 'text-green-400/50'}`}>
              {roster.crashCount} total
            </span>
          </div>
          {/* Timestamps */}
          <div className="space-y-1 mb-2">
            {roster.lastStartedAt && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-white/30 flex items-center gap-1">
                  <Zap className="w-2.5 h-2.5" /> Last started
                </span>
                <span className="text-[11px] font-mono text-white/40">{relativeTime(roster.lastStartedAt)}</span>
              </div>
            )}
            {roster.lastStoppedAt && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-white/30 flex items-center gap-1">
                  <RotateCcw className="w-2.5 h-2.5" /> Last stopped
                </span>
                <span className="text-[11px] font-mono text-white/40">{relativeTime(roster.lastStoppedAt)}</span>
              </div>
            )}
          </div>
          {/* Crash event log */}
          {crashLoading ? (
            <div className="flex items-center gap-2 py-1 text-white/20">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="text-[11px]">Loading crash log…</span>
            </div>
          ) : crashEvents.length > 0 ? (
            <div className="space-y-0.5 max-h-32 overflow-y-auto">
              {crashEvents.map(ev => (
                <div key={ev.id} className="flex items-start gap-2 py-1 px-2 rounded-md bg-red-500/[0.05] border border-red-500/10">
                  <AlertTriangle className="w-2.5 h-2.5 mt-0.5 text-red-400/60 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-red-300/70 truncate">{ev.title}</p>
                    {(ev.metadata.exitCode !== undefined || ev.metadata.signal) && (
                      <p className="text-[10px] text-white/25 font-mono">
                        {ev.metadata.exitCode !== undefined && `exit ${ev.metadata.exitCode}`}
                        {ev.metadata.signal && ` · ${ev.metadata.signal}`}
                      </p>
                    )}
                  </div>
                  <span className="text-[10px] text-white/20 flex-shrink-0 font-mono">{relativeTime(ev.timestamp)}</span>
                </div>
              ))}
            </div>
          ) : roster.crashCount === 0 ? (
            <p className="text-[11px] text-green-400/40 py-0.5">No crashes recorded</p>
          ) : (
            <p className="text-[11px] text-white/20 py-0.5">No recent crash logs</p>
          )}
        </div>
      </div>
    </>
  );
}
