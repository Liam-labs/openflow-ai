'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, AlertCircle, Info, CheckCircle, RefreshCw, ChevronRight, X } from 'lucide-react';
import type { SystemsNavState } from './systems-types';

// ─── Types ─────────────────────────────────────────────────────────────────

type AlertSeverity = 'critical' | 'warning' | 'info';

interface ServiceAlert {
  id: string;
  severity: AlertSeverity;
  type: 'service' | 'cron' | 'ai-task' | 'supabase-backup';
  name: string;
  detail: string;
  timestamp?: string;
  navTarget?: Partial<SystemsNavState>;
}

interface ServiceAlertsPanelProps {
  onNavigate?: (state: Partial<SystemsNavState>) => void;
  maxVisible?: number;
  autoRefreshMs?: number;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function ServiceAlertsPanel({
  onNavigate,
  maxVisible = 8,
  autoRefreshMs = 30_000,
}: ServiceAlertsPanelProps) {
  const [alerts, setAlerts] = useState<ServiceAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Auto-expire alerts older than 7 days
  const dismissAlert = useCallback((id: string) => {
    setDismissed((prev) => new Set(prev).add(id));
  }, []);

  const fetchAlerts = useCallback(async () => {
    try {
      // 48h ISO window for the backup events feed — `/api/logs` uses `from`, not `since`.
      const backupFromIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const [pm2Res, cronRes, tasksRes, backupRes] = await Promise.allSettled([
        fetch('/api/pm2'),
        fetch('/api/cron'),
        fetch('/api/terminal-tasks'),
        fetch(`/api/logs?sources=supabase-backup&severity=high&from=${encodeURIComponent(backupFromIso)}&limit=20`),
      ]);

      const collected: ServiceAlert[] = [];

      // PM2 service alerts
      if (pm2Res.status === 'fulfilled') {
        const { processes = [] } = await pm2Res.value.json();
        for (const p of processes) {
          if (p.status === 'errored') {
            collected.push({
              id: `pm2-errored-${p.name}`,
              severity: 'critical',
              type: 'service',
              name: p.name,
              detail: 'Process errored',
              navTarget: { section: 'services', entityId: p.name, entityType: 'service', tab: 'overview' },
            });
          } else if (p.pm2_env?.restart_time > 5) {
            collected.push({
              id: `pm2-flapping-${p.name}`,
              severity: 'warning',
              type: 'service',
              name: p.name,
              detail: `Restarted ${p.pm2_env.restart_time}× — may be flapping`,
              navTarget: { section: 'services', entityId: p.name, entityType: 'service', tab: 'overview' },
            });
          }
        }
      }

      // Cron job alerts
      if (cronRes.status === 'fulfilled') {
        const { jobs = [] } = await cronRes.value.json();
        for (const j of jobs) {
          if (j.status === 'error') {
            collected.push({
              id: `cron-error-${j.id}`,
              severity: 'critical',
              type: 'cron',
              name: j.name,
              detail: 'Last run failed',
              timestamp: j.lastRun,
              navTarget: { section: 'scheduled-jobs', entityId: j.id, entityType: 'scheduled-job', tab: 'history' },
            });
          } else if (j.status === 'timeout') {
            collected.push({
              id: `cron-timeout-${j.id}`,
              severity: 'warning',
              type: 'cron',
              name: j.name,
              detail: 'Timed out on last run',
              timestamp: j.lastRun,
              navTarget: { section: 'scheduled-jobs', entityId: j.id, entityType: 'scheduled-job', tab: 'history' },
            });
          }
        }
      }

      // AI task alerts
      if (tasksRes.status === 'fulfilled') {
        const { tasks = [] } = await tasksRes.value.json();
        const now = Date.now();
        for (const t of tasks) {
          if (t.status === 'failed') {
            collected.push({
              id: `task-failed-${t.id}`,
              severity: 'critical',
              type: 'ai-task',
              name: truncate(t.prompt, 48),
              detail: `${t.engine} task failed`,
              timestamp: t.createdAt,
              navTarget: { section: 'ai-tasks', entityId: t.id, entityType: 'ai-task', tab: 'output' },
            });
          } else if (t.status === 'timeout') {
            collected.push({
              id: `task-timeout-${t.id}`,
              severity: 'warning',
              type: 'ai-task',
              name: truncate(t.prompt, 48),
              detail: `${t.engine} task timed out`,
              timestamp: t.createdAt,
              navTarget: { section: 'ai-tasks', entityId: t.id, entityType: 'ai-task', tab: 'output' },
            });
          } else if (t.status === 'running' && t.createdAt) {
            const runningMs = now - new Date(t.createdAt).getTime();
            if (runningMs > 5 * 60_000) {
              collected.push({
                id: `task-long-${t.id}`,
                severity: 'info',
                type: 'ai-task',
                name: truncate(t.prompt, 48),
                detail: `Running ${Math.floor(runningMs / 60_000)}m — longer than expected`,
                timestamp: t.createdAt,
                navTarget: { section: 'ai-tasks', entityId: t.id, entityType: 'ai-task', tab: 'output' },
              });
            }
          }
        }
      }

      // Supabase backup failure alerts — fed by scripts/supabase-daily-backup.sh
      // via POST /api/logs (source='supabase-backup'). High-severity entries in
      // the last 48h surface as critical alerts with navTarget back to the
      // failing instance's backup tab.
      if (backupRes.status === 'fulfilled') {
        const { entries = [] } = await backupRes.value.json();
        for (const entry of entries as Array<{
          id: string;
          timestamp?: string;
          severity?: string;
          title?: string;
          metadata?: Record<string, unknown>;
        }>) {
          const meta = entry.metadata || {};
          const slug = typeof meta.slug === 'string' ? meta.slug : '';
          const instance = typeof meta.instance === 'string' ? meta.instance : slug || 'supabase-backup';
          const action = typeof meta.action === 'string' ? meta.action : 'supabase-backup';
          collected.push({
            id: `supabase-backup-${entry.id}`,
            severity: 'critical',
            type: 'supabase-backup',
            name: instance,
            detail: entry.title || `${action} failed`,
            timestamp: entry.timestamp,
            // Route to the Backups tab of the failing instance (S2.2 extended
            // EntityTab with SupabaseTab so 'backups' is now a valid tab,
            // and SystemsPage forwards initialInstanceId + initialTab to
            // SupabaseSection which resolves slug → instance id on mount).
            navTarget: slug
              ? { section: 'supabase', entityId: slug, tab: 'backups' }
              : { section: 'supabase', tab: 'backups' },
          });
        }
      }

      // Filter: drop alerts older than 7 days
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const fresh = collected.filter((a) => {
        if (!a.timestamp) return true; // no timestamp = keep
        return new Date(a.timestamp).getTime() > sevenDaysAgo;
      });

      // Sort: critical → warning → info, then newest first
      const severityOrder: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
      fresh.sort((a, b) => {
        const sd = severityOrder[a.severity] - severityOrder[b.severity];
        if (sd !== 0) return sd;
        return (b.timestamp ?? '') > (a.timestamp ?? '') ? 1 : -1;
      });

      setAlerts(fresh);
    } catch {
      // silent — partial data acceptable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
    if (autoRefreshMs > 0) {
      const id = setInterval(fetchAlerts, autoRefreshMs);
      return () => clearInterval(id);
    }
  }, [fetchAlerts, autoRefreshMs]);

  const active = alerts.filter((a) => !dismissed.has(a.id));
  const visible = expanded ? active : active.slice(0, maxVisible);
  const overflow = active.length - maxVisible;

  return (
    <div className="sal-panel">
      <div className="sal-header">
        <span className="sal-title">
          <AlertTriangle size={14} />
          Service Alerts
        </span>
        <div className="sal-header-actions">
          {active.length > 0 && (
            <span className="sal-count" data-severity={active[0]?.severity}>
              {active.length}
            </span>
          )}
          <button className="sal-refresh" onClick={fetchAlerts} title="Refresh alerts" disabled={loading}>
            <RefreshCw size={12} className={loading ? 'sal-refresh--spinning' : ''} />
          </button>
        </div>
      </div>

      <div className="sal-body">
        {loading ? (
          <ServiceAlertsSkeleton />
        ) : alerts.length === 0 ? (
          <ServiceAlertsAllClear />
        ) : active.length === 0 ? (
          <ServiceAlertsAllClear />
        ) : (
          <>
            {visible.map((alert) => (
              <AlertRow
                key={alert.id}
                alert={alert}
                onClick={alert.navTarget && onNavigate ? () => onNavigate!(alert.navTarget!) : undefined}
                onDismiss={() => dismissAlert(alert.id)}
              />
            ))}
            {!expanded && overflow > 0 && (
              <button className="sal-show-more" onClick={() => setExpanded(true)}>
                +{overflow} more alert{overflow !== 1 ? 's' : ''}
                <ChevronRight size={11} />
              </button>
            )}
            {expanded && overflow > 0 && (
              <button className="sal-show-more" onClick={() => setExpanded(false)}>
                Show less
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<AlertSeverity, React.ReactNode> = {
  critical: <AlertCircle size={14} />,
  warning: <AlertTriangle size={14} />,
  info: <Info size={14} />,
};

function AlertRow({ alert, onClick, onDismiss }: { alert: ServiceAlert; onClick?: () => void; onDismiss?: () => void }) {
  return (
    <div className={`sal-row sal-row--${alert.severity}`}>
      <button className="sal-row__main" onClick={onClick} disabled={!onClick} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: onClick ? 'pointer' : 'default', padding: 0, textAlign: 'left', minWidth: 0 }}>
        <span className={`sal-row__icon sal-row__icon--${alert.severity}`}>
          {SEVERITY_ICON[alert.severity]}
        </span>
        <div className="sal-row__body">
          <span className="sal-row__name">{alert.name}</span>
          <span className="sal-row__detail">{alert.detail}</span>
        </div>
        {alert.timestamp && (
          <span className="sal-row__time">{formatRelative(alert.timestamp)}</span>
        )}
        {onClick && <ChevronRight size={11} className="sal-row__arrow" />}
      </button>
      {onDismiss && (
        <button className="sal-row__dismiss" onClick={(e) => { e.stopPropagation(); onDismiss(); }} title="Dismiss">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function ServiceAlertsAllClear() {
  return (
    <div className="sal-all-clear">
      <CheckCircle size={16} className="sal-all-clear__icon" />
      <span>No active alerts</span>
    </div>
  );
}

function ServiceAlertsSkeleton() {
  return (
    <div className="sal-skeleton">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="sal-skeleton__row" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="sal-skeleton__dot" />
          <div className="sal-skeleton__lines">
            <div className="sal-skeleton__line sal-skeleton__line--name" style={{ width: `${55 + i * 8}%` }} />
            <div className="sal-skeleton__line sal-skeleton__line--detail" style={{ width: `${35 + i * 5}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(str: string, max: number) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const abs = Math.abs(diff);
    if (abs < 60_000) return '<1m ago';
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`;
    return `${Math.round(abs / 86_400_000)}d ago`;
  } catch { return ''; }
}
