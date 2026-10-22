'use client';

import React, { useEffect, useRef } from 'react';
import type { SystemsNavState } from './systems-types';

export interface ServiceStatusDonutProps {
  online: number;
  stopped: number;
  errored: number;
  total: number;
  onNavigate: (state: Partial<SystemsNavState>) => void;
  height?: number;
}

// SVG arc helpers
const CX = 50;
const CY = 50;
const R = 36;
const CIRCUMFERENCE = 2 * Math.PI * R;

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const start = polarToCartesian(cx, cy, r, endDeg);
  const end = polarToCartesian(cx, cy, r, startDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

function healthColour(pct: number): string {
  if (pct >= 90) return '#22c55e';
  if (pct >= 70) return '#84cc16';
  if (pct >= 50) return '#eab308';
  return '#ef4444';
}

export function ServiceStatusDonut({
  online,
  stopped,
  errored,
  total,
  onNavigate,
  height = 200,
}: ServiceStatusDonutProps) {
  const arcRef = useRef<SVGPathElement>(null);
  const errArcRef = useRef<SVGPathElement>(null);

  const healthPct = total > 0 ? online / total : 0;
  const errPct    = total > 0 ? errored / total : 0;
  const colour    = healthColour(healthPct * 100);

  // Degrees: full circle = 360. Start from top (-90 offset handled in polarToCartesian).
  const onlineDeg  = healthPct * 358; // leave 2deg gap
  const errorStart = onlineDeg + 2;
  const errorDeg   = errorStart + errPct * 358;

  // Animate dash on mount
  useEffect(() => {
    const el = arcRef.current;
    if (!el || onlineDeg === 0) return;
    const len = el.getTotalLength();
    el.style.strokeDasharray  = `${len}`;
    el.style.strokeDashoffset = `${len}`;
    el.style.transition = 'none';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = 'stroke-dashoffset 900ms cubic-bezier(0.16,1,0.3,1)';
        el.style.strokeDashoffset = '0';
      });
    });
  }, [online, total, onlineDeg]);

  useEffect(() => {
    const el = errArcRef.current;
    if (!el || errored === 0) return;
    const len = el.getTotalLength();
    el.style.strokeDasharray  = `${len}`;
    el.style.strokeDashoffset = `${len}`;
    el.style.transition = 'none';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = 'stroke-dashoffset 900ms cubic-bezier(0.16,1,0.3,1) 200ms';
        el.style.strokeDashoffset = '0';
      });
    });
  }, [errored, total]);

  return (
    <div
      className="ssd-wrap"
      style={{ height }}
      role="button"
      tabIndex={0}
      aria-label={`Service status: ${online} of ${total} online`}
      onClick={() => onNavigate({ section: 'services' })}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onNavigate({ section: 'services' }); }}
    >
      <div className="ssd-header">
        <span className="ssd-title">Service Status</span>
        <span className="ssd-nav-hint">View all →</span>
      </div>

      <div className="ssd-body">
        <svg
          viewBox="0 0 100 100"
          className="ssd-svg"
          aria-hidden="true"
        >
          <defs>
            <filter id="ssd-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="ssd-glow-err" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Track ring */}
          <circle
            cx={CX} cy={CY} r={R}
            fill="none"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="5"
          />

          {/* Online arc */}
          {onlineDeg > 0 && (
            <path
              ref={arcRef}
              d={arcPath(CX, CY, R, 0, onlineDeg)}
              fill="none"
              stroke={colour}
              strokeWidth="5"
              strokeLinecap="round"
              filter="url(#ssd-glow)"
              style={{ '--arc-colour': colour } as React.CSSProperties}
            />
          )}

          {/* Errored arc */}
          {errored > 0 && (
            <path
              ref={errArcRef}
              d={arcPath(CX, CY, R, errorStart, errorDeg)}
              fill="none"
              stroke="#ef4444"
              strokeWidth="5"
              strokeLinecap="round"
              filter="url(#ssd-glow-err)"
            />
          )}

          {/* Centre: count */}
          <text
            x={CX} y={CY - 5}
            textAnchor="middle"
            dominantBaseline="middle"
            className="ssd-center-value"
            fill="white"
          >
            {online}
          </text>

          {/* Centre: label */}
          <text
            x={CX} y={CY + 10}
            textAnchor="middle"
            dominantBaseline="middle"
            className="ssd-center-label"
            fill="rgba(255,255,255,0.4)"
          >
            of {total} online
          </text>
        </svg>

        {/* Stat pills */}
        <div className="ssd-stats">
          {online > 0 && (
            <span className="ssd-pill ssd-pill--online">
              <span className="ssd-pill__dot" />
              {online} online
            </span>
          )}
          {errored > 0 && (
            <span className="ssd-pill ssd-pill--error">
              <span className="ssd-pill__dot" />
              {errored} errored
            </span>
          )}
          {stopped > 0 && (
            <span className="ssd-pill ssd-pill--stopped">
              <span className="ssd-pill__dot" />
              {stopped} stopped
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
