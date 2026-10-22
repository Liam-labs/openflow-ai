'use client';

import { useState, useEffect, useCallback } from 'react';
import { Zap, RefreshCw, Users, CheckCircle2, Clock, TrendingUp } from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Sprint {
  id: string;
  name: string;
  status: string;
  sortOrder: number;
}

interface Task {
  id: string;
  status: string;
  sprintId?: string;
}

interface ChannelData {
  channelId: string;
  channelName: string;
  activeSprint: Sprint | null;
  allSprints: Sprint[];
  tasks: Task[];
}

interface SprintStats {
  total: number;
  done: number;
  inProgress: number;
  todo: number;
  percent: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcStats(tasks: Task[], sprintId: string | null): SprintStats {
  const filtered = sprintId ? tasks.filter((t) => t.sprintId === sprintId) : tasks;
  const total = filtered.length;
  const done = filtered.filter((t) => t.status === 'done' || t.status === 'completed').length;
  const inProgress = filtered.filter((t) => t.status === 'in_progress').length;
  const todo = filtered.filter((t) => t.status === 'todo').length;
  return { total, done, inProgress, todo, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
}

function getSprintColor(status: string): string {
  switch (status) {
    case 'active': return '#22c55e';
    case 'planned': return '#60a5fa';
    case 'completed': return '#10b981';
    default: return 'rgba(255,255,255,0.3)';
  }
}

function getBarColor(percent: number): string {
  if (percent >= 80) return '#22c55e';
  if (percent >= 50) return '#60a5fa';
  return '#8b5cf6';
}

// ─── Component ───────────────────────────────────────────────────────────────

export function SprintProgressWidget() {
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [totalVelocity, setTotalVelocity] = useState(0);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const chRes = await fetch('/api/collab');
      if (!chRes.ok) return;
      const chData = await chRes.json();
      const allChannels: Array<{ id: string; name: string }> = Array.isArray(chData)
        ? chData
        : (chData.channels ?? []);

      const results: ChannelData[] = [];
      let velocityTotal = 0;

      await Promise.all(
        allChannels.map(async (ch) => {
          try {
            const tRes = await fetch(`/api/collab/tasks?channelId=${ch.id}&includeHierarchy=true`);
            if (!tRes.ok) return;
            const tData = await tRes.json();
            const tasks: Task[] = tData.tasks ?? [];
            const sprints: Sprint[] = tData.sprints ?? [];
            if (sprints.length === 0) return;

            velocityTotal += tasks.filter((t) => t.status === 'done' || t.status === 'completed').length;

            const activeSprint =
              sprints.find((s) => s.status === 'active') ??
              sprints.filter((s) => s.status === 'planned').sort((a, b) => b.sortOrder - a.sortOrder)[0] ??
              sprints.filter((s) => s.status === 'completed').sort((a, b) => b.sortOrder - a.sortOrder)[0] ??
              null;

            results.push({ channelId: ch.id, channelName: ch.name, activeSprint, allSprints: sprints, tasks });
          } catch { /* skip */ }
        })
      );

      results.sort((a, b) => {
        const aScore = a.activeSprint?.status === 'active' ? 0 : a.activeSprint?.status === 'planned' ? 1 : 2;
        const bScore = b.activeSprint?.status === 'active' ? 0 : b.activeSprint?.status === 'planned' ? 1 : 2;
        return aScore - bScore;
      });

      setChannels(results);
      setTotalVelocity(velocityTotal);
      setLastRefresh(new Date().toLocaleTimeString());
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(), 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (loading) {
    return (
      <div className="glass-card spw-root">
        <div className="spw-header">
          <div className="spw-header-left">
            <div className="spw-icon-wrap"><Zap size={13} color="#8b5cf6" /></div>
            <span className="spw-title">Sprint Progress</span>
          </div>
        </div>
        <div className="spw-loading">
          <div className="spw-shimmer" style={{ height: 52, borderRadius: 8 }} />
          <div className="spw-shimmer" style={{ height: 52, marginTop: 8, borderRadius: 8 }} />
        </div>
      </div>
    );
  }

  if (channels.length === 0) return null;

  return (
    <div className="glass-card spw-root">
      {/* Header */}
      <div className="spw-header">
        <div className="spw-header-left">
          <div className="spw-icon-wrap"><Zap size={13} color="#8b5cf6" /></div>
          <span className="spw-title">Sprint Progress</span>
          <span className="spw-badge">{channels.length} active</span>
        </div>
        <div className="spw-header-right">
          <div className="spw-velocity" title="Total tasks completed across all active sprints">
            <TrendingUp size={11} />
            <span>{totalVelocity} done</span>
          </div>
          {lastRefresh && <span className="spw-timestamp">{lastRefresh}</span>}
          <button
            className="spw-refresh-btn"
            onClick={() => load(true)}
            disabled={refreshing}
            aria-label="Refresh sprint data"
          >
            <RefreshCw size={13} color="rgba(255,255,255,0.4)" className={refreshing ? 'spw-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Channel rows */}
      <div className="spw-channels">
        {channels.slice(0, showAll ? undefined : 5).map((ch) => {

          const stats = calcStats(ch.tasks, ch.activeSprint?.id ?? null);
          const color = ch.activeSprint ? getSprintColor(ch.activeSprint.status) : 'rgba(255,255,255,0.3)';
          const barColor = getBarColor(stats.percent);
          const completedSprints = ch.allSprints.filter((s) => s.status === 'completed').length;

          return (
            <div key={ch.channelId} className="spw-channel">
              <div className="spw-channel-header">
                <div className="spw-channel-left">
                  <div className="spw-status-dot" style={{ background: color }} />
                  <span className="spw-channel-name">{ch.channelName}</span>
                  {ch.activeSprint && (
                    <span className="spw-sprint-name">{ch.activeSprint.name}</span>
                  )}
                </div>
                <div className="spw-channel-right">
                  <span className="spw-count">
                    <span className="spw-count-done">{stats.done}</span>
                    <span className="spw-count-sep">/</span>
                    <span className="spw-count-total">{stats.total}</span>
                  </span>
                  <span className="spw-percent" style={{ color: barColor }}>{stats.percent}%</span>
                </div>
              </div>

              <div className="spw-bar-track">
                <div className="spw-bar-fill" style={{ width: `${stats.percent}%`, background: barColor }} />
                {stats.inProgress > 0 && stats.total > 0 && (
                  <div
                    className="spw-bar-inprogress"
                    style={{
                      width: `${Math.round((stats.inProgress / stats.total) * 100)}%`,
                      left: `${stats.percent}%`,
                      background: `${barColor}33`,
                    }}
                  />
                )}
              </div>

              <div className="spw-chips">
                {stats.done > 0 && (
                  <span className="spw-chip spw-chip--done">
                    <CheckCircle2 size={9} />
                    {stats.done} done
                  </span>
                )}
                {stats.inProgress > 0 && (
                  <span className="spw-chip spw-chip--progress">
                    <Clock size={9} />
                    {stats.inProgress} in progress
                  </span>
                )}
                {stats.todo > 0 && (
                  <span className="spw-chip spw-chip--todo">{stats.todo} todo</span>
                )}
                {completedSprints > 0 && (
                  <span className="spw-chip spw-chip--hist" title={`${completedSprints} completed sprint${completedSprints !== 1 ? 's' : ''}`}>
                    <Users size={9} />
                    {completedSprints} sprint{completedSprints !== 1 ? 's' : ''} done
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {!showAll && channels.length > 5 && (
          <button
            className="spw-show-more"
            onClick={() => setShowAll(true)}
          >
            Show {channels.length - 5} more
          </button>
        )}
      </div>
    </div>
  );
}
