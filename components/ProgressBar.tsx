'use client';

/**
 * ProgressBar - Visual progress indicator with gradient fills, glow, and shimmer
 */

import React from 'react';

interface ProgressBarProps {
  percent: number;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  animated?: boolean;
}

export function ProgressBar({ percent, showLabel = true, size = 'md', className = '', animated = false }: ProgressBarProps) {
  const heights = {
    sm: 'h-1.5',
    md: 'h-2.5',
    lg: 'h-3.5',
  };

  const clampedPercent = Math.min(100, Math.max(0, percent));

  const getGradient = (pct: number) => {
    if (pct === 0) return 'transparent';
    if (pct === 100) return 'linear-gradient(90deg, #22c55e, #34d399, #10b981)';
    if (pct >= 67) return 'linear-gradient(90deg, #22c55e, #4ade80)';
    if (pct >= 34) return 'linear-gradient(90deg, #f59e0b, #fbbf24)';
    return 'linear-gradient(90deg, #ef4444, #f87171)';
  };

  const getGlow = (pct: number) => {
    if (pct === 0) return 'none';
    if (pct === 100) return '0 0 12px rgba(34, 197, 94, 0.4), 0 0 4px rgba(34, 197, 94, 0.2)';
    if (pct >= 67) return '0 0 8px rgba(34, 197, 94, 0.3)';
    if (pct >= 34) return '0 0 8px rgba(245, 158, 11, 0.3)';
    return '0 0 8px rgba(239, 68, 68, 0.3)';
  };

  const showShimmer = animated && clampedPercent > 0 && clampedPercent < 100;

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className={`flex-1 bg-white/[0.06] rounded-full overflow-hidden ${heights[size]} relative`}>
        <div
          className={`${heights[size]} rounded-full transition-all duration-700 ease-out relative`}
          style={{
            width: `${clampedPercent}%`,
            background: getGradient(percent),
            boxShadow: clampedPercent > 0 ? getGlow(percent) : 'none',
          }}
        >
          {showShimmer && (
            <div
              className="absolute inset-0 overflow-hidden rounded-full"
            >
              <div
                className="absolute inset-0"
                style={{
                  background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.2) 50%, transparent 100%)',
                  animation: 'sprint-shimmer 2s ease-in-out infinite',
                }}
              />
            </div>
          )}
        </div>
      </div>
      {showLabel && (
        <span className={`font-semibold min-w-[3rem] text-right tabular-nums ${
          clampedPercent === 100 ? 'text-emerald-400' :
          clampedPercent >= 67 ? 'text-green-400/70' :
          clampedPercent >= 34 ? 'text-amber-400/70' :
          clampedPercent > 0 ? 'text-red-400/70' :
          'text-white/30'
        } ${size === 'sm' ? 'text-[11px]' : size === 'lg' ? 'text-base' : 'text-sm'}`}>
          {percent}%
        </span>
      )}
    </div>
  );
}
