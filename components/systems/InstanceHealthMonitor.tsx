'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Activity, RefreshCw, CheckCircle2, XCircle,
  HelpCircle, Clock, Zap, AlertTriangle, Loader2,
} from 'lucide-react';
import type { SupabaseInstance, SupabaseInstanceStatus } from '@/lib/supabase-types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HealthResult {
  checking: boolean;
  ok: boolean | null;
  latencyMs: number | null;
  error: string | null;
  checkedAt: string | null;
}

interface AgentTestResponse {
  success: boolean;
  data?: {
    ok?: boolean;
    latencyMs?: number;
    error?: string;
  };
  error?: string;
}

interface AgentListResponse {
  success: boolean;
  data?: {
    instances?: SupabaseInstance[];
  };
}

export interface InstanceHealthMonitorProps {
  /** Optional: pass pre-loaded instances. If omitted, component fetches them. */
  instances?: SupabaseInstance[];
  /** Auto-refresh interval in seconds (default: 60) */
  refreshInterval?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const abs = Math.abs(diff);
    if (abs < 60_000) return '<1m ago';
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`;
    return `${Math.round(abs / 86_400_000)}d ago`;
  } catch {
    return '';
  }
}

// ─── Status Dot ───────────────────────────────────────────────────────────────

function StatusDot({ status, checking }: { status: SupabaseInstanceStatus; checking: boolean }) {
  if (checking) {
    return (
      <span
        className="sdb-hm__dot sdb-hm__dot--checking"
        role="img"
        aria-label="Checking connectivity"
      />
    );
  }
  const modifiers: Record<SupabaseInstanceStatus, string> = {
    online:  'sdb-hm__dot--online',
    offline: 'sdb-hm__dot--offline',
    error:   'sdb-hm__dot--error',
    unknown: 'sdb-hm__dot--unknown',
  };
  const labels: Record<SupabaseInstanceStatus, string> = {
    online: 'Online', offline: 'Offline', error: 'Error', unknown: 'Unknown',
  };
  return (
    <span
      className={`sdb-hm__dot ${modifiers[status]}`}
      role="img"
      aria-label={labels[status]}
    />
  );
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: SupabaseInstanceStatus }) {
  const configs: Record<SupabaseInstanceStatus, { icon: React.ReactNode; label: string }> = {
    online:  { icon: <CheckCircle2 size={10} aria-hidden="true" />, label: 'Online'  },
    offline: { icon: <XCircle      size={10} aria-hidden="true" />, label: 'Offline' },
    error:   { icon: <AlertTriangle size={10} aria-hidden="true" />, label: 'Error'  },
    unknown: { icon: <HelpCircle   size={10} aria-hidden="true" />, label: 'Unknown' },
  };
  const { icon, label } = configs[status];
  return (
    <span className={`sdb-hm__status-badge sdb-hm__status-badge--${status}`}>
      {icon}
      {label}
    </span>
  );
}

// ─── Instance Row ─────────────────────────────────────────────────────────────

function InstanceRow({
  instance,
  health,
  onCheck,
}: {
  instance: SupabaseInstance;
  health: HealthResult;
  onCheck: () => void;
}) {
  const urlDisplay = instance.connection.url.replace(/^https?:\/\//, '');
  const lastChecked = health.checkedAt ?? instance.lastCheckedAt;

  return (
    <div
      className={`sdb-hm__instance sdb-hm__instance--${instance.status}`}
      role="listitem"
    >
      <StatusDot status={instance.status} checking={health.checking} />

      <div className="sdb-hm__instance-info">
        <span className="sdb-hm__instance-name">{instance.name}</span>
        <span className="sdb-hm__instance-url" title={instance.connection.url}>
          {urlDisplay}
        </span>
        {health.error && (
          <span className="sdb-hm__instance-error" role="alert" title={health.error}>
            {health.error}
          </span>
        )}
      </div>

      <div className="sdb-hm__instance-meta">
        <StatusBadge status={instance.status} />

        {health.latencyMs !== null && (
          <span className="sdb-hm__latency" title="Response latency">
            <Zap size={10} aria-hidden="true" />
            {health.latencyMs}ms
          </span>
        )}

        <span className="sdb-hm__last-checked" title={lastChecked ?? undefined}>
          <Clock size={10} aria-hidden="true" />
          {formatRelative(lastChecked)}
        </span>
      </div>

      <button
        className="sdb-hm__check-btn"
        onClick={onCheck}
        disabled={health.checking}
        aria-label={`Check connectivity for ${instance.name}`}
        title="Test connectivity"
      >
        {health.checking ? (
          <Loader2 size={11} className="sdb-db__spinner" aria-hidden="true" />
        ) : (
          <RefreshCw size={11} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const DEFAULT_REFRESH_INTERVAL = 60;

export function InstanceHealthMonitor({
  instances: instancesProp,
  refreshInterval = DEFAULT_REFRESH_INTERVAL,
}: InstanceHealthMonitorProps) {
  const [instances, setInstances] = useState<SupabaseInstance[]>(instancesProp ?? []);
  const [loadingInstances, setLoadingInstances] = useState(!instancesProp);
  const [healthMap, setHealthMap] = useState<Map<string, HealthResult>>(new Map());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [countdown, setCountdown] = useState(refreshInterval);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Instance list sync ──────────────────────────────────────────────────────

  // If instances are passed as prop, keep in sync
  useEffect(() => {
    if (instancesProp) {
      setInstances(instancesProp);
      setLoadingInstances(false);
    }
  }, [instancesProp]);

  // If no prop, fetch from agent API
  const fetchInstances = useCallback(async () => {
    if (instancesProp) return;
    try {
      const res = await fetch('/api/supabase/instances');
      const data: AgentListResponse = await res.json();
      if (data.success && data.data?.instances) {
        setInstances(data.data.instances);
      }
    } catch { /* silent */ }
    finally { setLoadingInstances(false); }
  }, [instancesProp]);

  useEffect(() => { fetchInstances(); }, [fetchInstances]);

  // ── Health check ────────────────────────────────────────────────────────────

  const checkInstance = useCallback(async (instanceId: string) => {
    setHealthMap(prev => {
      const next = new Map(prev);
      const existing = next.get(instanceId);
      next.set(instanceId, {
        checking: true,
        ok: existing?.ok ?? null,
        latencyMs: existing?.latencyMs ?? null,
        error: null,
        checkedAt: existing?.checkedAt ?? null,
      });
      return next;
    });

    try {
      const res = await fetch('/api/supabase/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', id: instanceId }),
      });
      const data: AgentTestResponse = await res.json();

      const ok = data.success && (data.data?.ok ?? false);
      setHealthMap(prev => {
        const next = new Map(prev);
        next.set(instanceId, {
          checking: false,
          ok,
          latencyMs: data.data?.latencyMs ?? null,
          error: ok ? null : (data.data?.error ?? data.error ?? 'Connection failed'),
          checkedAt: new Date().toISOString(),
        });
        return next;
      });

      // Refresh instance list to pick up updated status stored server-side
      fetchInstances();
    } catch (err) {
      setHealthMap(prev => {
        const next = new Map(prev);
        next.set(instanceId, {
          checking: false,
          ok: false,
          latencyMs: null,
          error: err instanceof Error ? err.message : 'Network error',
          checkedAt: new Date().toISOString(),
        });
        return next;
      });
    }
  }, [fetchInstances]);

  const checkAll = useCallback(() => {
    instances.forEach(i => checkInstance(i.id));
    setCountdown(refreshInterval);
  }, [instances, checkInstance, refreshInterval]);

  // ── Auto-refresh countdown ──────────────────────────────────────────────────

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (!autoRefresh || instances.length === 0) return;

    intervalRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          checkAll();
          return refreshInterval;
        }
        return prev - 1;
      });
    }, 1_000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, instances.length, checkAll, refreshInterval]);

  // ── Derived ─────────────────────────────────────────────────────────────────

  const anyChecking = [...healthMap.values()].some(h => h.checking);
  const onlineCount = instances.filter(i => i.status === 'online').length;
  const errorCount  = instances.filter(i => i.status === 'error' || i.status === 'offline').length;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="sdb-hm">

      {/* Header */}
      <div className="sdb-hm__header">
        <div className="sdb-hm__header-left">
          <Activity size={13} className="sdb-hm__header-icon" aria-hidden="true" />
          <span className="sdb-hm__header-title">Health</span>
          {!loadingInstances && instances.length > 0 && (
            <>
              <span
                className="sdb-hm__pill sdb-hm__pill--online"
                title={`${onlineCount} online`}
              >
                {onlineCount} online
              </span>
              {errorCount > 0 && (
                <span
                  className="sdb-hm__pill sdb-hm__pill--error"
                  title={`${errorCount} offline/error`}
                >
                  {errorCount} offline
                </span>
              )}
            </>
          )}
        </div>

        <div className="sdb-hm__header-right">
          {autoRefresh && instances.length > 0 && (
            <span className="sdb-hm__countdown" aria-label={`Auto-refresh in ${countdown} seconds`}>
              <Clock size={10} aria-hidden="true" />
              {countdown >= 60
                ? `${Math.floor(countdown / 60)}m ${countdown % 60}s`
                : `${countdown}s`}
            </span>
          )}
          <button
            className={`sdb-hm__auto-btn${autoRefresh ? ' sdb-hm__auto-btn--active' : ''}`}
            onClick={() => setAutoRefresh(v => !v)}
            aria-pressed={autoRefresh}
            title={autoRefresh ? 'Disable auto-refresh' : 'Enable auto-refresh'}
          >
            Auto
          </button>
          <button
            className="sdb-hm__refresh-all"
            onClick={checkAll}
            disabled={anyChecking || instances.length === 0 || loadingInstances}
            aria-label="Check all instances"
            title="Check all instances now"
          >
            {anyChecking ? (
              <Loader2 size={12} className="sdb-db__spinner" aria-hidden="true" />
            ) : (
              <RefreshCw size={12} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Instance list */}
      <div className="sdb-hm__list" role="list" aria-label="Supabase instance health">
        {loadingInstances ? (
          <div className="sdb-hm__state-row" aria-live="polite">
            <Loader2 size={13} className="sdb-db__spinner" aria-hidden="true" />
            <span>Loading instances…</span>
          </div>
        ) : instances.length === 0 ? (
          <div className="sdb-hm__state-row">
            No instances registered.
          </div>
        ) : (
          instances.map(instance => (
            <InstanceRow
              key={instance.id}
              instance={instance}
              health={healthMap.get(instance.id) ?? {
                checking: false,
                ok: null,
                latencyMs: null,
                error: null,
                checkedAt: null,
              }}
              onCheck={() => checkInstance(instance.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
