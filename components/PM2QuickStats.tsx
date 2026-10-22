'use client';

import { PM2Process } from '@/lib/types';
import { formatMemory } from '@/lib/pm2-utils';
import { Activity, Cpu, HardDrive } from 'lucide-react';

interface PM2QuickStatsProps {
  processes: PM2Process[];
}

export function PM2QuickStats({ processes }: PM2QuickStatsProps) {
  const onlineCount = processes.filter((p) => p.status === 'online').length;
  const stoppedCount = processes.filter((p) => p.status === 'stopped').length;
  const erroredCount = processes.filter((p) => p.status === 'errored').length;

  const totalMemory = processes
    .filter((p) => p.status === 'online')
    .reduce((sum, p) => sum + p.memory, 0);

  const avgCpu = processes.filter((p) => p.status === 'online').length > 0
    ? processes
        .filter((p) => p.status === 'online')
        .reduce((sum, p) => sum + p.cpu, 0) / onlineCount
    : 0;

  const activePorts = processes
    .filter((p) => p.status === 'online' && p.port)
    .map((p) => p.port)
    .sort((a, b) => (a || 0) - (b || 0));

  return (
    <div className="pm2-quick-stats">
      {/* Process Counts */}
      <div className="pm2-stat">
        <Activity className="w-4 h-4 text-accent" />
        <span className="pm2-stat-value">
          <span className="text-success">{onlineCount}</span> online
          {stoppedCount > 0 && (
            <span className="text-muted"> · {stoppedCount} stopped</span>
          )}
          {erroredCount > 0 && (
            <span className="text-error"> · {erroredCount} errored</span>
          )}
        </span>
      </div>

      {/* Total Memory */}
      <div className="pm2-stat">
        <HardDrive className="w-4 h-4 text-accent" />
        <span className="pm2-stat-value">
          {formatMemory(totalMemory)}
        </span>
      </div>

      {/* Average CPU */}
      <div className="pm2-stat">
        <Cpu className="w-4 h-4 text-accent" />
        <span className="pm2-stat-value">
          {avgCpu.toFixed(1)}% CPU
        </span>
      </div>

      {/* Active Ports */}
      {activePorts.length > 0 && (
        <div className="pm2-stat pm2-stat-ports">
          <span className="text-muted">Ports:</span>
          <span className="pm2-stat-value font-mono">
            {activePorts.map((port) => `:${port}`).join(', ')}
          </span>
        </div>
      )}
    </div>
  );
}
