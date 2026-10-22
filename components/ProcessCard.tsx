'use client';

import { useState } from 'react';
import { PM2Process, Project, WatchdogState, CronJob } from '@/lib/types';
import { RotateCcw, Square, Play, Loader2, Settings } from 'lucide-react';

interface ProcessCardProps {
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

export function ProcessCard({
  process,
  project,
  portConflict,
  onStop,
  onRestart,
  onStart,
  onStartConfigured,
  isLoading = false,
}: ProcessCardProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const isConfiguredOnly = !process && project;
  const name = process?.name || project?.server?.pm2Name || project?.name || 'Unknown';
  const status = process?.status || 'not_started';
  const isOnline = status === 'online';
  const isErrored = status === 'errored';
  const isStopped = status === 'stopped';
  const port = process?.port || project?.server?.port || null;
  const uptime = isOnline && process ? process.uptimeFormatted : null;

  const handleAction = async (action: 'stop' | 'restart' | 'start') => {
    setActionLoading(action);
    try {
      if (action === 'stop') await onStop(name);
      else if (action === 'restart') await onRestart(name);
      else if (action === 'start') {
        if (isConfiguredOnly && onStartConfigured) await onStartConfigured();
        else await onStart(name);
      }
    } finally {
      setActionLoading(null);
    }
  };

  // Card class
  let cardClass = 'process-card';
  if (isOnline) cardClass += ' process-card-online';
  else if (isErrored) cardClass += ' process-card-errored';
  else if (isStopped) cardClass += ' process-card-stopped';
  else cardClass += ' process-card-not-started';

  // Status dot class
  let dotClass = 'process-status-dot';
  if (isOnline) dotClass += ' dot-online';
  else if (isErrored) dotClass += ' dot-errored';
  else if (isStopped) dotClass += ' dot-stopped';
  else dotClass += ' dot-not-started';

  // CPU color
  const cpuVal = process?.cpu ?? 0;
  const cpuColor = cpuVal < 50 ? '#22c55e' : cpuVal < 80 ? '#eab308' : '#ef4444';

  return (
    <div className={cardClass}>
      {/* Main row: dot + name + metrics + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={dotClass} style={{ flexShrink: 0 }} />

        {/* Name */}
        <span
          style={{
            fontSize: '0.875rem',
            fontWeight: 600,
            color: '#e4e4e7',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.01em',
          }}
          title={name}
        >
          {name}
        </span>

        {/* Inline metrics — online only */}
        {isOnline && process && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {/* CPU chip */}
            <span style={{
              fontSize: '0.68rem',
              fontFamily: 'monospace',
              color: cpuColor,
              fontWeight: 600,
              minWidth: 36,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {cpuVal.toFixed(1)}%
            </span>
            {/* MEM chip */}
            <span style={{
              fontSize: '0.68rem',
              fontFamily: 'monospace',
              color: '#71717a',
              minWidth: 44,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {process.memoryFormatted}
            </span>
          </div>
        )}

        {/* Hover-reveal actions */}
        <div className="process-card-actions">
          {isOnline && process ? (
            <>
              <ActionButton
                onClick={() => handleAction('restart')}
                disabled={isLoading || actionLoading !== null}
                loading={actionLoading === 'restart'}
                title="Restart"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </ActionButton>
              <ActionButton
                onClick={() => handleAction('stop')}
                disabled={isLoading || actionLoading !== null}
                loading={actionLoading === 'stop'}
                title="Stop"
              >
                <Square className="w-3.5 h-3.5" />
              </ActionButton>
            </>
          ) : (
            <ActionButton
              onClick={() => handleAction('start')}
              disabled={isLoading || actionLoading !== null || !!portConflict}
              loading={actionLoading === 'start'}
              title={portConflict ? `Port conflict: ${portConflict.port} used by ${portConflict.ownedBy}` : 'Start'}
            >
              <Play className="w-3.5 h-3.5" />
            </ActionButton>
          )}
          <ActionButton onClick={() => {}} disabled={false} loading={false} title="Settings">
            <Settings className="w-3.5 h-3.5" />
          </ActionButton>
        </div>
      </div>

      {/* Meta row: port · uptime · CPU bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Port + uptime */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.68rem', color: '#71717a', fontFamily: 'monospace', flex: 1, minWidth: 0 }}>
          {port && <span style={{ color: 'rgba(113,113,122,0.8)' }}>:{port}</span>}
          {port && uptime && <span style={{ color: 'rgba(113,113,122,0.3)' }}>·</span>}
          {uptime && <span>{uptime}</span>}
          {!port && !uptime && !isOnline && (
            <span style={{ color: 'rgba(113,113,122,0.5)', fontFamily: 'sans-serif', fontSize: '0.65rem' }}>
              {isStopped ? 'stopped' : 'not started'}
            </span>
          )}
        </div>

        {/* Inline CPU bar — only when online */}
        {isOnline && process && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, width: 80 }}>
            <div style={{ flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                borderRadius: 2,
                background: cpuColor,
                width: `${Math.min(cpuVal, 100)}%`,
                transition: 'width 600ms ease',
                opacity: cpuVal === 0 ? 0.3 : 1,
                boxShadow: cpuVal > 0 ? `0 0 4px ${cpuColor}80` : 'none',
              }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ActionButton helper ─────────────────────────────────────────────────────

function ActionButton({
  onClick,
  disabled,
  loading,
  title,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
      disabled={disabled}
      title={title}
      style={{
        background: 'none',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: '2px',
        color: '#71717a',
        display: 'flex',
        alignItems: 'center',
        opacity: disabled ? 0.4 : 1,
        transition: 'color 0.15s',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.color = '#e4e4e7'; }}
      onMouseLeave={e => { e.currentTarget.style.color = '#71717a'; }}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : children}
    </button>
  );
}
