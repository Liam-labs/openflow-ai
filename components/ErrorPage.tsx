'use client';

import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}

export function ErrorPage({ error, reset, title = 'Something went wrong' }: ErrorPageProps) {
  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: 'var(--df-bg)' }}
    >
      <div
        className="flex flex-col items-center gap-5 p-8 rounded-xl max-w-md w-full mx-4 text-center"
        style={{
          background: 'rgba(239, 68, 68, 0.06)',
          border: '1px solid rgba(239, 68, 68, 0.25)',
        }}
      >
        <div
          className="flex items-center justify-center w-12 h-12 rounded-full"
          style={{ background: 'rgba(239, 68, 68, 0.15)' }}
        >
          <AlertTriangle className="w-6 h-6" style={{ color: 'var(--df-error)' }} />
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-base font-semibold" style={{ color: 'var(--df-text)' }}>
            {title}
          </h2>
          {error.message && (
            <p className="text-sm" style={{ color: 'var(--df-text-muted)' }}>
              {error.message}
            </p>
          )}
          {error.digest && (
            <p className="text-xs font-mono mt-1" style={{ color: 'var(--df-text-dim)' }}>
              Error ID: {error.digest}
            </p>
          )}
        </div>
        <button
          onClick={reset}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{
            background: 'rgba(239, 68, 68, 0.15)',
            color: 'var(--df-error)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
          }}
          aria-label="Retry — reload this page"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Try again
        </button>
      </div>
    </div>
  );
}
