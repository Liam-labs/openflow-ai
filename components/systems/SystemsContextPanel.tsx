'use client';

import React from 'react';
import { Play, Square, RotateCcw, X, Server, Clock, Tag, User, ExternalLink } from 'lucide-react';
import type { ContextPanelEntity, EntityStatus } from './systems-types';

interface SystemsContextPanelProps {
  entity: ContextPanelEntity | null;
  visible: boolean;
  onClose: () => void;
  onStart?: (id: string) => void;
  onStop?: (id: string) => void;
  onRestart?: (id: string) => void;
  onViewDetails?: (entity: ContextPanelEntity) => void;
}

export function SystemsContextPanel({
  entity,
  visible,
  onClose,
  onStart,
  onStop,
  onRestart,
  onViewDetails,
}: SystemsContextPanelProps) {
  if (!visible || !entity) return null;

  const canStart = entity.status === 'stopped' || entity.status === 'errored';
  const canStop = entity.status === 'online' || entity.status === 'launching';
  const canRestart = entity.status !== 'unknown';

  return (
    <aside className="systems-context-panel" aria-label="Entity details panel">
      {/* Header */}
      <div className="systems-context-panel__header">
        <div className="systems-context-panel__title-row">
          <div className="systems-context-panel__entity-name">
            <StatusIndicator status={entity.status} />
            <span title={entity.name}>{entity.name}</span>
          </div>
          <button
            className="systems-context-panel__close"
            onClick={onClose}
            aria-label="Close context panel"
          >
            <X size={14} />
          </button>
        </div>
        <div className="systems-context-panel__status-bar">
          <StatusProgressBar status={entity.status} />
        </div>
      </div>

      {/* Actions */}
      {(entity.type === 'service' || entity.type === 'process') && (
        <div className="systems-context-panel__actions">
          <button
            className="systems-context-panel__action systems-context-panel__action--start"
            disabled={!canStart}
            onClick={() => canStart && onStart?.(entity.id)}
            aria-label="Start"
            title="Start"
          >
            <Play size={14} />
            <span>Start</span>
          </button>
          <button
            className="systems-context-panel__action systems-context-panel__action--stop"
            disabled={!canStop}
            onClick={() => canStop && onStop?.(entity.id)}
            aria-label="Stop"
            title="Stop"
          >
            <Square size={14} />
            <span>Stop</span>
          </button>
          <button
            className="systems-context-panel__action systems-context-panel__action--restart"
            disabled={!canRestart}
            onClick={() => canRestart && onRestart?.(entity.id)}
            aria-label="Restart"
            title="Restart"
          >
            <RotateCcw size={14} />
            <span>Restart</span>
          </button>
        </div>
      )}

      {/* Metadata */}
      <div className="systems-context-panel__metadata">
        {entity.category && (
          <MetaRow icon={<Tag size={12} />} label="Category" value={entity.category} />
        )}
        {entity.port && (
          <MetaRow icon={<Server size={12} />} label="Port" value={String(entity.port)} />
        )}
        {entity.pid && (
          <MetaRow icon={<Server size={12} />} label="PID" value={String(entity.pid)} />
        )}
        {entity.uptime && (
          <MetaRow icon={<Clock size={12} />} label="Uptime" value={entity.uptime} />
        )}
        {entity.createdAt && (
          <MetaRow
            icon={<Clock size={12} />}
            label="Created"
            value={formatDate(entity.createdAt)}
          />
        )}
        {entity.owner && (
          <MetaRow icon={<User size={12} />} label="Owner" value={entity.owner} />
        )}
        {entity.cpu !== undefined && (
          <MetaRow icon={<Server size={12} />} label="CPU" value={`${entity.cpu.toFixed(1)}%`} />
        )}
        {entity.memory !== undefined && (
          <MetaRow
            icon={<Server size={12} />}
            label="Memory"
            value={`${(entity.memory / 1024 / 1024).toFixed(1)} MB`}
          />
        )}
      </div>

      {onViewDetails && (
        <div style={{ padding: '0 12px 12px' }}>
          <button
            className="svc-detail__context-btn"
            onClick={() => onViewDetails(entity)}
          >
            <ExternalLink size={13} />
            View Details
          </button>
        </div>
      )}
    </aside>
  );
}

// Sub-components

function StatusIndicator({ status }: { status: EntityStatus }) {
  const cls = `systems-context-panel__status-dot systems-context-panel__status-dot--${status}`;
  return <span className={cls} aria-hidden="true" />;
}

function StatusProgressBar({ status }: { status: EntityStatus }) {
  const pct = status === 'online' ? 100 : status === 'launching' ? 60 : status === 'warning' ? 70 : 0;
  const cls = `systems-context-panel__progress-fill systems-context-panel__progress-fill--${status}`;
  return (
    <div
      className="systems-context-panel__progress-track"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Status: ${status}`}
    >
      <div className={cls} style={{ width: `${pct}%` }} />
    </div>
  );
}

function MetaRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="systems-context-panel__meta-row">
      <span className="systems-context-panel__meta-icon">{icon}</span>
      <span className="systems-context-panel__meta-label">{label}</span>
      <span className="systems-context-panel__meta-value">{value}</span>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}
