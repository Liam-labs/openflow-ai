'use client';

import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { Clock } from 'lucide-react';
import { ChartPanel } from './ChartPanel';

interface PM2Process {
  name: string;
  pm_id: number;
  status: string;
  monit?: { cpu: number; memory: number };
  pm2_env?: { pm_uptime?: number; restart_time?: number };
}

export interface UptimeBarChartProps {
  processes: PM2Process[];
  height?: number;
  maxItems?: number;
}

function formatUptime(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}

/** Map uptime hours → a colour on a green→blue→amber gradient */
function uptimeColour(hours: number): string {
  if (hours >= 72) return '#22c55e';         // 3+ days: healthy green
  if (hours >= 24) return '#3b82f6';         // 1-3 days: stable blue
  if (hours >= 4)  return '#06b6d4';         // 4h-1d: cyan
  if (hours >= 1)  return '#eab308';         // 1-4h: amber (recent restart)
  return '#f97316';                           // <1h: orange (very recent restart)
}

export function UptimeBarChart({ processes, height = 200, maxItems = 8 }: UptimeBarChartProps) {
  const option = useMemo(() => {
    const now = Date.now();

    const entries = processes
      .filter((p) => !p.name.startsWith('dev-') && p.status === 'online')
      .map((p) => {
        const startMs = p.pm2_env?.pm_uptime ?? now;
        const hours = (now - startMs) / 3_600_000;
        return { name: p.name, hours: Math.max(0, hours) };
      })
      .sort((a, b) => b.hours - a.hours)
      .slice(0, maxItems);

    if (entries.length === 0) return null;

    const names = entries.map((e) => e.name);
    const values = entries.map((e) => +e.hours.toFixed(2));
    const colours = entries.map((e) => uptimeColour(e.hours));

    return {
      backgroundColor: 'transparent',
      animation: true,
      animationDuration: 500,
      grid: { top: 8, right: 16, bottom: 4, left: 4, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'none' },
        backgroundColor: 'rgba(8,16,36,0.92)',
        borderColor: 'rgba(59,130,246,0.3)',
        borderWidth: 1,
        textStyle: { color: 'rgba(255,255,255,0.88)', fontSize: 11 },
        formatter: (params: { name: string; value: number }[]) => {
          const p = params[0];
          return `<b>${p.name}</b><br/>Uptime: <b>${formatUptime(p.value)}</b>`;
        },
      },
      xAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: 'rgba(255,255,255,0.3)',
          fontSize: 9,
          formatter: (v: number) => v >= 24 ? `${Math.floor(v / 24)}d` : `${Math.round(v)}h`,
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
          color: 'rgba(255,255,255,0.7)',
          fontSize: 11,
          width: 110,
          overflow: 'truncate',
          ellipsis: '…',
        },
      },
      series: [
        {
          type: 'bar',
          data: values.map((v, i) => ({ value: v, itemStyle: { color: colours[i], borderRadius: [0, 3, 3, 0] } })),
          barMaxWidth: 14,
          label: {
            show: true,
            position: 'right',
            formatter: (p: { value: number }) => formatUptime(p.value),
            color: 'rgba(255,255,255,0.45)',
            fontSize: 9,
          },
          emphasis: { itemStyle: { opacity: 0.85 } },
        },
      ],
    };
  }, [processes, maxItems]);

  const onlineCount = processes.filter(
    (p) => !p.name.startsWith('dev-') && p.status === 'online'
  ).length;

  return (
    <ChartPanel
      title="Service Uptime"
      icon={<Clock size={12} />}
      height={height}
    >
      {onlineCount === 0 || option === null ? (
        <div className="chart-panel__collecting">No online services</div>
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
