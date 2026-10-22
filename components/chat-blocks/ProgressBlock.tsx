'use client';

import React, { useLayoutEffect, useRef } from 'react';
import './ProgressBlock.css';
import { parseProgressSpec } from '@/lib/chat-block-parsers';

export interface ProgressBlockProps {
  spec: string;
}

function colorTier(value: number): 'amber' | 'blue' | 'green' {
  if (value >= 80) return 'green';
  if (value >= 50) return 'blue';
  return 'amber';
}

export default function ProgressBlock({ spec }: ProgressBlockProps) {
  const parsed = parseProgressSpec(spec);
  const fillRef = useRef<HTMLDivElement>(null);

  // Animate fill from 0 → target on mount
  useLayoutEffect(() => {
    const el = fillRef.current;
    if (!el || !parsed) return;
    el.style.width = '0%';
    // rAF to ensure the 0% is painted before the transition
    const id = requestAnimationFrame(() => {
      el.style.width = `${parsed.value}%`;
    });
    return () => cancelAnimationFrame(id);
  }, [parsed?.value]);

  if (!parsed) {
    return (
      <div className="cb-progress cb-progress--error" role="alert">
        ProgressBlock: invalid spec — expected JSON with {'{'}value: 0-100, label: string{'}'}.
      </div>
    );
  }

  const tier = colorTier(parsed.value);
  const fillStyle: React.CSSProperties = parsed.color
    ? { background: parsed.color }
    : {};

  return (
    <div className="cb-progress" role="meter" aria-valuenow={parsed.value} aria-valuemin={0} aria-valuemax={100} aria-label={parsed.label}>
      <div className="cb-progress__header">
        <span className="cb-progress__label">{parsed.label}</span>
        <span className="cb-progress__pct">{parsed.value}%</span>
      </div>
      <div className="cb-progress__track">
        <div
          ref={fillRef}
          className={`cb-progress__fill${parsed.color ? '' : ` cb-progress__fill--${tier}`}`}
          style={fillStyle}
        />
      </div>
    </div>
  );
}
