'use client';

import { HealthStatus } from '@/lib/types';

interface StatusBadgeProps {
  status: HealthStatus;
  label?: string;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const statusConfig: Record<
  HealthStatus,
  { color: string; text: string; bgClass: string }
> = {
  online: {
    color: 'text-success',
    text: 'Online',
    bgClass: 'bg-success/20',
  },
  offline: {
    color: 'text-error',
    text: 'Offline',
    bgClass: 'bg-error/20',
  },
  warning: {
    color: 'text-warning',
    text: 'Warning',
    bgClass: 'bg-warning/20',
  },
  unknown: {
    color: 'text-muted',
    text: 'Unknown',
    bgClass: 'bg-muted/20',
  },
  checking: {
    color: 'text-accent',
    text: 'Checking',
    bgClass: 'bg-accent/20',
  },
};

const sizeClasses = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
  lg: 'px-3 py-1.5 text-base',
};

export function StatusBadge({
  status,
  label,
  showLabel = true,
  size = 'sm',
}: StatusBadgeProps) {
  const config = statusConfig[status];

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full ${config.bgClass} ${sizeClasses[size]}`}
    >
      <span className={`status-dot ${status}`} />
      {showLabel && (
        <span className={`font-medium ${config.color}`}>
          {label || config.text}
        </span>
      )}
    </div>
  );
}

interface HealthCheckBadgeProps {
  label: string;
  status: HealthStatus;
  message?: string;
  responseTime?: number;
}

export function HealthCheckBadge({
  label,
  status,
  message,
  responseTime,
}: HealthCheckBadgeProps) {
  const config = statusConfig[status];

  return (
    <div
      className={`flex items-center justify-between p-2 rounded-lg ${config.bgClass} border border-white/5`}
    >
      <div className="flex items-center gap-2">
        <span className={`status-dot ${status}`} />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted">
        {responseTime !== undefined && <span>{responseTime}ms</span>}
        {message && (
          <span className="truncate max-w-[150px]" title={message}>
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
