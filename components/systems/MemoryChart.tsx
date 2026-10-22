'use client';

import React, { useState, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { MemoryPoint } from '@/app/api/logs/memory-timeline/route';

const ReactECharts = dynamic(() => import('echarts-for-react'), {
  ssr: false,
  loading: () => <div style={{ height: 56, width: '100%' }} />,
});

// ─── Props ────────────────────────────────────────────────────────────────────

export interface MemoryChartProps {
  from: number;  // epoch ms
  to:   number;  // epoch ms
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MemoryChart({ from, to }: MemoryChartProps) {
  const [points, setPoints] = useState<MemoryPoint[]>([]);

  useEffect(() => {
    const params = new URLSearchParams({
      from: new Date(from).toISOString(),
      to:   new Date(to).toISOString(),
    });
    let cancelled = false;
    fetch(`/api/logs/memory-timeline?${params}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!cancelled && Array.isArray(data?.points)) setPoints(data.points);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [from, to]);

  const seriesData = useMemo(() =>
    points.map(p => [new Date(p.ts).getTime(), p.memUsedPercent] as [number, number]),
  [points]);

  const option = useMemo(() => ({
    animation: false,
    grid: { top: 4, right: 4, bottom: 16, left: 36, containLabel: false },
    xAxis: {
      type: 'time' as const,
      min: from,
      max: to,
      axisLine:  { show: false },
      axisTick:  { show: false },
      splitLine: { show: false },
      axisLabel: {
        color:       'rgba(255,255,255,0.25)',
        fontSize:    9,
        hideOverlap: true,
        formatter:   (val: number) => {
          const d = new Date(val);
          const rangeH = (to - from) / 3_600_000;
          if (rangeH <= 24) {
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
          return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        },
      },
    },
    yAxis: {
      type:  'value' as const,
      min:   0,
      max:   100,
      interval: 50,
      axisLine:  { show: false },
      axisTick:  { show: false },
      splitLine: { show: false },
      axisLabel: {
        color:    'rgba(255,255,255,0.2)',
        fontSize: 9,
        formatter: (val: number) => val === 0 ? '' : `${val}%`,
      },
    },
    tooltip: {
      trigger:     'axis' as const,
      axisPointer: { type: 'line' as const, lineStyle: { color: 'rgba(255,255,255,0.15)', width: 1 } },
      backgroundColor: 'rgba(8,14,28,0.92)',
      borderColor:     'rgba(255,255,255,0.1)',
      borderWidth:     1,
      textStyle: { color: 'rgba(255,255,255,0.8)', fontSize: 11 },
      formatter: (params: Array<{ value: [number, number]; axisValue: number }>) => {
        if (!params[0]) return '';
        const pt = points.find(p => new Date(p.ts).getTime() === params[0].axisValue);
        const pct = params[0].value[1];
        const avail = pt ? ` · ${Math.round(pt.memAvailMB / 1024 * 10) / 10}GB free` : '';
        const d = new Date(params[0].axisValue);
        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `${time} &nbsp; <b>${pct}%</b> used${avail}`;
      },
    },
    series: [{
      type:   'line' as const,
      smooth: true,
      silent: false,
      symbol: 'none',
      data:   seriesData,
      lineStyle: { color: 'var(--df-info, #06b6d4)', width: 1.5 },
      itemStyle: { color: 'var(--df-info, #06b6d4)' },
      areaStyle: {
        color: {
          type:       'linear' as const,
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0,   color: 'rgba(6,182,212,0.28)' },
            { offset: 0.7, color: 'rgba(6,182,212,0.06)' },
            { offset: 1,   color: 'rgba(6,182,212,0.00)' },
          ],
        },
      },
    }],
  }), [from, to, seriesData, points]);

  return (
    <div className="logs-memory-chart" aria-label="Memory usage over time">
      <span className="logs-memory-chart__label" aria-hidden="true">MEM</span>

      {points.length === 0 ? (
        <div className="logs-memory-chart__empty">
          No memory data — sampler starting
        </div>
      ) : (
        <ReactECharts
          option={option}
          style={{ height: '56px', width: '100%' }}
          opts={{ renderer: 'canvas' as const }}
          notMerge
        />
      )}
    </div>
  );
}
