'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useEventStream } from '@/lib/contexts/EventStreamContext';
import type { PM2Process, PM2Response } from '@/lib/types';

// ─── Public types ────────────────────────────────────────────────────────────

/** One time-series sample for the CPU/Memory area chart */
export interface CpuMemorySample {
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Aggregate CPU % across all tracked processes */
  cpu: number;
  /** Total memory in bytes across all tracked processes */
  memory: number;
}

/** Service status counts for the donut chart */
export interface ServiceStatusCounts {
  online: number;
  stopped: number;
  errored: number;
  launching: number;
}

/** Per-service entry for the uptime bar chart */
export interface UptimeEntry {
  name: string;
  /** Uptime in milliseconds (0 if stopped/errored) */
  uptimeMs: number;
  status: string;
}

export interface MetricsBufferResult {
  /** Rolling time-series — up to MAX_SAMPLES entries, oldest first */
  cpuMemorySeries: CpuMemorySample[];
  /** Snapshot counts for the donut chart */
  serviceStatus: ServiceStatusCounts;
  /** Per-service uptime entries for the bar chart, sorted by uptime desc */
  uptimeData: UptimeEntry[];
  /** Unix ms of the most recent data point, null before first data */
  lastUpdated: number | null;
  /** True until at least one data point has been received */
  loading: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum number of CPU/Memory samples to retain in the rolling buffer */
const MAX_SAMPLES = 30;

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Exclude dev servers — consistent with SystemsOverview filtering */
function isService(proc: PM2Process): boolean {
  return !proc.name.startsWith('dev-');
}

function extractServiceStatus(processes: PM2Process[]): ServiceStatusCounts {
  const services = processes.filter(isService);
  return {
    online:   services.filter(p => p.status === 'online').length,
    stopped:  services.filter(p => p.status === 'stopped').length,
    errored:  services.filter(p => p.status === 'errored').length,
    launching: services.filter(p => p.status === 'launching').length,
  };
}

function extractUptimeData(processes: PM2Process[]): UptimeEntry[] {
  return processes
    .filter(isService)
    .map(p => ({
      name: p.name,
      uptimeMs: p.status === 'online' ? (p.uptime ?? 0) : 0,
      status: p.status,
    }))
    .sort((a, b) => b.uptimeMs - a.uptimeMs);
}

function buildSample(processes: PM2Process[]): CpuMemorySample {
  const services = processes.filter(isService);
  const cpu = services.reduce((sum, p) => sum + (p.cpu ?? 0), 0);
  const memory = services.reduce((sum, p) => sum + (p.memory ?? 0), 0);
  return { timestamp: Date.now(), cpu, memory };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * useMetricsBuffer
 *
 * Maintains a rolling buffer of PM2 metrics snapshots for chart rendering.
 * Subscribes to pm2:status SSE events for live updates and seeds from /api/pm2
 * on mount. Exposes derived series ready to pass directly to ECharts components.
 */
export function useMetricsBuffer(): MetricsBufferResult {
  const [cpuMemorySeries, setCpuMemorySeries] = useState<CpuMemorySample[]>([]);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusCounts>({
    online: 0, stopped: 0, errored: 0, launching: 0,
  });
  const [uptimeData, setUptimeData] = useState<UptimeEntry[]>([]);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // Buffer ref — used to append without stale-closure issues
  const bufferRef = useRef<CpuMemorySample[]>([]);

  const ingest = useCallback((processes: PM2Process[]) => {
    const sample = buildSample(processes);
    bufferRef.current = [...bufferRef.current, sample].slice(-MAX_SAMPLES);

    setCpuMemorySeries([...bufferRef.current]);
    setServiceStatus(extractServiceStatus(processes));
    setUptimeData(extractUptimeData(processes));
    setLastUpdated(sample.timestamp);
    setLoading(false);
  }, []);

  // Subscribe to SSE — fires on every pm2:status event (~5s intervals)
  const { data: pm2Data } = useEventStream<PM2Response>('pm2:status', {
    fallbackUrl: '/api/pm2',
    fallbackInterval: 10000,
    fallbackTransform: (r) => r as PM2Response,
  });

  useEffect(() => {
    if (pm2Data?.processes) {
      ingest(pm2Data.processes);
    }
  }, [pm2Data, ingest]);

  // Seed the buffer on mount with a direct fetch (SSE may not fire immediately)
  useEffect(() => {
    let cancelled = false;
    fetch('/api/pm2')
      .then(r => r.json())
      .then((json: PM2Response) => {
        if (!cancelled && json?.processes) ingest(json.processes);
      })
      .catch(() => { /* non-fatal — SSE will deliver data shortly */ });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { cpuMemorySeries, serviceStatus, uptimeData, lastUpdated, loading };
}
