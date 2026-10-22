'use client';

/**
 * OverviewPanelStates — loading and empty state primitives for SystemsOverview panels.
 * Used by: Daniel (metrics strip, activity feeds, sparkline strip, quick nav)
 *          Morpheus (ChartPanel, chart components)
 */

import React from 'react';

// ─── Chart panel skeleton (Morpheus) ──────────────────────────────────────

interface ChartPanelSkeletonProps {
  /** Height of the chart area in px. Default 200. */
  height?: number;
  /** Show a legend row below the chart area. Default false. */
  showLegend?: boolean;
}

export function ChartPanelSkeleton({ height = 200, showLegend = false }: ChartPanelSkeletonProps) {
  return (
    <div className="ops-chart-skeleton">
      <div className="ops-chart-skeleton__header">
        <div className="ops-shimmer" style={{ width: 120, height: 14, borderRadius: 4 }} />
        <div className="ops-shimmer" style={{ width: 60, height: 12, borderRadius: 4 }} />
      </div>
      <div className="ops-chart-skeleton__area ops-shimmer" style={{ height }} />
      {showLegend && (
        <div className="ops-chart-skeleton__legend">
          {[56, 72, 64].map((w, i) => (
            <div key={i} className="ops-chart-skeleton__legend-item">
              <div className="ops-shimmer ops-shimmer--dot" />
              <div className="ops-shimmer" style={{ width: w, height: 11, borderRadius: 3 }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Metrics strip skeleton (Daniel) ──────────────────────────────────────

interface MetricsStripSkeletonProps {
  /** Number of metric cards. Default 5. */
  count?: number;
}

export function MetricsStripSkeleton({ count = 5 }: MetricsStripSkeletonProps) {
  return (
    <div className="ops-metrics-strip-skeleton">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="ops-metric-card-skeleton ops-shimmer" style={{ animationDelay: `${i * 50}ms` }}>
          <div className="ops-shimmer ops-shimmer--icon" />
          <div className="ops-shimmer" style={{ width: '60%', height: 22, borderRadius: 4, margin: '8px 0 4px' }} />
          <div className="ops-shimmer" style={{ width: '80%', height: 11, borderRadius: 3 }} />
        </div>
      ))}
    </div>
  );
}

// ─── Activity feed skeleton (Daniel) ──────────────────────────────────────

interface ActivityFeedSkeletonProps {
  rows?: number;
}

export function ActivityFeedSkeleton({ rows = 5 }: ActivityFeedSkeletonProps) {
  return (
    <div className="ops-activity-skeleton">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="ops-activity-skeleton__row" style={{ animationDelay: `${i * 45}ms` }}>
          <div className="ops-shimmer ops-shimmer--dot" />
          <div className="ops-activity-skeleton__lines">
            <div className="ops-shimmer" style={{ width: `${50 + (i % 3) * 12}%`, height: 13, borderRadius: 4 }} />
            <div className="ops-shimmer" style={{ width: `${30 + (i % 2) * 10}%`, height: 11, borderRadius: 3 }} />
          </div>
          <div className="ops-shimmer" style={{ width: 36, height: 11, borderRadius: 3 }} />
        </div>
      ))}
    </div>
  );
}

// ─── Sparkline strip skeleton (Daniel) ────────────────────────────────────

interface SparklineStripSkeletonProps {
  count?: number;
}

export function SparklineStripSkeleton({ count = 4 }: SparklineStripSkeletonProps) {
  return (
    <div className="ops-sparkline-strip-skeleton">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="ops-sparkline-skeleton" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="ops-shimmer" style={{ width: 64, height: 11, borderRadius: 3, marginBottom: 6 }} />
          <div className="ops-shimmer ops-sparkline-skeleton__line" />
          <div className="ops-shimmer" style={{ width: 40, height: 13, borderRadius: 3, marginTop: 4 }} />
        </div>
      ))}
    </div>
  );
}

// ─── Generic panel empty state ─────────────────────────────────────────────

interface PanelEmptyStateProps {
  icon?: React.ReactNode;
  title?: string;
  message: string;
  action?: { label: string; onClick: () => void };
}

export function PanelEmptyState({ icon, title, message, action }: PanelEmptyStateProps) {
  return (
    <div className="ops-empty">
      {icon && <span className="ops-empty__icon">{icon}</span>}
      {title && <span className="ops-empty__title">{title}</span>}
      <span className="ops-empty__message">{message}</span>
      {action && (
        <button className="ops-empty__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

// ─── Chart panel empty state (Morpheus) ──────────────────────────────────

interface ChartEmptyStateProps {
  height?: number;
  message?: string;
}

export function ChartEmptyState({ height = 200, message = 'No data available' }: ChartEmptyStateProps) {
  return (
    <div className="ops-chart-empty" style={{ height }}>
      <span className="ops-chart-empty__text">{message}</span>
    </div>
  );
}
