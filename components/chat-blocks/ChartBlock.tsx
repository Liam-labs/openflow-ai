'use client';

import React, { useMemo } from 'react';
import {
  ResponsiveContainer,
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  PieChart, Pie, Cell,
  ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { parseChartSpec } from '@/lib/chat-block-parsers';
import './ChartBlock.css';

export interface ChartBlockProps {
  spec: string;
}

const DEFAULT_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4'];

const AXIS_TICK = { fill: '#71717a', fontFamily: "'JetBrains Mono', monospace", fontSize: 10 };
const GRID_STROKE = { stroke: 'rgba(255,255,255,0.06)' };
const TOOLTIP_CONTENT = {
  background: 'rgba(10,20,40,0.95)',
  border: '1px solid rgba(59,130,246,0.25)',
  borderRadius: 6,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  color: '#e4e4e7',
};

function inferKeys(
  data: Record<string, unknown>[],
  xKey?: string,
  yKeys?: string[],
): { x: string; ys: string[] } {
  if (data.length === 0) return { x: '', ys: [] };
  const first = data[0];
  const keys = Object.keys(first);
  const x = xKey ?? keys[0] ?? '';
  if (yKeys?.length) return { x, ys: yKeys };
  const numeric = keys.filter(k => k !== x && typeof first[k] === 'number');
  return { x, ys: numeric.length > 0 ? numeric : keys.filter(k => k !== x) };
}

export default function ChartBlock({ spec }: ChartBlockProps) {
  const parsed = useMemo(() => parseChartSpec(spec), [spec]);
  const { x, ys } = useMemo(
    () => (parsed ? inferKeys(parsed.data, parsed.xKey, parsed.yKeys) : { x: '', ys: [] }),
    [parsed],
  );

  if (!parsed) {
    return (
      <div className="cb-chart cb-chart--error" role="alert">
        ChartBlock: invalid or oversized spec — expected JSON with {'{'}type, data[]{'}'}
      </div>
    );
  }

  const colors = parsed.colors?.length ? parsed.colors : DEFAULT_COLORS;
  const common = { data: parsed.data, margin: { top: 4, right: 16, left: 0, bottom: 0 } };

  // Sparkline: minimal chrome, fixed low height
  if (parsed.type === 'sparkline') {
    return (
      <div className="cb-chart" style={{ padding: '6px 8px 4px' }}>
        {parsed.title && <div className="cb-chart__title">{parsed.title}</div>}
        <div className="cb-chart__inner" style={{ height: 40 }}>
          <ResponsiveContainer width="100%" height={40}>
            <LineChart data={parsed.data} margin={{ top: 2, right: 4, left: 4, bottom: 2 }}>
              {ys.map((key, i) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={colors[i % colors.length]}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  let inner: React.ReactElement;

  switch (parsed.type) {
    case 'bar':
      inner = (
        <BarChart {...common}>
          <CartesianGrid {...GRID_STROKE} />
          <XAxis dataKey={x} tick={AXIS_TICK} />
          <YAxis tick={AXIS_TICK} width={40} />
          <Tooltip contentStyle={TOOLTIP_CONTENT} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
          {ys.length > 1 && <Legend />}
          {ys.map((key, i) => (
            <Bar key={key} dataKey={key} fill={colors[i % colors.length]} radius={[2, 2, 0, 0]} />
          ))}
        </BarChart>
      );
      break;

    case 'line':
      inner = (
        <LineChart {...common}>
          <CartesianGrid {...GRID_STROKE} />
          <XAxis dataKey={x} tick={AXIS_TICK} />
          <YAxis tick={AXIS_TICK} width={40} />
          <Tooltip contentStyle={TOOLTIP_CONTENT} />
          {ys.length > 1 && <Legend />}
          {ys.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={colors[i % colors.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      );
      break;

    case 'area':
      inner = (
        <AreaChart {...common}>
          <defs>
            {ys.map((key, i) => (
              <linearGradient key={key} id={`cbag-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors[i % colors.length]} stopOpacity={0.25} />
                <stop offset="95%" stopColor={colors[i % colors.length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid {...GRID_STROKE} />
          <XAxis dataKey={x} tick={AXIS_TICK} />
          <YAxis tick={AXIS_TICK} width={40} />
          <Tooltip contentStyle={TOOLTIP_CONTENT} />
          {ys.length > 1 && <Legend />}
          {ys.map((key, i) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={colors[i % colors.length]}
              strokeWidth={2}
              fill={`url(#cbag-${i})`}
              dot={false}
            />
          ))}
        </AreaChart>
      );
      break;

    case 'pie': {
      const nameKey = x || 'name';
      const valueKey = ys[0] || 'value';
      inner = (
        <PieChart>
          <Pie
            data={parsed.data}
            dataKey={valueKey}
            nameKey={nameKey}
            cx="50%"
            cy="50%"
            outerRadius={80}
            paddingAngle={2}
          >
            {parsed.data.map((_, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={TOOLTIP_CONTENT} />
          <Legend />
        </PieChart>
      );
      break;
    }

    case 'scatter':
    default:
      inner = (
        <ScatterChart {...common}>
          <CartesianGrid {...GRID_STROKE} />
          <XAxis dataKey={x} tick={AXIS_TICK} name={x} />
          <YAxis dataKey={ys[0]} tick={AXIS_TICK} width={40} name={ys[0]} />
          <Tooltip contentStyle={TOOLTIP_CONTENT} cursor={{ strokeDasharray: '3 3' }} />
          <Scatter data={parsed.data} fill={colors[0]} />
        </ScatterChart>
      );
      break;
  }

  return (
    <div className="cb-chart">
      {parsed.title && <div className="cb-chart__title">{parsed.title}</div>}
      <div className="cb-chart__inner">
        <ResponsiveContainer width="100%" height={240}>
          {inner}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
