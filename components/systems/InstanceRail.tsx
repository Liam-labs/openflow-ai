'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  HardDrive, Cloud, Plus, Search, MoreHorizontal,
  Edit2, Wifi, Trash2, Loader2, RefreshCw, Clock,
} from 'lucide-react';
import type { SupabaseInstance, SupabaseInstanceStatus } from '@/lib/supabase-types';
import './SupabaseRail.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HealthState {
  checking: boolean;
  latencyMs: number | null;
  error: string | null;
  checkedAt: string | null;
}

export interface InstanceRailProps {
  instances: SupabaseInstance[];
  selectedId: string | null;
  discoverLoading?: boolean;
  onSelect: (id: string) => void;
  onEdit: (inst: SupabaseInstance) => void;
  onDelete: (inst: SupabaseInstance) => void;
  onTest: (id: string) => void;
  onDiscover: () => void;
  onAdd: () => void;
}

// ─── Status Pulse ─────────────────────────────────────────────────────────────

function RailPulse({ status, checking }: { status: SupabaseInstanceStatus; checking: boolean }) {
  if (checking) {
    return <span className="sdb-rail-pulse sdb-rail-pulse--checking" aria-label="Checking" />;
  }
  return (
    <span className={`sdb-rail-pulse sdb-rail-pulse--${status}`} role="img" aria-label={status}>
      {status === 'online' && <span className="sdb-rail-pulse__ring" />}
      <span className="sdb-rail-pulse__dot" />
    </span>
  );
}

// ─── Context Menu ─────────────────────────────────────────────────────────────

function RailContextMenu({ onEdit, onTest, onDelete, onClose }: {
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="sdb-rail-ctx" role="menu">
      <button className="sdb-rail-ctx__item" role="menuitem" onClick={() => { onEdit(); onClose(); }}>
        <Edit2 size={10} /> Edit
      </button>
      <button className="sdb-rail-ctx__item" role="menuitem" onClick={() => { onTest(); onClose(); }}>
        <Wifi size={10} /> Test
      </button>
      <div className="sdb-rail-ctx__sep" />
      <button className="sdb-rail-ctx__item sdb-rail-ctx__item--danger" role="menuitem"
        onClick={() => { onDelete(); onClose(); }}>
        <Trash2 size={10} /> Delete
      </button>
    </div>
  );
}

// ─── Instance Row ─────────────────────────────────────────────────────────────

function InstanceRow({
  instance, health, isSelected, onSelect, onEdit, onDelete, onTest,
}: {
  instance: SupabaseInstance;
  health: HealthState;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  const [ctxOpen, setCtxOpen] = useState(false);

  const urlDisplay = instance.connection.url
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');

  const showLatency = health.latencyMs !== null && !health.checking;
  const latencyClass = (health.latencyMs ?? 0) > 100
    ? 'sdb-rail-latency--slow'
    : 'sdb-rail-latency--fast';

  function formatChecked(iso: string | null): string {
    if (!iso) return '';
    try {
      const diff = Date.now() - new Date(iso).getTime();
      const abs = Math.abs(diff);
      if (abs < 60_000) return '<1m';
      if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
      if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h`;
      return `${Math.round(abs / 86_400_000)}d`;
    } catch { return ''; }
  }

  const checkedLabel = formatChecked(health.checkedAt ?? instance.lastCheckedAt);

  return (
    <div
      className={`sdb-rail-row${isSelected ? ' sdb-rail-row--active' : ''} sdb-rail-row--${instance.status}`}
      role="option"
      aria-selected={isSelected}
    >
      <button
        className="sdb-rail-row__main"
        onClick={onSelect}
        aria-label={`Select ${instance.name}`}
      >
        <RailPulse status={instance.status} checking={health.checking} />

        <div className="sdb-rail-row__info">
          <span className="sdb-rail-row__name">{instance.name}</span>
          <span className="sdb-rail-row__url" title={instance.connection.url}>{urlDisplay}</span>
          {health.error && !health.checking && (
            <span className="sdb-rail-row__error" title={health.error}>
              {health.error.length > 38 ? health.error.slice(0, 36) + '…' : health.error}
            </span>
          )}
        </div>

        <div className="sdb-rail-row__meta">
          <span className={`sdb-rail-type sdb-rail-type--${instance.type}`}>
            {instance.type === 'local'
              ? <HardDrive size={9} aria-hidden="true" />
              : <Cloud size={9} aria-hidden="true" />}
            {instance.type}
          </span>

          {showLatency && (
            <span className={`sdb-rail-latency ${latencyClass}`} title="Last check latency">
              {health.latencyMs}ms
            </span>
          )}

          {checkedLabel && (
            <span className="sdb-rail-checked" title={`Last checked: ${health.checkedAt ?? instance.lastCheckedAt ?? ''}`}>
              <Clock size={8} aria-hidden="true" />
              {checkedLabel}
            </span>
          )}
        </div>
      </button>

      <div className="sdb-rail-row__actions">
        <button
          className={`sdb-rail-ctx-btn${ctxOpen ? ' sdb-rail-ctx-btn--open' : ''}`}
          onClick={e => { e.stopPropagation(); setCtxOpen(o => !o); }}
          aria-label={`Options for ${instance.name}`}
          aria-expanded={ctxOpen}
        >
          <MoreHorizontal size={11} />
        </button>
        {ctxOpen && (
          <RailContextMenu
            onEdit={() => { onEdit(); setCtxOpen(false); }}
            onTest={() => { onTest(); setCtxOpen(false); }}
            onDelete={() => { onDelete(); setCtxOpen(false); }}
            onClose={() => setCtxOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Section Divider ─────────────────────────────────────────────────────────

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="sdb-rail-section" aria-label={`${label} instances`}>
      <span className="sdb-rail-section__label">{label}</span>
      <span className="sdb-rail-section__line" aria-hidden="true" />
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 60;

export function InstanceRail({
  instances,
  selectedId,
  discoverLoading = false,
  onSelect,
  onEdit,
  onDelete,
  onTest,
  onDiscover,
  onAdd,
}: InstanceRailProps) {
  const [healthMap, setHealthMap] = useState<Map<string, HealthState>>(new Map());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Health check ────────────────────────────────────────────────────────────

  const checkInstance = useCallback(async (instanceId: string) => {
    setHealthMap(prev => {
      const next = new Map(prev);
      const ex = next.get(instanceId);
      next.set(instanceId, {
        checking: true,
        latencyMs: ex?.latencyMs ?? null,
        error: null,
        checkedAt: ex?.checkedAt ?? null,
      });
      return next;
    });

    try {
      const res = await fetch('/api/supabase/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', id: instanceId }),
      });
      const data = await res.json();
      const ok = data.success && (data.data?.ok ?? false);
      setHealthMap(prev => {
        const next = new Map(prev);
        next.set(instanceId, {
          checking: false,
          latencyMs: data.data?.latencyMs ?? null,
          error: ok ? null : (data.data?.error ?? data.error ?? 'Connection failed'),
          checkedAt: new Date().toISOString(),
        });
        return next;
      });
    } catch (err) {
      setHealthMap(prev => {
        const next = new Map(prev);
        next.set(instanceId, {
          checking: false,
          latencyMs: null,
          error: err instanceof Error ? err.message : 'Network error',
          checkedAt: new Date().toISOString(),
        });
        return next;
      });
    }
  }, []);

  const checkAll = useCallback(() => {
    instances.forEach(i => checkInstance(i.id));
    setCountdown(REFRESH_INTERVAL);
  }, [instances, checkInstance]);

  // ── Initial check on mount ──────────────────────────────────────────────────

  const checkedOnMount = useRef(false);
  useEffect(() => {
    if (instances.length === 0 || checkedOnMount.current) return;
    checkedOnMount.current = true;
    instances.forEach(i => checkInstance(i.id));
  }, [instances, checkInstance]);

  // ── Auto-refresh countdown ──────────────────────────────────────────────────

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (!autoRefresh || instances.length === 0) return;

    intervalRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          checkAll();
          return REFRESH_INTERVAL;
        }
        return prev - 1;
      });
    }, 1_000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, instances.length, checkAll]);

  // ── Sort: local first, then hosted ─────────────────────────────────────────

  const sorted = [...instances].sort((a, b) =>
    a.type === b.type ? 0 : a.type === 'local' ? -1 : 1
  );

  const localInstances  = sorted.filter(i => i.type === 'local');
  const hostedInstances = sorted.filter(i => i.type === 'hosted');

  const anyChecking = [...healthMap.values()].some(h => h.checking);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="sdb-rail" role="listbox" aria-label="Supabase instances">

      {/* Rail header */}
      <div className="sdb-rail__header">
        <div className="sdb-rail__header-left">
          <span className="sdb-rail__title">Instances</span>
          {instances.length > 0 && (
            <span className="sdb-rail__online-count">
              {instances.filter(i => i.status === 'online').length}/{instances.length}
            </span>
          )}
        </div>
        <div className="sdb-rail__header-right">
          {autoRefresh && instances.length > 0 && (
            <span className="sdb-rail__countdown" title={`Auto-refresh in ${countdown}s`}>
              {countdown >= 60
                ? `${Math.floor(countdown / 60)}m${countdown % 60}s`
                : `${countdown}s`}
            </span>
          )}
          <button
            className={`sdb-rail__auto-btn${autoRefresh ? ' sdb-rail__auto-btn--on' : ''}`}
            onClick={() => setAutoRefresh(v => !v)}
            aria-pressed={autoRefresh}
            title={autoRefresh ? 'Disable auto-refresh' : 'Enable auto-refresh'}
          >
            Auto
          </button>
          <button
            className="sdb-rail__refresh-btn"
            onClick={checkAll}
            disabled={anyChecking || instances.length === 0}
            aria-label="Refresh all instances"
            title="Check all now"
          >
            {anyChecking
              ? <Loader2 size={11} className="sdb-rail__spin" aria-hidden="true" />
              : <RefreshCw size={11} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* Instance list */}
      <div className="sdb-rail__list">
        {instances.length === 0 ? (
          <div className="sdb-rail__empty">No instances registered</div>
        ) : (
          <>
            {localInstances.length > 0 && (
              <>
                <SectionDivider label="Local" />
                {localInstances.map(inst => (
                  <InstanceRow
                    key={inst.id}
                    instance={inst}
                    health={healthMap.get(inst.id) ?? {
                      checking: false, latencyMs: null, error: null, checkedAt: null,
                    }}
                    isSelected={selectedId === inst.id}
                    onSelect={() => onSelect(inst.id)}
                    onEdit={() => onEdit(inst)}
                    onDelete={() => onDelete(inst)}
                    onTest={() => onTest(inst.id)}
                  />
                ))}
              </>
            )}

            {hostedInstances.length > 0 && (
              <>
                <SectionDivider label="Hosted" />
                {hostedInstances.map(inst => (
                  <InstanceRow
                    key={inst.id}
                    instance={inst}
                    health={healthMap.get(inst.id) ?? {
                      checking: false, latencyMs: null, error: null, checkedAt: null,
                    }}
                    isSelected={selectedId === inst.id}
                    onSelect={() => onSelect(inst.id)}
                    onEdit={() => onEdit(inst)}
                    onDelete={() => onDelete(inst)}
                    onTest={() => onTest(inst.id)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* Bottom actions */}
      <div className="sdb-rail__actions">
        <button
          className="sdb-rail__action-btn sdb-rail__action-btn--discover"
          onClick={onDiscover}
          disabled={discoverLoading}
          title="Auto-discover Supabase projects"
        >
          {discoverLoading
            ? <Loader2 size={10} className="sdb-rail__spin" aria-hidden="true" />
            : <Search size={10} aria-hidden="true" />}
          Discover
        </button>
        <button
          className="sdb-rail__action-btn sdb-rail__action-btn--add"
          onClick={onAdd}
          title="Add instance manually"
        >
          <Plus size={10} aria-hidden="true" />
          Add
        </button>
      </div>
    </div>
  );
}
