'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ServiceHealth {
  name: string;
  status: 'up' | 'degraded' | 'down' | 'unknown';
  latencyMs?: number;
}

interface OverviewData {
  dbSizeMb: number;
  apiRequestsToday: number;
  usersTotal: number;
  errorsToday: number;
  apiRequestsHistory: number[];
  services: ServiceHealth[];
}

interface ActivityItem {
  id: string;
  type: 'query' | 'auth' | 'error' | 'system' | 'storage';
  message: string;
  source?: string;
  timestamp: string;
}

interface Props { instanceId: string; }

interface SchemaStats {
  tableCount: number | null;
  applied: number | null;
  pending: number | null;
  lastAppliedAt: string | null;
  loading: boolean;
  error: string | null;
}

// ─── Format helpers ────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtSize(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return mb.toFixed(0) + ' MB';
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const abs = Math.abs(diff);
    if (abs < 60_000) return '<1m ago';
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`;
    return `${Math.round(abs / 86_400_000)}d ago`;
  } catch { return ''; }
}

// ─── Schema Stat Cell ──────────────────────────────────────────────────────────

function SchemaStatCell({ value, label, warn = false }: {
  value: string | number | null;
  label: string;
  warn?: boolean;
}) {
  return (
    <div className="sdb-stat-cell">
      <span className={`sdb-stat-cell__val${warn ? ' sdb-stat-cell__val--warn' : ''}`}>
        {value !== null ? value : '—'}
      </span>
      <span className="sdb-stat-cell__label">{label}</span>
    </div>
  );
}

// ─── Stat Card ─────────────────────────────────────────────────────────────────

type AccentKey = 'jade' | 'cyan' | 'violet' | 'amber';

const ACCENT_VARS: Record<AccentKey, string> = {
  jade:   '#00d68f',
  cyan:   '#22d3ee',
  violet: '#a78bfa',
  amber:  '#f59e0b',
};

interface CardProps {
  label: string;
  value: string;
  accent: AccentKey;
  index: number;
}

function StatCard({ label, value, accent, index }: CardProps) {
  const color = ACCENT_VARS[accent];
  return (
    <div
      className="sbo-card"
      style={{ '--sbo-accent': color, animationDelay: `${index * 80}ms` } as React.CSSProperties}
    >
      <div className="sbo-card-body">
        <div className="sbo-card-label">{label}</div>
        <div className="sbo-card-value">{value}</div>
      </div>
      <div
        className="sbo-card-glow"
        style={{ background: `radial-gradient(circle at 50% 0%, ${color}20 0%, transparent 70%)` }}
      />
    </div>
  );
}

// ─── API Request Bar Chart ─────────────────────────────────────────────────────

function ApiChart({ data }: { data: number[] }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 400);
    return () => clearTimeout(t);
  }, []);

  const max = Math.max(...data, 1);
  const now = new Date().getHours();

  return (
    <div className="sbo-chart-wrap">
      <div className="sbo-section-title">API REQUESTS · 24H</div>
      <div className="sbo-chart">
        {data.map((v, i) => {
          const pct = (v / max) * 100;
          const hour = (now - (23 - i) + 24) % 24;
          const isCurrent = i === 23;
          return (
            <div key={i} className="sbo-bar-track">
              <div
                className={`sbo-bar${isCurrent ? ' sbo-bar--now' : ''}`}
                style={{
                  height: ready ? `${Math.max(pct, 2)}%` : '2%',
                  transitionDelay: `${i * 18}ms`,
                }}
                aria-label={`${String(hour).padStart(2,'0')}:00 — ${v.toLocaleString()} requests`}
              />
              {i % 6 === 0 && (
                <span className="sbo-bar-tick">{String(hour).padStart(2,'0')}</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="sbo-chart-max">
        <span className="sbo-chart-max-label">peak: {fmtNum(max)}</span>
      </div>
    </div>
  );
}

// ─── Health Grid ──────────────────────────────────────────────────────────────

function HealthGrid({ services }: { services: ServiceHealth[] }) {
  return (
    <div className="sbo-health-wrap">
      <div className="sbo-section-title">SERVICE HEALTH</div>
      <div className="sbo-health-grid">
        {services.map((s, i) => (
          <div key={s.name} className="sbo-health-row" style={{ animationDelay: `${i * 50}ms` }}>
            <span className={`sbo-dot sbo-dot--${s.status}`}>
              <span className="sbo-dot-ring" />
              <span className="sbo-dot-core" />
            </span>
            <span className="sbo-health-name">{s.name}</span>
            {s.latencyMs !== undefined && (
              <span className={`sbo-health-lat${s.latencyMs > 100 ? ' sbo-health-lat--slow' : ''}`}>
                {s.latencyMs}ms
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Activity Feed ────────────────────────────────────────────────────────────

const FEED_ICON: Record<ActivityItem['type'], string> = {
  query: 'Q', auth: 'A', error: '!', system: 'S', storage: 'F',
};

function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <div className="sbo-feed-wrap">
      <div className="sbo-section-title">
        LIVE ACTIVITY
        <span className="sbo-feed-live-badge">
          <span className="sbo-feed-live-dot" />
          LIVE
        </span>
      </div>
      <div className="sbo-feed" role="log" aria-live="polite" aria-label="Activity feed">
        {items.length === 0 ? (
          <div className="sbo-feed-empty">Waiting for activity…</div>
        ) : (
          items.map((item, i) => (
            <div
              key={item.id}
              className={`sbo-feed-item sbo-feed-item--${item.type}`}
              style={{ animationDelay: `${i * 15}ms` }}
            >
              <span className={`sbo-feed-icon sbo-feed-icon--${item.type}`} aria-hidden="true">
                {FEED_ICON[item.type]}
              </span>
              <div className="sbo-feed-content">
                <code className="sbo-feed-msg">
                  {item.message.length > 72 ? item.message.slice(0, 69) + '…' : item.message}
                </code>
                {item.source && <span className="sbo-feed-src">{item.source}</span>}
              </div>
              <time className="sbo-feed-time" dateTime={item.timestamp}>
                {item.timestamp.slice(11, 19)}
              </time>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Error State ──────────────────────────────────────────────────────────────

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="sbo-error-state">
      <AlertTriangle size={20} className="sbo-error-state__icon" />
      <p className="sbo-error-state__msg">{message}</p>
      <button className="sbo-error-state__retry" onClick={onRetry}>
        <RefreshCw size={12} />
        Retry
      </button>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export function SupabaseOverviewPanel({ instanceId }: Props) {
  const [data, setData]         = useState<OverviewData | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [schema, setSchema]     = useState<SchemaStats>({
    tableCount: null, applied: null, pending: null, lastAppliedAt: null, loading: true, error: null,
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/supabase/overview?instanceId=${encodeURIComponent(instanceId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      if (!d.success) throw new Error(d.error ?? 'Failed to load overview');
      setData(d.data as OverviewData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load instance stats');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  const fetchSchema = useCallback(async () => {
    setSchema(prev => ({ ...prev, loading: true, error: null }));
    try {
      const [tablesRes, migrationsRes] = await Promise.allSettled([
        fetch(`/api/supabase/introspect?instanceId=${encodeURIComponent(instanceId)}&type=tables`),
        fetch(`/api/supabase/migrations?instanceId=${encodeURIComponent(instanceId)}`),
      ]);
      let tableCount: number | null = null;
      let applied: number | null = null;
      let pending: number | null = null;
      let lastAppliedAt: string | null = null;
      let schemaError: string | null = null;

      if (tablesRes.status === 'fulfilled' && tablesRes.value.ok) {
        const d = await tablesRes.value.json();
        if (d.tables) tableCount = (d.tables as unknown[]).length;
      } else {
        schemaError = 'Could not load table stats';
      }
      if (migrationsRes.status === 'fulfilled' && migrationsRes.value.ok) {
        const d = await migrationsRes.value.json();
        applied = d.applied ?? null;
        pending = d.pending ?? null;
        lastAppliedAt = d.lastAppliedAt ?? null;
      }
      setSchema({ tableCount, applied, pending, lastAppliedAt, loading: false, error: schemaError });
    } catch (err) {
      setSchema({ tableCount: null, applied: null, pending: null, lastAppliedAt: null, loading: false,
        error: err instanceof Error ? err.message : 'Failed to load schema stats' });
    }
  }, [instanceId]);

  useEffect(() => { fetchData(); fetchSchema(); }, [fetchData, fetchSchema]);

  // Poll activity feed
  useEffect(() => {
    const poll = () => {
      fetch(`/api/logs?sources=supabase&limit=20`)
        .then(r => r.json())
        .then(d => {
          if (Array.isArray(d.events) && d.events.length > 0) {
            setActivity(
              d.events.map((e: Record<string, unknown>) => ({
                id:        String(e.id ?? crypto.randomUUID()),
                type:      String(e.source) === 'auth' ? 'auth'
                          : String(e.severity) === 'error' ? 'error'
                          : 'query',
                message:   String(e.message ?? ''),
                source:    e.data ? String((e.data as Record<string, unknown>).user ?? '') : undefined,
                timestamp: String(e.timestamp ?? ''),
              } as ActivityItem))
            );
          }
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [instanceId]);

  if (!loading && error) {
    return (
      <div className="sbo-panel">
        <div className="sbo-bg-grid" aria-hidden="true" />
        <ErrorState message={error} onRetry={fetchData} />
      </div>
    );
  }

  const cards: CardProps[] = data ? [
    { label: 'DATABASE SIZE',  value: fmtSize(data.dbSizeMb),         accent: 'jade',   index: 0 },
    { label: 'API REQUESTS',   value: fmtNum(data.apiRequestsToday),  accent: 'cyan',   index: 1 },
    { label: 'TOTAL USERS',    value: fmtNum(data.usersTotal),        accent: 'violet', index: 2 },
    { label: 'ERRORS TODAY',   value: fmtNum(data.errorsToday),       accent: 'amber',  index: 3 },
  ] : [];

  return (
    <div className="sbo-panel">
      <div className="sbo-bg-grid" aria-hidden="true" />

      {/* Schema stats: tables + migrations */}
      <div className="sbo-schema-section" role="region" aria-label="Schema statistics">
        {schema.loading ? (
          <div className="sdb-overview__loading">
            <span className="sdb-loading-spinner" />
            loading schema…
          </div>
        ) : schema.error ? (
          <div className="sdb-overview__error">{schema.error}</div>
        ) : (
          <div className="sdb-stat-grid">
            <SchemaStatCell value={schema.tableCount} label="Tables" />
            <SchemaStatCell value={schema.applied} label="Migrations" />
            <SchemaStatCell value={schema.pending} label="Pending" warn={(schema.pending ?? 0) > 0} />
            <SchemaStatCell
              value={schema.lastAppliedAt ? formatRelative(schema.lastAppliedAt) : null}
              label="Last Migration"
            />
          </div>
        )}
      </div>

      <div className="sbo-cards" role="region" aria-label="Database statistics">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="sbo-card-skel" style={{ animationDelay: `${i * 80}ms` }} />
            ))
          : cards.map(c => <StatCard key={c.label} {...c} />)
        }
      </div>

      {data && (
        <>
          <div className="sbo-mid-row">
            <ApiChart data={data.apiRequestsHistory} />
            <HealthGrid services={data.services} />
          </div>
          <ActivityFeed items={activity} />
        </>
      )}
    </div>
  );
}
