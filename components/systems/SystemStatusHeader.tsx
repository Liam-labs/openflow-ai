'use client';

import React, { useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { animate } from 'framer-motion';
import { useMetricsBuffer } from '@/lib/hooks/useMetricsBuffer';

interface PM2ProcessLike {
  name: string;
  status: string;
}

interface SystemStatusHeaderProps {
  processes: PM2ProcessLike[];
  onRefresh: () => void;
  sseConnections?: number;
  maxSseConnections?: number;
  sseBuffer?: number;
  maxSseBuffer?: number;
}

// ─── Animated counter ──────────────────────────────────────────────────────────

function AnimatedCount({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const from = prev.current;
    prev.current = value;
    if (from === value) return;
    const ctrl = animate(from, value, {
      duration: 0.5,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => { node.textContent = Math.round(v).toString(); },
    });
    return () => ctrl.stop();
  }, [value]);

  return <span ref={ref}>{value}</span>;
}

// ─── Resource gauge bar ────────────────────────────────────────────────────────

function GaugeBar({
  label,
  pct,
  value,
  color,
}: {
  label: string;
  pct: number;
  value: string;
  color: string;
}) {
  return (
    <div className="ssh-gauge">
      <span className="ssh-gauge__label">{label}</span>
      <div className="ssh-gauge__track">
        <div
          className="ssh-gauge__fill"
          style={{ width: `${Math.min(100, pct)}%`, background: color }}
        />
      </div>
      <span className="ssh-gauge__value" style={{ color: 'rgba(255,255,255,0.65)' }}>{value}</span>
    </div>
  );
}

// ─── Status pill ───────────────────────────────────────────────────────────────

function StatusPill({
  count,
  label,
  dotColor,
  glow,
  pulse,
  hidden,
}: {
  count: number;
  label: string;
  dotColor: string;
  glow?: string;
  pulse?: boolean;
  hidden?: boolean;
}) {
  if (hidden) return null;

  return (
    <div
      className={`ssh-pill${pulse ? ' ssh-pill--pulse' : ''}`}
      style={glow ? { boxShadow: glow } : undefined}
    >
      <span
        className={`ssh-pill__dot${pulse ? ' ssh-pill__dot--pulse' : ''}`}
        style={{ background: dotColor }}
      />
      <span className="ssh-pill__count">
        <AnimatedCount value={count} />
      </span>
      <span className="ssh-pill__label">{label}</span>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function SystemStatusHeader({
  processes, onRefresh,
  sseConnections = 0, maxSseConnections = 50,
  sseBuffer = 0, maxSseBuffer = 100,
}: SystemStatusHeaderProps) {
  const { cpuMemorySeries } = useMetricsBuffer();

  const services = processes.filter((p) => !p.name.startsWith('dev-'));
  const devServers = processes.filter((p) => p.name.startsWith('dev-') && p.status === 'online');

  const online  = services.filter((p) => p.status === 'online').length;
  const stopped = services.filter((p) => p.status === 'stopped' || p.status === 'stopping').length;
  const errored = services.filter((p) => p.status === 'errored').length;

  // Latest metrics
  const latest = cpuMemorySeries.length > 0 ? cpuMemorySeries[cpuMemorySeries.length - 1] : null;
  const cpuPct  = latest?.cpu ?? 0;
  const memBytes = latest?.memory ?? 0;
  const memGb   = memBytes / (1024 * 1024 * 1024);

  // CPU color scaling: green → yellow → red
  const cpuColor =
    cpuPct > 80 ? '#ef4444' :
    cpuPct > 50 ? '#eab308' :
    '#22c55e';

  const memFormatted = memGb >= 1
    ? `${memGb.toFixed(1)} GB`
    : `${(memBytes / (1024 * 1024)).toFixed(0)} MB`;

  // Rough cap: assume 16GB total for gauge fill. If useMetricsBuffer gives total, use that.
  const MEM_TOTAL_GB = 16;
  const memPct = Math.min(100, (memGb / MEM_TOTAL_GB) * 100);

  return (
    <div className="ssh-header">
      {/* Left: title */}
      <div className="ssh-left">
        <button className="ssh-refresh" onClick={onRefresh} title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Center: status pills */}
      <div className="ssh-pills">
        <StatusPill
          count={online}
          label="Online"
          dotColor="#22c55e"
          glow={online > 0 ? '0 0 12px rgba(34,197,94,0.25)' : undefined}
        />
        <StatusPill
          count={stopped}
          label="Stopped"
          dotColor="#71717a"
        />
        <StatusPill
          count={errored}
          label="Errored"
          dotColor="#ef4444"
          glow={errored > 0 ? '0 0 12px rgba(239,68,68,0.4)' : undefined}
          pulse={errored > 0}
          hidden={errored === 0}
        />
        <StatusPill
          count={devServers.length}
          label="Dev Active"
          dotColor="#3b82f6"
          hidden={devServers.length === 0}
        />
      </div>

      {/* Right: resource gauges */}
      <div className="ssh-gauges">
        <GaugeBar
          label="CPU"
          pct={cpuPct}
          value={`${cpuPct.toFixed(1)}%`}
          color={cpuColor}
        />
        <GaugeBar
          label="MEM"
          pct={memPct}
          value={memFormatted}
          color="#3b82f6"
        />
        <GaugeBar
          label="SSE"
          pct={(sseConnections / maxSseConnections) * 100}
          value={`${sseConnections}/${maxSseConnections}`}
          color={sseConnections >= maxSseConnections * 0.8 ? '#ef4444' : sseConnections >= maxSseConnections * 0.5 ? '#eab308' : '#22c55e'}
        />
        <GaugeBar
          label="BUF"
          pct={(sseBuffer / maxSseBuffer) * 100}
          value={`${sseBuffer}/${maxSseBuffer}`}
          color={sseBuffer >= maxSseBuffer * 0.8 ? '#ef4444' : sseBuffer >= maxSseBuffer * 0.5 ? '#eab308' : '#3b82f6'}
        />
      </div>
    </div>
  );
}
