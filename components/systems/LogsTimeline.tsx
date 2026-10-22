'use client';

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import dynamic from 'next/dynamic';
import type { LogSeverity } from '@/lib/log-types';

const ReactECharts = dynamic(() => import('echarts-for-react'), {
  ssr: false,
  loading: () => <div style={{ height: 48, width: '100%' }} />,
});

// ─── Constants ────────────────────────────────────────────────────────────────

const SEV_STACK: LogSeverity[] = ['info', 'low', 'medium', 'high', 'critical'];

const SEV_COLORS: Record<LogSeverity, string> = {
  critical: '#ef4444',
  high:     '#f97316',
  medium:   '#eab308',
  low:      '#3b82f6',
  info:     'rgba(255,255,255,0.14)',
  debug:    'rgba(100,116,139,0.5)',
};

interface TimelineBucket {
  bucket: string;
  total:  number;
  bySeverity: Partial<Record<LogSeverity, number>>;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface LogsTimelineProps {
  from: number;   // epoch ms — start of current fetch range
  to:   number;   // epoch ms — end of current fetch range
  onBrushChange: (from: number, to: number) => void;
  onBrushClear:  () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LogsTimeline({
  from,
  to,
  onBrushChange,
  onBrushClear,
}: LogsTimelineProps) {
  const [buckets, setBuckets]   = useState<TimelineBucket[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const brushDebounce           = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Responsive ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // ── Fetch bucketed data ─────────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams({
      from: new Date(from).toISOString(),
      to:   new Date(to).toISOString(),
    });
    let cancelled = false;
    fetch(`/api/logs/timeline?${params}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!cancelled && data?.buckets) setBuckets(data.buckets);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [from, to]);

  // ── Series data ─────────────────────────────────────────────────────────────
  const seriesData = useMemo(() =>
    SEV_STACK.map(sev => ({
      sev,
      pts: buckets.map(b => [
        new Date(b.bucket).getTime(),
        b.bySeverity[sev] ?? 0,
      ] as [number, number]),
    })),
  [buckets]);

  // ── ECharts option ─────────────────────────────────────────────────────────
  const rangeH = (to - from) / 3_600_000;

  const option = useMemo(() => ({
    animation: false,
    grid: { top: 0, right: 4, bottom: 18, left: 4, containLabel: false },
    xAxis: {
      type: 'time' as const,
      min: from,
      max: to,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 9,
        hideOverlap: true,
        formatter: (val: number) => {
          const d = new Date(val);
          if (rangeH <= 24) {
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
          return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        },
      },
    },
    yAxis: {
      show: false,
      type: 'value' as const,
      min: 0,
    },
    brush: {
      toolbox: [],
      xAxisIndex: 0,
      brushStyle: {
        borderWidth: 1,
        color: 'rgba(59,130,246,0.1)',
        borderColor: 'rgba(59,130,246,0.5)',
      },
    },
    series: seriesData.map(({ sev, pts }) => ({
      name: sev,
      type: 'bar' as const,
      stack: 'total',
      silent: true,
      barMaxWidth: 12,
      data: pts,
      itemStyle: { color: SEV_COLORS[sev], borderWidth: 0 },
      emphasis: { disabled: true },
    })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [from, to, seriesData, rangeH]);

  // ── Brush event ─────────────────────────────────────────────────────────────
  const handleBrushSelected = useCallback(
    (params: { batch?: Array<{ areas: Array<{ coordRange?: number[] }> }> }) => {
      const area = params.batch?.[0]?.areas?.[0];
      if (!area?.coordRange?.length) return;

      const [rawFrom, rawTo] = area.coordRange;
      if (brushDebounce.current) clearTimeout(brushDebounce.current);
      brushDebounce.current = setTimeout(() => {
        const newFrom = Math.max(from, Math.round(rawFrom));
        const newTo   = Math.min(to,   Math.round(rawTo));
        if (newTo > newFrom + 60_000) onBrushChange(newFrom, newTo);
      }, 200);
    },
    [from, to, onBrushChange],
  );

  // ── Mobile dot strip ────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="logs-timeline logs-timeline--mobile" aria-label="Event distribution">
        {buckets.map((b, i) => {
          const dominant = [...SEV_STACK].reverse().find(s => (b.bySeverity[s] ?? 0) > 0);
          return (
            <div
              key={i}
              className="logs-timeline__dot"
              style={{
                background: dominant ? SEV_COLORS[dominant] : 'rgba(255,255,255,0.07)',
                opacity: b.total > 0 ? 1 : 0.3,
              }}
              title={`${new Date(b.bucket).toLocaleTimeString()} — ${b.total} events`}
            />
          );
        })}
      </div>
    );
  }

  // ── Desktop chart ───────────────────────────────────────────────────────────
  return (
    <div
      className="logs-timeline"
      onDoubleClick={onBrushClear}
      title="Drag to zoom · Double-click to reset"
    >
      <ReactECharts
        option={option}
        style={{ height: '48px', width: '100%' }}
        opts={{ renderer: 'canvas' as const }}
        onEvents={{ brushselected: handleBrushSelected }}
        notMerge
      />
    </div>
  );
}
