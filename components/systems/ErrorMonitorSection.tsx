'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AlertCircle, RefreshCw, ChevronDown, ChevronRight, Radio } from 'lucide-react';
import { useEventStreamMulti } from '@/lib/contexts/EventStreamContext';
import type { TrackedError, StatsSnapshot } from '@/lib/error-tracker';
import type { ErrorEventPayload } from '@/lib/event-bus';

// ─── Types ──────────────────────────────────────────────────────────────────

type SourceFilter = 'all' | 'error:api' | 'error:collab' | 'error:agent';

interface ErrorStats {
  last1h: StatsSnapshot;
  last24h: StatsSnapshot;
  total: number;
  bufferSize: number;
}

interface SparkBucket {
  ts: number;    // minute bucket (Unix ms, floor to 5-min)
  count: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<TrackedError['severity'], number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

const SEVERITY_LABELS: Record<TrackedError['severity'], string> = {
  critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW',
};

const SOURCE_LABELS: Record<SourceFilter, string> = {
  all: 'All',
  'error:api': 'API',
  'error:collab': 'Collab',
  'error:agent': 'Agent',
};

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const abs = Math.abs(diff);
    if (abs < 60_000) return '<1m';
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h`;
    return `${Math.round(abs / 86_400_000)}d`;
  } catch { return ''; }
}

/** Group an array of TrackedErrors into 5-minute buckets for the sparkline. */
function buildSparkline(errors: TrackedError[], buckets = 24): SparkBucket[] {
  const now = Date.now();
  const bucketMs = 5 * 60_000;
  const windowMs = buckets * bucketMs;
  const earliest = now - windowMs;

  // Initialise all buckets to 0
  const map = new Map<number, number>();
  for (let i = 0; i < buckets; i++) {
    const ts = Math.floor((earliest + i * bucketMs) / bucketMs) * bucketMs;
    map.set(ts, 0);
  }

  // Accumulate error counts
  for (const e of errors) {
    const t = new Date(e.lastSeen).getTime();
    if (t < earliest) continue;
    const bucket = Math.floor(t / bucketMs) * bucketMs;
    map.set(bucket, (map.get(bucket) ?? 0) + e.count);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([ts, count]) => ({ ts, count }));
}

/** Render an SVG sparkline path from bucket data. */
function Sparkline({ data, width = 200, height = 36 }: {
  data: SparkBucket[];
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;

  const max = Math.max(...data.map(d => d.count), 1);
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const points = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * innerW;
    const y = pad + innerH - (d.count / max) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD = `M ${points.join(' L ')}`;

  // Fill area under the line
  const fillPoints = [
    `${pad},${pad + innerH}`,
    ...points,
    `${pad + innerW},${pad + innerH}`,
  ];
  const fillD = `M ${fillPoints.join(' L ')} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="ems-sparkline-svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="ems-spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(239,68,68,0.25)" />
          <stop offset="100%" stopColor="rgba(239,68,68,0)" />
        </linearGradient>
      </defs>
      <path d={fillD} fill="url(#ems-spark-fill)" />
      <path d={pathD} fill="none" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Error Row ───────────────────────────────────────────────────────────────

function ErrorRow({ error, expanded, onToggle }: {
  error: TrackedError;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasDetail = !!(error.stack || error.requestId || error.context);

  return (
    <div className={`ems-row ems-row--${error.severity}`}>
      <button className="ems-row__main" onClick={hasDetail ? onToggle : undefined} aria-expanded={expanded}>
        <span className={`ems-severity-badge ems-severity-badge--${error.severity}`}>
          {SEVERITY_LABELS[error.severity]}
        </span>
        <span className="ems-row__source">
          {error.type === 'error:api' ? 'api' : error.type === 'error:collab' ? 'collab' : 'agent'}
        </span>
        <span className="ems-row__message" title={error.message}>
          {error.message}
        </span>
        <span className="ems-row__meta">
          {error.count > 1 && <span className="ems-row__count">×{error.count}</span>}
          <span className="ems-row__time">{formatRelative(error.lastSeen)}</span>
        </span>
        {hasDetail && (
          <span className="ems-row__expand">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>

      {expanded && hasDetail && (
        <div className="ems-detail">
          {error.source && (
            <div className="ems-detail__line">
              <span className="ems-detail__key">source</span>
              <span className="ems-detail__val">{error.source}</span>
            </div>
          )}
          {error.requestId && (
            <div className="ems-detail__line">
              <span className="ems-detail__key">requestId</span>
              <code className="ems-detail__code">{error.requestId}</code>
            </div>
          )}
          {error.stack && (
            <div className="ems-detail__line ems-detail__line--stack">
              <span className="ems-detail__key">stack</span>
              <code className="ems-detail__stack">{error.stack}</code>
            </div>
          )}
          {error.context && Object.keys(error.context).length > 0 && (
            <div className="ems-detail__line ems-detail__line--stack">
              <span className="ems-detail__key">context</span>
              <code className="ems-detail__stack">
                {JSON.stringify(error.context, null, 2)}
              </code>
            </div>
          )}
          <div className="ems-detail__line">
            <span className="ems-detail__key">first seen</span>
            <span className="ems-detail__val">{new Date(error.firstSeen).toLocaleTimeString()}</span>
            {error.count > 1 && (
              <>
                <span className="ems-detail__key" style={{ marginLeft: 12 }}>last seen</span>
                <span className="ems-detail__val">{new Date(error.lastSeen).toLocaleTimeString()}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="ems-skeleton">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="ems-skeleton__row" style={{ animationDelay: `${i * 80}ms` }}>
          <div className="ems-skeleton__badge" />
          <div className="ems-skeleton__source" />
          <div className="ems-skeleton__line" style={{ width: `${40 + (i % 3) * 15}%` }} />
          <div className="ems-skeleton__time" />
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function ErrorMonitorSection() {
  const [errors, setErrors] = useState<TrackedError[]>([]);
  const [stats, setStats] = useState<ErrorStats | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchErrors = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'errors.list', limit: 100 }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.data?.errors) {
        setErrors(data.data.errors as TrackedError[]);
      }
    } catch { /* SSE will keep live data flowing */ }
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'errors.stats' }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.data) {
        setStats(data.data as ErrorStats);
      }
    } catch { /* silent */ }
  }, []);

  // Initial load
  useEffect(() => {
    fetchErrors();
    fetchStats();

    // Refresh stats every 30s
    statsTimerRef.current = setInterval(fetchStats, 30_000);
    return () => {
      if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    };
  }, [fetchErrors, fetchStats]);

  // ── SSE live feed ──────────────────────────────────────────────────────────

  const { isConnected } = useEventStreamMulti<{ type: string; payload: ErrorEventPayload }>(
    ['error:api', 'error:collab', 'error:agent'],
    (_data, msg) => {
      // An error just fired — refresh the list from the tracker (dedup is server-side)
      fetchErrors();
      fetchStats();
    }
  );

  // ── Interaction ────────────────────────────────────────────────────────────

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────

  const filtered = sourceFilter === 'all'
    ? errors
    : errors.filter(e => e.type === sourceFilter);

  const sparkData = buildSparkline(errors);

  const critCount = stats?.last1h.bySeverity.critical ?? 0;
  const highCount = stats?.last1h.bySeverity.high ?? 0;
  const medCount = stats?.last1h.bySeverity.medium ?? 0;
  const lowCount = stats?.last1h.bySeverity.low ?? 0;
  const totalCount = (stats?.last1h.count ?? 0);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="ems-page">
      {/* Header */}
      <div className="ems-header">
        <div className="ems-header-left">
          <AlertCircle size={15} className="ems-header-icon" />
          <h2 className="ems-header-title">Error Monitor</h2>
          {isConnected && (
            <span className="ems-live-badge" title="Live SSE feed active">
              <Radio size={9} className="ems-live-badge__dot" />
              LIVE
            </span>
          )}
        </div>
        <div className="ems-header-right">
          <span className="ems-window-label">Last 1h</span>
          <button
            className="ems-refresh"
            onClick={() => { fetchErrors(true); fetchStats(); }}
            disabled={refreshing}
            title="Refresh"
            aria-label="Refresh errors"
          >
            <RefreshCw size={13} className={refreshing ? 'ems-refresh--spinning' : ''} />
          </button>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="ems-stats-bar">
        <div className="ems-stat-pill ems-stat-pill--critical">
          <span className="ems-stat-pill__count">{critCount}</span>
          <span className="ems-stat-pill__label">critical</span>
        </div>
        <div className="ems-stat-pill ems-stat-pill--high">
          <span className="ems-stat-pill__count">{highCount}</span>
          <span className="ems-stat-pill__label">high</span>
        </div>
        <div className="ems-stat-pill ems-stat-pill--medium">
          <span className="ems-stat-pill__count">{medCount}</span>
          <span className="ems-stat-pill__label">medium</span>
        </div>
        <div className="ems-stat-pill ems-stat-pill--low">
          <span className="ems-stat-pill__count">{lowCount}</span>
          <span className="ems-stat-pill__label">low</span>
        </div>
        <div className="ems-stat-divider" />
        <div className="ems-sparkline-wrap" aria-label={`${totalCount} errors in last hour`}>
          <span className="ems-sparkline-label">{totalCount} total</span>
          <Sparkline data={sparkData} width={140} height={32} />
        </div>
      </div>

      {/* Source Filters */}
      <div className="ems-filters" role="tablist" aria-label="Filter by error source">
        {(['all', 'error:api', 'error:collab', 'error:agent'] as SourceFilter[]).map(f => {
          const count = f === 'all'
            ? errors.length
            : errors.filter(e => e.type === f).length;
          return (
            <button
              key={f}
              role="tab"
              aria-selected={sourceFilter === f}
              className={`ems-filter-tab${sourceFilter === f ? ' ems-filter-tab--active' : ''}`}
              onClick={() => setSourceFilter(f)}
            >
              {SOURCE_LABELS[f]}
              {count > 0 && (
                <span className={`ems-filter-count${f !== 'all' && count > 0 ? ` ems-filter-count--${f.replace('error:', '')}` : ''}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Error List */}
      <div className="ems-list" role="log" aria-label="Error log" aria-live="polite">
        {loading ? (
          <LoadingSkeleton />
        ) : filtered.length === 0 ? (
          <div className="ems-empty">
            <span className="ems-empty__icon">✓</span>
            <span className="ems-empty__text">
              {sourceFilter === 'all' ? 'No errors recorded' : `No ${SOURCE_LABELS[sourceFilter].toLowerCase()} errors`}
            </span>
          </div>
        ) : (
          filtered.map(e => (
            <ErrorRow
              key={e.id}
              error={e}
              expanded={expandedIds.has(e.id)}
              onToggle={() => toggleExpanded(e.id)}
            />
          ))
        )}
      </div>

      {/* Footer stats */}
      {stats && !loading && (
        <div className="ems-footer">
          <span className="ems-footer__stat">
            Buffer: {stats.total}/{stats.bufferSize}
          </span>
          {stats.last24h.count > 0 && (
            <span className="ems-footer__stat">
              24h: {stats.last24h.count} events ({stats.last24h.uniqueErrors} unique)
            </span>
          )}
        </div>
      )}
    </div>
  );
}
