'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { ChartPanel } from './ChartPanel';
import { Activity, Server } from 'lucide-react';

export interface MachineMemory {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  usagePercent: number;
  swapTotalMb: number;
  swapUsedMb: number;
  swapPercent: number;
  oomRisk: 'low' | 'moderate' | 'high' | 'critical';
  wslConfigMemoryMb: number | null;
}

interface MachineEntry {
  id: string;
  label: string;
  kind: 'wsl' | 'server';
  reachable: boolean;
  reason?: string;
  memory?: MachineMemory;
}

function fmtGb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

const RISK_COLORS: Record<string, string> = {
  low: '#22c55e',
  moderate: '#eab308',
  high: '#f97316',
  critical: '#ef4444',
};

const RISK_LABELS: Record<string, string> = {
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  critical: 'CRITICAL',
};

/**
 * Memory for both machines. Uses GET /api/system/machine-memory (desktop WSL and the Remote DevFlow Server).
 * Until that exists it falls back to this machine's own reading from /api/system/wsl-memory, named for what it really is.
 */
function useMachineMemory() {
  const [machines, setMachines] = useState<MachineEntry[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const both = await fetch('/api/system/machine-memory', { cache: 'no-store' });
      if (both.ok) {
        const body = await both.json();
        if (Array.isArray(body?.machines)) {
          setMachines(body.machines.map((m: Partial<MachineEntry> & { id: string }) => ({
            id: m.id,
            label: m.label ?? (m.id === 'desktop' ? 'Desktop PC (WSL)' : 'Remote server'),
            kind: m.id === 'desktop' ? 'wsl' : 'server',
            reachable: m.reachable !== false,
            reason: m.reason,
            memory: m.memory,
          })));
          setError(false);
          return;
        }
      }
      const res = await fetch('/api/system/wsl-memory', { cache: 'no-store' });
      if (!res.ok) { setError(true); return; }
      const own = await res.json();
      const kind: 'wsl' | 'server' = own.machine === 'wsl' ? 'wsl' : 'server';
      setMachines([
        { id: kind === 'wsl' ? 'desktop' : 'server', label: kind === 'wsl' ? 'Desktop PC (WSL)' : 'Remote server', kind, reachable: true, memory: own },
        ...(kind === 'wsl'
          ? [{ id: 'server', label: 'Remote server', kind: 'server' as const, reachable: false, reason: 'Not connected yet' }]
          : [{ id: 'desktop', label: 'Desktop PC (WSL)', kind: 'wsl' as const, reachable: false, reason: 'The desktop memory report is not connected yet.' }]),
      ]);
      setError(false);
    } catch { setError(true); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  return { machines, error };
}

function GaugePanel({ machine }: { machine: MachineEntry }) {
  const data = machine.memory;
  const Icon = machine.kind === 'wsl' ? Activity : Server;
  const title = `${machine.label} memory`;
  if (!machine.reachable || !data) {
    return (
      <ChartPanel title={title} icon={<Icon size={12} />} height={240}>
        <div className="wmg-error">{machine.reason || 'Not available right now.'}</div>
      </ChartPanel>
    );
  }
  const riskColor = RISK_COLORS[data.oomRisk] ?? RISK_COLORS.low;
  const riskLabel = RISK_LABELS[data.oomRisk] ?? RISK_LABELS.low;
  return (
    <ChartPanel title={title} icon={<Icon size={12} />} height={240}>
      <div className="wmg-body">
        <div className="wmg-gauge-col">
          <div className="wmg-ring" style={{ '--pct': data.usagePercent, '--risk': riskColor } as React.CSSProperties}>
            <svg viewBox="0 0 120 120" className="wmg-ring-svg">
              <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="10" />
              <circle
                cx="60" cy="60" r="52"
                fill="none"
                stroke={riskColor}
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={`${data.usagePercent * 3.267} 326.7`}
                transform="rotate(-90 60 60)"
                style={{ transition: 'stroke-dasharray 0.6s ease, stroke 0.6s ease' }}
              />
            </svg>
            <div className="wmg-ring-center">
              <span className="wmg-ring-pct" style={{ color: riskColor }}>{data.usagePercent}%</span>
              <span className="wmg-ring-label">used</span>
            </div>
          </div>
          <div className="wmg-risk-badge" style={{ background: riskColor + '22', color: riskColor, borderColor: riskColor + '44' }}>
            OOM Risk: {riskLabel}
          </div>
        </div>

        <div className="wmg-stats-col">
          <div className="wmg-stat">
            <span className="wmg-stat-label">{machine.kind === 'wsl' ? 'Allocated' : 'Total RAM'}</span>
            <span className="wmg-stat-value">{fmtGb(data.totalMb)}</span>
            <span className="wmg-stat-sub">{machine.kind === 'wsl' ? (data.wslConfigMemoryMb ? 'WSL config limit' : 'Given to WSL') : 'Installed in the server'}</span>
          </div>
          <div className="wmg-stat">
            <span className="wmg-stat-label">Used / Available</span>
            <span className="wmg-stat-value">
              <span style={{ color: riskColor }}>{fmtGb(data.usedMb)}</span>
              {' / '}
              <span style={{ color: '#22c55e' }}>{fmtGb(data.availableMb)}</span>
            </span>
            <span className="wmg-stat-sub">
              {data.availableMb < 1024 ? `Only ${data.availableMb} MB free` : `${fmtGb(data.availableMb)} available`}
            </span>
          </div>
          {data.swapTotalMb > 0 && (
            <div className="wmg-stat">
              <span className="wmg-stat-label">
                Swap
                {data.swapPercent > 80 && <span className="wmg-warn-dot" />}
              </span>
              <span className="wmg-stat-value" style={{ color: data.swapPercent > 80 ? '#f97316' : 'rgba(255,255,255,0.7)' }}>
                {fmtGb(data.swapUsedMb)} / {fmtGb(data.swapTotalMb)}
              </span>
              <span className="wmg-stat-sub">{data.swapPercent}% used</span>
            </div>
          )}
        </div>
      </div>
    </ChartPanel>
  );
}

/** Desktop WSL and Remote DevFlow Server memory, side by side. */
export function MachineMemoryGauges() {
  const { machines, error } = useMachineMemory();
  if (error && !machines) {
    return <ChartPanel title="Memory" icon={<Activity size={12} />} height={240}><div className="wmg-error">Unable to read memory</div></ChartPanel>;
  }
  if (!machines) {
    return (
      <ChartPanel title="Memory" icon={<Activity size={12} />} height={240}>
        <div className="chart-panel__collecting"><span className="chart-panel__collecting-dot" />Loading…</div>
      </ChartPanel>
    );
  }
  // Desktop first: it is the machine under pressure.
  const ordered = [...machines].sort((a, b) => (a.id === 'desktop' ? -1 : 0) - (b.id === 'desktop' ? -1 : 0));
  return <>{ordered.map(m => <GaugePanel key={m.id} machine={m} />)}</>;
}
