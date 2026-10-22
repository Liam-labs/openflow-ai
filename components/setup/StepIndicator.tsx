'use client';

import { CheckCircle } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

export type WizardStep = 1 | 2 | 3;

interface StepIndicatorProps {
  current: WizardStep;
}

const STEPS: { n: WizardStep; label: string }[] = [
  { n: 1, label: 'About you' },
  { n: 2, label: 'AI access' },
  { n: 3, label: 'Your team' },
];

// ─── Component ───────────────────────────────────────────────────────────────

export function StepIndicator({ current }: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8" role="navigation" aria-label="Setup progress">
      {STEPS.map((s, i) => {
        const isCompleted = s.n < current;
        const isActive = s.n === current;

        return (
          <div key={s.n} className="flex items-center">
            <div className="flex flex-col items-center gap-1.5">
              {/* Circle */}
              <div
                className={[
                  'w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold border transition-all duration-300',
                  isCompleted
                    ? 'bg-[#3b82f6]/30 border-[#3b82f6]/60 text-[#60a5fa]'
                    : isActive
                    ? 'bg-[#3b82f6]/40 border-[#3b82f6] text-white shadow-[0_0_12px_rgba(59,130,246,0.4)]'
                    : 'bg-white/5 border-white/10 text-white/30',
                ].join(' ')}
                aria-current={isActive ? 'step' : undefined}
              >
                {isCompleted ? (
                  <CheckCircle className="w-3.5 h-3.5" />
                ) : (
                  s.n
                )}
              </div>

              {/* Label */}
              <span
                className={[
                  'text-[10px] font-medium tracking-wide hidden sm:block',
                  isActive ? 'text-white/80' : isCompleted ? 'text-[#60a5fa]/70' : 'text-white/30',
                ].join(' ')}
              >
                {s.label}
              </span>
            </div>

            {/* Connector line */}
            {i < STEPS.length - 1 && (
              <div
                className={[
                  'w-10 h-px mb-5 mx-1 transition-all duration-500',
                  isCompleted ? 'bg-[#3b82f6]/40' : 'bg-white/10',
                ].join(' ')}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
