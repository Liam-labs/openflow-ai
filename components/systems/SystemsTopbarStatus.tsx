'use client';

import React from 'react';
import { useMetricsBuffer } from '@/lib/hooks/useMetricsBuffer';

/**
 * The health pill beside the Systems title. It reads the same rolling PM2 buffer as the status strip on the Overview,
 * so the two CPU figures are the same number at the same moment (they were sampled separately and drifted apart).
 */
export function SystemsTopbarStatus() {
  const { serviceStatus, cpuMemorySeries, loading } = useMetricsBuffer();
  if (loading) return null;

  const { online, stopped, errored, launching } = serviceStatus;
  const total = online + stopped + errored + launching;
  const healthy = errored === 0 && online === total;
  const latest = cpuMemorySeries.length > 0 ? cpuMemorySeries[cpuMemorySeries.length - 1] : null;
  const cpu = latest ? latest.cpu.toFixed(1) : null; // same one-decimal format as the strip

  return (
    <div className="stbs-wrap" aria-label="System health summary">
      <span className={`stbs-dot ${healthy ? 'stbs-dot--ok' : errored > 0 ? 'stbs-dot--err' : 'stbs-dot--warn'}`} />
      <span className="stbs-label">
        <span className={`stbs-value ${healthy ? 'stbs-value--ok' : errored > 0 ? 'stbs-value--err' : ''}`}>
          {online}
        </span>
        <span className="stbs-sep">/</span>
        <span className="stbs-value stbs-value--dim">{total}</span>
        <span className="stbs-unit">online</span>
      </span>
      {errored > 0 && (
        <span className="stbs-badge stbs-badge--err">{errored} errored</span>
      )}
      {cpu !== null && (
        <span className="stbs-cpu" title="Combined CPU of the services run by PM2, the same figure as the CPU in the status strip">CPU {cpu}%</span>
      )}
    </div>
  );
}
