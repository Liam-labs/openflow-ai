'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Activity, ChevronRight } from 'lucide-react';
import type { SystemsNavState } from './systems-types';

// ─── Types ─────────────────────────────────────────────────────────────────────

type MetricStatus = 'green' | 'amber' | 'orange' | 'red';

interface ProcessSummary {
  totalProcesses: number;
  totalThreads:   number;
  zombies:        number;
  orphans:        number;
  forkErrors1hr:  number;
  processLimit:   number;
  threadLimit:    number;
  status:         string;
  // Per-metric statuses from API (supplied by the API)
  metricStatuses?: {
    processes:  MetricStatus;
    threads:    MetricStatus;
    zombies:    MetricStatus;
    forkErrors: MetricStatus;
    orphans:    MetricStatus;
  };
}

interface ProcessHealthCardProps {
  onNavigate: (state: Partial<SystemsNavState>) => void;
}

// ─── Thresholds ────────────────────────────────────────────────────────────────

const THRESHOLDS = {
  processes:  [400,  600,  800]  as const,
  threads:    [3000, 4000, 5000] as const,
  zombies:    [1,    11,   51]   as const,
  forkErrors: [1,    4,    11]   as const,
  orphans:    [1,    6,    16]   as const,
};

function computeStatus(value: number, t: readonly [number, number, number]): MetricStatus {
  if (value < t[0]) return 'green';
  if (value < t[1]) return 'amber';
  if (value < t[2]) return 'orange';
  return 'red';
}

function worstStatus(statuses: MetricStatus[]): MetricStatus {
  const order: MetricStatus[] = ['green', 'amber', 'orange', 'red'];
  return statuses.reduce<MetricStatus>(
    (w, s) => order.indexOf(s) > order.indexOf(w) ? s : w,
    'green',
  );
}

const STATUS_COLOR: Record<MetricStatus, string> = {
  green:  'var(--df-success)',
  amber:  'var(--df-warning)',
  orange: '#f97316',
  red:    'var(--df-error)',
};

// ─── Component ─────────────────────────────────────────────────────────────────

export function ProcessHealthCard({ onNavigate }: ProcessHealthCardProps) {
  const [summary, setSummary] = useState<ProcessSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/process-health');
      if (!res.ok) { setError(true); return; }
      const data = await res.json();
      if (data.summary) {
        setSummary(data.summary as ProcessSummary);
        setError(false);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const ms = summary?.metricStatuses;
  const metrics = summary ? [
    { key: 'processes',  label: 'Procs',    value: summary.totalProcesses, status: ms?.processes  ?? computeStatus(summary.totalProcesses, THRESHOLDS.processes)  },
    { key: 'threads',    label: 'Threads',  value: summary.totalThreads,   status: ms?.threads    ?? computeStatus(summary.totalThreads,   THRESHOLDS.threads)    },
    { key: 'zombies',    label: 'Zombies',  value: summary.zombies,        status: ms?.zombies    ?? computeStatus(summary.zombies,        THRESHOLDS.zombies)    },
    { key: 'forkErrors', label: 'Fork Err', value: summary.forkErrors1hr,  status: ms?.forkErrors ?? computeStatus(summary.forkErrors1hr,  THRESHOLDS.forkErrors), suffix: '/hr' },
    { key: 'orphans',    label: 'Orphans',  value: summary.orphans,        status: ms?.orphans    ?? computeStatus(summary.orphans,        THRESHOLDS.orphans)    },
  ] : null;

  const overallStatus: MetricStatus = metrics
    ? worstStatus(metrics.map(m => m.status))
    : 'green';

  return (
    <div className="sov-panel ph-card">
      <div className="sov-panel__header">
        <span className="sov-panel__title">
          <Activity size={14} />
          Process Health
        </span>
        {!loading && !error && (
          <span
            className="ph-card__status-dot"
            style={{ background: STATUS_COLOR[overallStatus] }}
            title={`Status: ${overallStatus}`}
            aria-label={`Process health status: ${overallStatus}`}
          />
        )}
      </div>

      <div className="sov-panel__body ph-card__body">
        {loading ? (
          <div className="ph-card__metric-boxes ph-card__metric-boxes--skel">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="ph-card__metric-box ph-card__metric-box--skel" />
            ))}
          </div>
        ) : error ? (
          <div className="ph-card__empty">
            <span className="ph-card__empty-icon">⚠</span>
            <span>API unavailable</span>
          </div>
        ) : metrics ? (
          <>
            <div className="ph-card__metric-boxes">
              {metrics.map(m => (
                <div
                  key={m.key}
                  className={`ph-card__metric-box ph-card__metric-box--${m.status}`}
                >
                  <div className="ph-card__box-inner">
                    <span className="ph-card__box-value">
                      {m.value.toLocaleString()}
                      {m.suffix && <span className="ph-card__box-suffix">{m.suffix}</span>}
                    </span>
                    <span className="ph-card__box-label">{m.label}</span>
                  </div>
                </div>
              ))}
            </div>
            <button
              className="ph-card__footer"
              onClick={() => onNavigate({ section: 'process-health' })}
              aria-label="Open Process Health drill-down panel"
            >
              View Details
              <ChevronRight size={11} />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
