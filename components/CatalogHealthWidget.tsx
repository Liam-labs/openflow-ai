'use client';

import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, RefreshCw, AlertTriangle, CheckCircle2, Search, BookOpen, Wrench, Verified } from 'lucide-react';
import type { StoredIssue } from '@/lib/catalog-types';

// ─── Types ───────────────────────────────────────────────────────────────────

type FeatureStatus = 'discovered' | 'cataloged' | 'audited' | 'needs-work' | 'improved' | 'verified';
type Severity = 'critical' | 'high' | 'medium' | 'low';

interface StatusConfig {
  label: string;
  bg: string;
  border: string;
  text: string;
  dot: string;
}

interface SeverityConfig {
  label: string;
  bg: string;
  border: string;
  text: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<FeatureStatus, StatusConfig> = {
  verified:   { label: 'Verified',    bg: 'rgba(16,185,129,0.1)',  border: 'rgba(16,185,129,0.25)',  text: '#10b981', dot: '#10b981' },
  improved:   { label: 'Improved',    bg: 'rgba(34,197,94,0.09)',  border: 'rgba(34,197,94,0.22)',   text: '#22c55e', dot: '#22c55e' },
  audited:    { label: 'Audited',     bg: 'rgba(59,130,246,0.09)', border: 'rgba(59,130,246,0.22)',  text: '#60a5fa', dot: '#60a5fa' },
  'needs-work': { label: 'Needs Work', bg: 'rgba(251,146,60,0.09)', border: 'rgba(251,146,60,0.22)',  text: '#fb923c', dot: '#fb923c' },
  cataloged:  { label: 'Cataloged',   bg: 'rgba(139,92,246,0.08)', border: 'rgba(139,92,246,0.2)',   text: '#a78bfa', dot: '#a78bfa' },
  discovered: { label: 'Discovered',  bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.1)', text: 'rgba(255,255,255,0.45)', dot: 'rgba(255,255,255,0.3)' },
};

const SEVERITY_CONFIG: Record<Severity, SeverityConfig> = {
  critical: { label: 'CRIT', bg: 'rgba(239,68,68,0.15)',  border: 'rgba(239,68,68,0.3)',  text: '#f87171' },
  high:     { label: 'HIGH', bg: 'rgba(251,146,60,0.12)', border: 'rgba(251,146,60,0.28)', text: '#fb923c' },
  medium:   { label: 'MED',  bg: 'rgba(250,204,21,0.1)',  border: 'rgba(250,204,21,0.25)', text: '#fbbf24' },
  low:      { label: 'LOW',  bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.12)', text: 'rgba(255,255,255,0.4)' },
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const STATUS_DISPLAY_ORDER: FeatureStatus[] = ['verified', 'improved', 'audited', 'needs-work', 'cataloged', 'discovered'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugToName(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatAge(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  } catch { return ''; }
}

// ─── Component ───────────────────────────────────────────────────────────────

interface CatalogSummary {
  statusCounts: Partial<Record<FeatureStatus, number>>;
  topIssues: StoredIssue[];
  total: number;
}

export function CatalogHealthWidget() {
  const [summary, setSummary] = useState<CatalogSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [featRes, issuesRes] = await Promise.all([
        fetch('/api/catalog'),
        fetch('/api/catalog?sub=issues'),
      ]);
      if (!featRes.ok || !issuesRes.ok) return;

      const { features } = await featRes.json() as { features: Array<{ status: FeatureStatus }> };
      const { issues } = await issuesRes.json() as { issues: StoredIssue[] };

      const statusCounts: Partial<Record<FeatureStatus, number>> = {};
      for (const f of features ?? []) {
        const s = f.status as FeatureStatus;
        statusCounts[s] = (statusCounts[s] ?? 0) + 1;
      }

      const topIssues = (issues ?? [])
        .sort((a, b) => SEVERITY_ORDER[a.severity as Severity] - SEVERITY_ORDER[b.severity as Severity])
        .slice(0, 5);

      setSummary({ statusCounts, topIssues, total: features?.length ?? 0 });
      setLastRefresh(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => load(), 60_000);
    return () => clearInterval(interval);
  }, [load]);

  // ─── Health score ─────────────────────────────────────────────────────────

  const healthScore = summary ? (() => {
    const { statusCounts, total } = summary;
    if (total === 0) return 0;
    const healthy = (statusCounts.verified ?? 0) + (statusCounts.improved ?? 0) + (statusCounts.audited ?? 0);
    return Math.round((healthy / total) * 100);
  })() : null;

  const scoreColor = healthScore === null ? 'rgba(255,255,255,0.3)' :
    healthScore >= 70 ? '#10b981' :
    healthScore >= 40 ? '#fb923c' : '#ef4444';

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="chw-root glass-card"
      style={{ padding: '16px 20px', marginBottom: '20px' }}
      role="region"
      aria-label="Catalog Health Summary"
    >
      {/* Header */}
      <div className="chw-header">
        <div className="chw-header-left">
          <div className="chw-icon-wrap" aria-hidden="true">
            <ShieldCheck className="w-3.5 h-3.5" style={{ color: '#60a5fa' }} />
          </div>
          <span className="chw-title">Catalog Health</span>
          {summary && (
            <span className="chw-total">{summary.total} features</span>
          )}
        </div>
        <div className="chw-header-right">
          {healthScore !== null && (
            <span className="chw-score" style={{ color: scoreColor }}>
              {healthScore}%
            </span>
          )}
          {lastRefresh && (
            <span className="chw-timestamp">{lastRefresh}</span>
          )}
          <button
            className="chw-refresh-btn"
            onClick={() => load(true)}
            disabled={refreshing || loading}
            aria-label="Refresh catalog health"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${refreshing ? 'chw-spin' : ''}`}
              style={{ color: 'rgba(255,255,255,0.35)' }}
            />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="chw-loading" aria-live="polite">
          <div className="chw-shimmer chw-shimmer-pills" />
          <div className="chw-shimmer chw-shimmer-issues" />
        </div>
      ) : summary ? (
        <div className="chw-body">
          {/* Status pills */}
          <div className="chw-pills" role="list" aria-label="Feature status counts">
            {STATUS_DISPLAY_ORDER.map((status) => {
              const count = summary.statusCounts[status] ?? 0;
              if (count === 0) return null;
              const cfg = STATUS_CONFIG[status];
              return (
                <div
                  key={status}
                  className="chw-pill"
                  role="listitem"
                  style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}
                  title={`${cfg.label}: ${count} feature${count !== 1 ? 's' : ''}`}
                >
                  <span className="chw-pill-dot" style={{ background: cfg.dot }} aria-hidden="true" />
                  <span className="chw-pill-label" style={{ color: cfg.text }}>{cfg.label}</span>
                  <span className="chw-pill-count" style={{ color: cfg.text }}>{count}</span>
                </div>
              );
            })}
          </div>

          {/* Open issues */}
          {summary.topIssues.length > 0 && (
            <div
              className="chw-issues"
              style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '12px', marginTop: '12px' }}
            >
              <div className="chw-issues-header">
                <AlertTriangle className="w-3 h-3" style={{ color: '#fb923c' }} aria-hidden="true" />
                <span className="chw-issues-title">Open Issues</span>
              </div>
              <ul className="chw-issue-list" aria-label="Top open issues">
                {summary.topIssues.map((issue) => {
                  const sev = SEVERITY_CONFIG[issue.severity as Severity] ?? SEVERITY_CONFIG.low;
                  return (
                    <li key={issue.id} className="chw-issue-row">
                      <span
                        className="chw-severity-badge"
                        style={{ background: sev.bg, border: `1px solid ${sev.border}`, color: sev.text }}
                        aria-label={`Severity: ${issue.severity}`}
                      >
                        {sev.label}
                      </span>
                      <span className="chw-issue-title" title={issue.description}>
                        {issue.title}
                      </span>
                      <span className="chw-issue-meta">
                        {slugToName(issue.featureSlug)} · {formatAge(issue.discoveredAt)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {summary.topIssues.length === 0 && summary.total > 0 && (
            <div
              className="chw-clean"
              style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '12px', marginTop: '12px' }}
            >
              <CheckCircle2 className="w-3.5 h-3.5" style={{ color: '#10b981' }} aria-hidden="true" />
              <span className="chw-clean-text">No open issues</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
