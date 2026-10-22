'use client';

import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { Database } from 'lucide-react';
import { ChartPanel } from './ChartPanel';

interface PM2Process {
  name: string;
  pm_id: number;
  status: string;
  monit?: { cpu: number; memory: number };
  pm2_env?: { pm_uptime?: number; restart_time?: number };
}

export interface ServiceMemoryChartProps {
  processes: PM2Process[];
  height?: number;
  maxItems?: number;
}

function memColour(mb: number): string {
  if (mb >= 500) return '#ef4444';   // heavy
  if (mb >= 200) return '#f97316';   // elevated
  if (mb >= 80)  return '#eab308';   // moderate
  if (mb >= 30)  return '#06b6d4';   // normal
  return '#3b82f6';                  // light
}

function fmtMb(mb: number): string {
  if (mb >= 1000) return `${(mb / 1024).toFixed(1)}g`;
  return `${Math.round(mb)}m`;
}

export function ServiceMemoryChart({ processes, height = 200, maxItems = 8 }: ServiceMemoryChartProps) {
  const option = useMemo(() => {
    const entries = processes
      .filter((p) => !p.name.startsWith('dev-') && p.status === 'online' && (p.monit?.memory ?? 0) > 0)
      .map((p) => ({ name: p.name, mb: (p.monit!.memory) / 1_048_576 }))
      .sort((a, b) => b.mb - a.mb)
      .slice(0, maxItems);

    if (entries.length === 0) return null;

    const names  = entries.map((e) => e.name);
    const values = entries.map((e) => +e.mb.toFixed(1));
    const colours = entries.map((e) => memColour(e.mb));

    return {
      backgroundColor: 'transparent',
      animation: true,
      animationDuration: 600,
      animationEasing: 'cubicOut',
      grid: { top: 6, right: 52, bottom: 4, left: 4, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'none' },
        backgroundColor: 'rgba(8,16,36,0.92)',
        borderColor: 'rgba(59,130,246,0.3)',
        borderWidth: 1,
        textStyle: { color: 'rgba(255,255,255,0.88)', fontSize: 11 },
        formatter: (params: { name: string; value: number }[]) => {
          const p = params[0];
          return `<b>${p.name}</b><br/>Memory: <b>${fmtMb(p.value)}</b>`;
        },
      },
      xAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: 'rgba(255,255,255,0.28)',
          fontSize: 9,
          formatter: (v: number) => fmtMb(v),
        },
        splitLine: { lineStyle: { color: 'rgba(59,130,246,0.06)', type: 'dashed' } },
      },
      yAxis: {
        type: 'category',
        data: names,
        inverse: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: 'rgba(255,255,255,0.68)',
          fontSize: 11,
          width: 120,
          overflow: 'truncate',
          ellipsis: '…',
        },
      },
      series: [
        {
          type: 'bar',
          data: values.map((v, i) => ({
            value: v,
            itemStyle: {
              color: colours[i],
              borderRadius: [0, 4, 4, 0],
              shadowBlur: 6,
              shadowColor: colours[i].replace(')', ',0.35)').replace('rgb', 'rgba'),
            },
          })),
          barMaxWidth: 12,
          label: {
            show: true,
            position: 'right',
            formatter: (p: { value: number }) => fmtMb(p.value),
            color: 'rgba(255,255,255,0.42)',
            fontSize: 9,
          },
          emphasis: {
            itemStyle: { opacity: 0.85 },
          },
        },
      ],
    };
  }, [processes, maxItems]);

  const hasData = processes.some(
    (p) => !p.name.startsWith('dev-') && p.status === 'online' && (p.monit?.memory ?? 0) > 0
  );

  return (
    <ChartPanel
      title="Service Memory (RSS)"
      icon={<Database size={12} />}
      height={height}
    >
      {!hasData || option === null ? (
        <div className="chart-panel__collecting">No process memory data available</div>
      ) : (
        <ReactECharts
          option={option}
          style={{ width: '100%', height: '100%' }}
          opts={{ renderer: 'svg' }}
          notMerge={true}
        />
      )}
    </ChartPanel>
  );
}
