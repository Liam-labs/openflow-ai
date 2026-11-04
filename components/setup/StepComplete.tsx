'use client';

import { CheckCircle, ChevronRight, ArrowRight, Brain } from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/brand';

interface StepCompleteProps {
  onGoToDashboard: () => void;
  /** True when the wizard started a first team; the button then opens its channel. */
  hasChannel?: boolean;
  /** The channel it opens is the Setup channel, where Jack, the setup assistant, is waiting. */
  opensAssistant?: boolean;
}

// ─── Next Steps Data ──────────────────────────────────────────────────────────

const NEXT_STEPS = [
  'Talk to your agents in the channel',
  'Point them at your own project folder',
  'Add more agents from the roster',
  'Connect more: Systems > Connections > Set up more (password, phone access, your own domain, browser)',
] as const;

// ─── Animated Gradient Border ─────────────────────────────────────────────────

// Injected once at mount via a style tag — avoids modifying globals.css.
// The animation uses only transform + opacity (S-tier GPU props).
const KEYFRAMES = `
@keyframes dfCardGlow {
  0%, 100% { opacity: 0.55; }
  50%       { opacity: 1; }
}
@keyframes dfCheckPop {
  0%   { transform: scale(0.6); opacity: 0; }
  60%  { transform: scale(1.12); opacity: 1; }
  80%  { transform: scale(0.95); }
  100% { transform: scale(1); opacity: 1; }
}
`;

let injected = false;
function injectKeyframes() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.textContent = KEYFRAMES;
  document.head.appendChild(style);
}

// ─── Step Complete ─────────────────────────────────────────────────────────────

export function StepComplete({ onGoToDashboard, hasChannel, opensAssistant }: StepCompleteProps) {
  // Inject once when component mounts (runs client-side only)
  if (typeof window !== 'undefined') injectKeyframes();

  return (
    <div className="relative">
      {/* Animated gradient border wrapper */}
      <div
        className="absolute inset-0 rounded-[18px] pointer-events-none"
        aria-hidden="true"
        style={{
          background:
            'linear-gradient(135deg, rgba(59,130,246,0.45) 0%, rgba(34,197,94,0.35) 50%, rgba(59,130,246,0.45) 100%)',
          animation: 'dfCardGlow 3s ease-in-out infinite',
          filter: 'blur(12px)',
          zIndex: 0,
        }}
      />

      <div className="glass-card p-8 relative z-10 flex flex-col items-center text-center gap-0">
        {/* Checkmark */}
        <div className="relative mb-6">
          {/* Pulsing glow behind the icon */}
          <div
            className="absolute inset-0 rounded-full animate-pulse"
            style={{
              background: 'rgba(34, 197, 94, 0.20)',
              filter: 'blur(16px)',
              transform: 'scale(1.6)',
            }}
            aria-hidden="true"
          />
          {/* Icon container */}
          <div
            className="relative p-4 rounded-full"
            style={{
              background: 'rgba(34, 197, 94, 0.12)',
              border: '2px solid rgba(34, 197, 94, 0.35)',
              boxShadow: '0 0 32px rgba(34, 197, 94, 0.18)',
              animation: 'dfCheckPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both',
            }}
          >
            <CheckCircle className="w-10 h-10 text-green-400" aria-hidden="true" />
          </div>
        </div>

        {/* Heading */}
        <h2 className="text-2xl font-semibold text-white leading-tight mb-1">
          Setup Complete
        </h2>
        <p className="text-sm mb-7" style={{ color: 'rgba(var(--ink-ch), 0.40)' }}>
          {PRODUCT_NAME} is ready.
        </p>

        {/* Divider: What's Next */}
        <div className="flex items-center gap-3 w-full mb-5">
          <div
            className="flex-1 h-px"
            style={{ background: 'rgba(59, 130, 246, 0.15)' }}
          />
          <span className="text-xs tracking-wider uppercase flex-shrink-0 text-[#60a5fa]"
            style={{ opacity: 0.75 }}>
            What&apos;s Next
          </span>
          <div
            className="flex-1 h-px"
            style={{ background: 'rgba(59, 130, 246, 0.15)' }}
          />
        </div>

        {/* Next steps list */}
        <ul className="w-full flex flex-col gap-2.5 mb-8" aria-label="Suggested next steps">
          {NEXT_STEPS.map((step) => (
            <li
              key={step}
              className="flex items-center gap-2.5 text-sm"
              style={{ color: 'rgba(var(--ink-ch), 0.55)' }}
            >
              <ChevronRight
                className="w-4 h-4 flex-shrink-0 text-[#60a5fa]"
                aria-hidden="true"
              />
              {step}
            </li>
          ))}
        </ul>

        <p className="w-full text-xs text-left mb-6" style={{ color: 'rgba(var(--ink-ch), 0.45)' }}>
          Scripts and other programs that call the API need the access token. Setup saved it as DEVFLOW_API_TOKEN in the
          .env file in the app folder, which only your user account can read. This computer does not need it.
        </p>


        {/* Optional extra: shared memory. Opens the existing memory card; nothing is installed from here. */}
        <div
          className="w-full text-left rounded-xl p-4 mb-6 flex gap-3"
          style={{ background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)' }}
          data-testid="memory-offer"
        >
          <Brain className="w-5 h-5 flex-shrink-0 mt-0.5 text-[#60a5fa]" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white">Give your team a memory</h3>
            <p className="text-xs mt-1" style={{ color: 'rgba(var(--ink-ch), 0.6)' }}>
              Your agents can save notes and search them later, once you give them access, so they stop solving the same problem twice.
              It keeps notes your agents write, never your files. It stays on this computer.
            </p>
            <a href="/operations#systems/connections" className="inline-block mt-3 text-xs font-semibold text-[#60a5fa] underline underline-offset-2">
              Set up memory (Systems &gt; Connections)
            </a>
          </div>
        </div>

        {/* CTA */}
        <button
          type="button"
          onClick={onGoToDashboard}
          className="glass-button primary flex items-center gap-2.5 px-8 py-3 text-sm font-semibold text-white"
          style={{
            boxShadow: '0 0 24px rgba(59, 130, 246, 0.20)',
          }}
        >
          {opensAssistant ? 'Meet Jack, your assistant' : hasChannel ? 'Open my team' : 'Open Dashboard'}
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
