'use client';

import React from 'react';
import { RefreshCw } from 'lucide-react';

export interface ChartPanelProps {
  title: string;
  icon?: React.ReactNode;
  height?: number;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  children: React.ReactNode;
  className?: string;
}

export function ChartPanel({
  title,
  icon,
  height = 200,
  loading = false,
  error,
  onRefresh,
  children,
  className = '',
}: ChartPanelProps) {
  return (
    <div className={`chart-panel ${className}`}>
      <div className="chart-panel__header">
        <span className="chart-panel__title">
          {icon && <span className="chart-panel__icon" aria-hidden="true">{icon}</span>}
          {title}
        </span>
        {onRefresh && (
          <button
            className="chart-panel__refresh"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh chart"
          >
            <RefreshCw size={11} className={loading ? 'chart-panel__refresh--spinning' : ''} />
          </button>
        )}
      </div>
      <div className="chart-panel__body" style={{ height }}>
        {loading ? (
          <div className="chart-panel__skeleton" aria-busy="true" />
        ) : error ? (
          <div className="chart-panel__error" role="alert">{error}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
