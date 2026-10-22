'use client';

import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { Activity } from 'lucide-react';
import { ChartPanel } from './ChartPanel';
import type { CpuMemorySample } from './systems-types';

export interface CpuMemoryChartProps {
  buffer: CpuMemorySample[];
  height?: number;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function CpuMemoryChart({ buffer, height = 200 }: CpuMemoryChartProps) {
  const option = useMemo(() => {
    const times = buffer.map((s) => formatTime(s.timestamp));
    const cpuData = buffer.map((s) => +s.cpu.toFixed(1));
    const memData = buffer.map((s) => +(s.memory / 1_048_576).toFixed(1)); // bytes → MB

    return {
      backgroundColor: 'transparent',
      animation: false,
      grid: {
        top: 12,
        right: 56,
        bottom: 28,
        left: 48,
        containLabel: false,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(8,16,36,0.92)',
        borderColor: 'rgba(59,130,246,0.3)',
        borderWidth: 1,
        textStyle: { color: 'rgba(255,255,255,0.88)', fontSize: 11 },
        formatter: (params: { name: string; seriesName: string; value: number }[]) => {
          const time = params[0]?.name ?? '';
          return params.map((p) => {
            const unit = p.seriesName === 'CPU' ? '%' : ' MB';
            return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.seriesName === 'CPU' ? '#3b82f6' : '#8b5cf6'};margin-right:6px;"></span>${p.seriesName}: <b>${p.value}${unit}</b>`;
          }).join('<br/>') + `<div style="margin-top:4px;color:rgba(255,255,255,0.4);font-size:10px;">${time}</div>`;
        },
        axisPointer: { lineStyle: { color: 'rgba(59,130,246,0.3)', width: 1 } },
      },
      xAxis: {
        type: 'category',
        data: times,
        boundaryGap: false,
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
        axisTick: { show: false },
        axisLabel: {
          color: 'rgba(255,255,255,0.35)',
          fontSize: 10,
          interval: Math.max(0, Math.floor(buffer.length / 5) - 1),
        },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: 'value',
          name: 'CPU %',
          nameTextStyle: { color: 'rgba(59,130,246,0.7)', fontSize: 10 },
          min: 0,
          max: 100,
          interval: 25,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: 'rgba(255,255,255,0.35)', fontSize: 10, formatter: '{value}%' },
          splitLine: { lineStyle: { color: 'rgba(59,130,246,0.07)', type: 'dashed' } },
        },
        {
          type: 'value',
          name: 'MB',
          nameTextStyle: { color: 'rgba(139,92,246,0.7)', fontSize: 10 },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: 'rgba(255,255,255,0.35)', fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'CPU',
          type: 'line',
          yAxisIndex: 0,
          data: cpuData,
          smooth: 0.4,
          symbol: 'none',
          lineStyle: { color: '#3b82f6', width: 1.5 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(59,130,246,0.28)' },
                { offset: 1, color: 'rgba(59,130,246,0.01)' },
              ],
            },
          },
        },
        {
          name: 'Memory',
          type: 'line',
          yAxisIndex: 1,
          data: memData,
          smooth: 0.4,
          symbol: 'none',
          lineStyle: { color: '#8b5cf6', width: 1.5 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(139,92,246,0.22)' },
                { offset: 1, color: 'rgba(139,92,246,0.01)' },
              ],
            },
          },
        },
      ],
    };
  }, [buffer]);

  const isEmpty = buffer.length < 2;

  return (
    <ChartPanel
      title="CPU / Memory"
      icon={<Activity size={12} />}
      height={height}
    >
      {isEmpty ? (
        <div className="chart-panel__collecting">
          <span className="chart-panel__collecting-dot" />
          Collecting data…
        </div>
      ) : (
        <ReactECharts
          option={option}
          style={{ width: '100%', height: '100%' }}
          opts={{ renderer: 'svg' }}
          notMerge={false}
        />
      )}
    </ChartPanel>
  );
}
