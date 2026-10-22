/**
 * PageSkeleton — Reusable loading skeleton for full-page route loading states.
 * Used by loading.tsx files in each route directory.
 */

interface SkeletonBarProps {
  width?: string;
  height?: string;
  className?: string;
}

function SkeletonBar({ width = '100%', height = '1rem', className = '' }: SkeletonBarProps) {
  return (
    <div
      className={`skeleton-pulse rounded ${className}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

interface PageSkeletonProps {
  /** Number of content card rows to show */
  rows?: number;
  /** Show a sidebar layout */
  sidebar?: boolean;
}

export function PageSkeleton({ rows = 4, sidebar = false }: PageSkeletonProps) {
  return (
    <div
      className="min-h-screen"
      style={{ background: 'var(--df-bg)' }}
      aria-label="Loading…"
      role="status"
    >
      {/* Header bar */}
      <div
        className="h-14 flex items-center px-6 gap-4"
        style={{ borderBottom: '1px solid var(--df-border-subtle)', background: 'var(--df-bg-header)' }}
        aria-hidden="true"
      >
        <SkeletonBar width="7rem" height="1.25rem" />
        <SkeletonBar width="1px" height="1.25rem" className="opacity-20" />
        <SkeletonBar width="5rem" height="0.875rem" />
        <div className="flex-1" />
        <SkeletonBar width="2rem" height="2rem" className="rounded-lg" />
        <SkeletonBar width="2rem" height="2rem" className="rounded-lg" />
      </div>

      <div className={`flex ${sidebar ? 'flex-row' : 'flex-col'} gap-0`}>
        {/* Sidebar (optional) */}
        {sidebar && (
          <div
            className="w-56 shrink-0 flex flex-col gap-2 p-4 min-h-screen"
            style={{ borderRight: '1px solid var(--df-border-subtle)' }}
            aria-hidden="true"
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonBar key={i} width={i % 3 === 0 ? '70%' : '90%'} height="0.875rem" />
            ))}
          </div>
        )}

        {/* Main content */}
        <div className="flex-1 p-6 flex flex-col gap-4" aria-hidden="true">
          {/* Page title area */}
          <div className="flex items-center gap-3 mb-2">
            <SkeletonBar width="1.75rem" height="1.75rem" className="rounded-lg shrink-0" />
            <SkeletonBar width="12rem" height="1.375rem" />
            <div className="flex-1" />
            <SkeletonBar width="6rem" height="2rem" className="rounded-lg" />
          </div>

          {/* Content cards */}
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl p-4 flex flex-col gap-3"
              style={{
                background: 'var(--df-surface)',
                border: '1px solid var(--df-border-subtle)',
                opacity: 1 - i * 0.12,
              }}
            >
              <div className="flex items-center gap-3">
                <SkeletonBar width="1.25rem" height="1.25rem" className="rounded shrink-0" />
                <SkeletonBar width={i % 2 === 0 ? '40%' : '55%'} height="0.875rem" />
                <div className="flex-1" />
                <SkeletonBar width="3.5rem" height="1.375rem" className="rounded-full" />
              </div>
              <SkeletonBar width="100%" height="0.75rem" />
              <SkeletonBar width="75%" height="0.75rem" />
            </div>
          ))}
        </div>
      </div>

      <style>{`
        @keyframes skeleton-shimmer {
          0%   { opacity: 0.35; }
          50%  { opacity: 0.65; }
          100% { opacity: 0.35; }
        }
        .skeleton-pulse {
          background: rgba(var(--df-accent-ch), 0.12);
          animation: skeleton-shimmer 1.6s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
