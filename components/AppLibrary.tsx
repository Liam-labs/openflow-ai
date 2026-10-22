'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Search,
  Settings,
  Plus,
  Sparkles,
  Layers,
  Code,
  Brain,
  Film,
  Workflow,
  MonitorDot,
  Wrench,
  LayoutGrid,
  X,
  type LucideIcon,
} from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { AppRegistryEntry, AppCategory } from '@/lib/types';
import { AppCard } from './AppCard';
import { AppRegistryModal } from './AppRegistryModal';

// ============================================
// Constants
// ============================================

type FilterCategory = 'all' | AppCategory;

interface CategoryFilter {
  value: FilterCategory;
  label: string;
  icon: React.ReactNode;
}

const CATEGORY_FILTERS: CategoryFilter[] = [
  { value: 'all', label: 'All', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
  { value: 'development', label: 'Development', icon: <Code className="w-3.5 h-3.5" /> },
  { value: 'ai', label: 'AI', icon: <Brain className="w-3.5 h-3.5" /> },
  { value: 'media', label: 'Media', icon: <Film className="w-3.5 h-3.5" /> },
  { value: 'automation', label: 'Automation', icon: <Workflow className="w-3.5 h-3.5" /> },
  { value: 'monitoring', label: 'Monitoring', icon: <MonitorDot className="w-3.5 h-3.5" /> },
  { value: 'utility', label: 'Utility', icon: <Wrench className="w-3.5 h-3.5" /> },
];

function resolveLucideIcon(name: string): LucideIcon | null {
  const pascalName = name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const icons = LucideIcons as unknown as Record<string, LucideIcon>;
  return icons[pascalName] || null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 59, g: 130, b: 246 };
}

// ============================================
// AppLibrary Component
// ============================================

interface AppLibraryProps {
  onAppCountChange?: (count: number) => void;
}

export function AppLibrary({ onAppCountChange }: AppLibraryProps) {
  const [apps, setApps] = useState<AppRegistryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<FilterCategory>('all');
  const [showRegistry, setShowRegistry] = useState(false);
  const [editingApp, setEditingApp] = useState<AppRegistryEntry | null>(null);
  const [healthStatuses, setHealthStatuses] = useState<Record<string, 'online' | 'offline'>>({});
  const [startingApp, setStartingApp] = useState<AppRegistryEntry | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const healthPollRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch apps
  const fetchApps = useCallback(async () => {
    try {
      const res = await fetch('/api/apps');
      const data = await res.json();
      const fetchedApps = data.apps || [];
      setApps(fetchedApps);
      onAppCountChange?.(fetchedApps.length);
    } catch (err) {
      console.error('Failed to fetch apps:', err);
    } finally {
      setIsLoading(false);
    }
  }, [onAppCountChange]);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  // Check health for apps that have health checks
  const checkHealth = useCallback(async () => {
    const appsWithHealth = apps.filter((a) => a.healthCheck);
    if (appsWithHealth.length === 0) return;

    const statuses: Record<string, 'online' | 'offline'> = {};

    await Promise.all(
      appsWithHealth.map(async (app) => {
        try {
          if (app.healthCheck?.type === 'port') {
            // Use the ports API to check if port is listening
            const res = await fetch('/api/ports');
            const data = await res.json();
            const port = parseInt(app.healthCheck.target, 10);
            const isListening = (data.ports || []).some(
              (p: { port: number }) => p.port === port
            );
            statuses[app.id] = isListening ? 'online' : 'offline';
          } else if (app.healthCheck?.type === 'http') {
            const res = await fetch('/api/health', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                projectIds: [],
                customChecks: [
                  {
                    id: app.id,
                    type: 'http',
                    url: app.healthCheck.target,
                    label: app.name,
                  },
                ],
              }),
            });
            const data = await res.json();
            const status = data.statuses?.[0];
            statuses[app.id] = status?.overallStatus === 'online' ? 'online' : 'offline';
          }
        } catch {
          statuses[app.id] = 'offline';
        }
      })
    );

    setHealthStatuses(statuses);
  }, [apps]);

  useEffect(() => {
    if (apps.length > 0) {
      checkHealth();
      const interval = setInterval(checkHealth, 15000);
      return () => clearInterval(interval);
    }
  }, [apps, checkHealth]);

  // Service start flow
  const handleStartService = useCallback(async (app: AppRegistryEntry) => {
    setStartingApp(app);
    setStartError(null);

    try {
      // Call start API
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', id: app.id }),
      });
      const data = await res.json();

      if (!data.success) {
        setStartError(data.error || 'Failed to start service');
        return;
      }

      if (data.alreadyRunning) {
        // Already running, just open
        setStartingApp(null);
        if (app.url) window.open(app.url, '_blank', 'noopener,noreferrer');
        return;
      }

      // Poll health until online (max 30 seconds)
      let attempts = 0;
      const maxAttempts = 30;

      const pollHealth = async () => {
        attempts++;
        if (attempts > maxAttempts) {
          setStartError('Service took too long to start. It may still be starting in the background.');
          setStartingApp(null);
          return;
        }

        try {
          if (app.healthCheck?.type === 'port') {
            const res = await fetch('/api/ports');
            const portData = await res.json();
            const port = parseInt(app.healthCheck.target, 10);
            const isOnline = (portData.ports || []).some(
              (p: { port: number }) => p.port === port
            );

            if (isOnline) {
              // Update health status
              setHealthStatuses((prev) => ({ ...prev, [app.id]: 'online' }));
              setStartingApp(null);
              // Open the app after a brief delay for the server to fully initialize
              setTimeout(() => {
                if (app.url) window.open(app.url, '_blank', 'noopener,noreferrer');
              }, 500);
              return;
            }
          }
        } catch {
          // Ignore poll errors, keep trying
        }

        healthPollRef.current = setTimeout(pollHealth, 1000);
      };

      // Start polling after a short initial delay
      healthPollRef.current = setTimeout(pollHealth, 1500);
    } catch (err) {
      console.error('Failed to start service:', err);
      setStartError('Failed to start service. Check PM2 configuration.');
    }
  }, []);

  // Clean up poll on unmount
  useEffect(() => {
    return () => {
      if (healthPollRef.current) clearTimeout(healthPollRef.current);
    };
  }, []);

  const handleCancelStart = useCallback(() => {
    if (healthPollRef.current) clearTimeout(healthPollRef.current);
    setStartingApp(null);
    setStartError(null);
  }, []);

  // Filter apps
  const filteredApps = useMemo(() => {
    let result = [...apps].sort((a, b) => a.sortOrder - b.sortOrder);

    if (activeCategory !== 'all') {
      result = result.filter((app) => app.category === activeCategory);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (app) =>
          app.name.toLowerCase().includes(q) ||
          app.description.toLowerCase().includes(q) ||
          app.tags.some((t) => t.toLowerCase().includes(q))
      );
    }

    return result;
  }, [apps, activeCategory, searchQuery]);

  const handleEditApp = useCallback((app: AppRegistryEntry) => {
    setEditingApp(app);
    setShowRegistry(true);
  }, []);

  const handleCloseRegistry = useCallback(() => {
    setShowRegistry(false);
    setEditingApp(null);
  }, []);

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: apps.length };
    apps.forEach((app) => {
      counts[app.category] = (counts[app.category] || 0) + 1;
    });
    return counts;
  }, [apps]);

  // ============================================
  // Render
  // ============================================

  return (
    <div className="app-library">
      {/* Top bar: Search + Category Filters + Settings cog */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-4">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/25" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="glass-input pl-10 py-2.5 text-sm"
              placeholder="Search apps..."
              aria-label="Search applications"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/50 transition-colors cursor-pointer"
                aria-label="Clear search"
              >
                <span className="text-xs">ESC</span>
              </button>
            )}
          </div>

          {/* Settings gear */}
          <button
            onClick={() => {
              setEditingApp(null);
              setShowRegistry(true);
            }}
            className="flex items-center justify-center w-10 h-10 rounded-xl text-white/25 hover:text-white/50 bg-white/[0.02] border border-white/[0.06] hover:border-white/[0.12] hover:bg-white/[0.05] transition-all duration-200 cursor-pointer"
            title="Manage App Registry"
            aria-label="Open App Registry settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>

        {/* Category filter pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none" role="tablist" aria-label="Filter by category">
          {CATEGORY_FILTERS.map((cat) => {
            const count = categoryCounts[cat.value] || 0;
            const isActive = activeCategory === cat.value;
            return (
              <button
                key={cat.value}
                onClick={() => setActiveCategory(cat.value)}
                role="tab"
                aria-selected={isActive}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.78rem] font-medium whitespace-nowrap transition-all duration-200 cursor-pointer border ${
                  isActive
                    ? 'bg-blue-500/15 text-blue-400 border-blue-500/25 shadow-[0_0_10px_rgba(59,130,246,0.1)]'
                    : 'text-white/35 border-transparent hover:text-white/55 hover:bg-white/[0.04]'
                }`}
              >
                {cat.icon}
                {cat.label}
                {count > 0 && (
                  <span
                    className={`text-[0.6rem] px-1.5 py-0.5 rounded-full ${
                      isActive
                        ? 'bg-blue-500/20 text-blue-300'
                        : 'bg-white/[0.06] text-white/25'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content area */}
      {isLoading ? (
        <LoadingState />
      ) : filteredApps.length === 0 ? (
        apps.length === 0 ? (
          <EmptyState onAddApp={() => setShowRegistry(true)} />
        ) : (
          <NoResultsState query={searchQuery} category={activeCategory} />
        )
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredApps.map((app, index) => (
            <AppCard
              key={app.id}
              app={app}
              healthStatus={
                app.healthCheck ? (healthStatuses[app.id] ?? null) : undefined
              }
              onEdit={handleEditApp}
              onStartService={handleStartService}
              index={index}
            />
          ))}
        </div>
      )}

      {/* Service Starting Overlay */}
      {startingApp && (
        <ServiceStartOverlay
          app={startingApp}
          error={startError}
          onCancel={handleCancelStart}
        />
      )}

      {/* Registry Modal */}
      <AppRegistryModal
        isOpen={showRegistry}
        onClose={handleCloseRegistry}
        apps={apps}
        onAppsChange={fetchApps}
        editingApp={editingApp}
      />
    </div>
  );
}

// ============================================
// Service Start Overlay
// ============================================

function ServiceStartOverlay({
  app,
  error,
  onCancel,
}: {
  app: AppRegistryEntry;
  error: string | null;
  onCancel: () => void;
}) {
  const rgb = hexToRgb(app.color);
  const ResolvedIcon = app.iconType === 'lucide' ? resolveLucideIcon(app.icon) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[rgba(2,4,8,0.85)] backdrop-blur-md"
        style={{ animation: 'overlayFadeIn 0.3s ease-out' }}
      />

      {/* Content */}
      <div
        className="relative flex flex-col items-center gap-6 p-10 max-w-sm"
        style={{ animation: 'overlayScaleIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        {/* Animated glow ring around icon */}
        <div className="relative">
          {/* Outer pulsing ring */}
          <div
            className="absolute -inset-6 rounded-full"
            style={{
              background: `radial-gradient(circle, rgba(${rgb.r},${rgb.g},${rgb.b},0.15) 0%, transparent 70%)`,
              animation: error ? 'none' : 'startPulseGlow 2s ease-in-out infinite',
            }}
          />

          {/* Spinning orbit ring */}
          {!error && (
            <div
              className="absolute -inset-4 rounded-full"
              style={{
                border: `2px solid transparent`,
                borderTopColor: `rgba(${rgb.r},${rgb.g},${rgb.b},0.5)`,
                borderRightColor: `rgba(${rgb.r},${rgb.g},${rgb.b},0.2)`,
                animation: 'startOrbitSpin 1.2s linear infinite',
              }}
            />
          )}

          {/* Icon container */}
          <div
            className="relative w-20 h-20 rounded-2xl flex items-center justify-center"
            style={{
              background: `linear-gradient(135deg, rgba(${rgb.r},${rgb.g},${rgb.b},0.2) 0%, rgba(${rgb.r},${rgb.g},${rgb.b},0.08) 100%)`,
              border: `1px solid rgba(${rgb.r},${rgb.g},${rgb.b},0.3)`,
              boxShadow: `0 0 40px rgba(${rgb.r},${rgb.g},${rgb.b},0.15), inset 0 1px 0 rgba(255,255,255,0.05)`,
            }}
          >
            {app.iconType === 'emoji' ? (
              <span className="text-4xl leading-none select-none">{app.icon}</span>
            ) : ResolvedIcon ? (
              <ResolvedIcon className="w-10 h-10" style={{ color: app.color }} strokeWidth={1.5} />
            ) : (
              <span className="text-4xl leading-none select-none">{'\u{1F4E6}'}</span>
            )}
          </div>
        </div>

        {/* Text */}
        <div className="text-center">
          <h3 className="text-lg font-semibold text-white/90 mb-1.5">
            {error ? 'Failed to Start' : `Starting ${app.name}`}
          </h3>
          {error ? (
            <p className="text-sm text-red-400/80 leading-relaxed max-w-xs">{error}</p>
          ) : (
            <p className="text-sm text-white/35 leading-relaxed">
              Launching service and waiting for it to come online...
            </p>
          )}
        </div>

        {/* Progress dots or error action */}
        {!error ? (
          <div className="flex items-center gap-1.5">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="w-2 h-2 rounded-full"
                style={{
                  background: `rgba(${rgb.r},${rgb.g},${rgb.b},0.6)`,
                  animation: `startDotBounce 1.4s ease-in-out ${i * 0.16}s infinite`,
                }}
              />
            ))}
          </div>
        ) : null}

        {/* Cancel / Dismiss button */}
        <button
          onClick={onCancel}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-white/40 hover:text-white/70 bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.15] hover:bg-white/[0.08] transition-all duration-200 cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
          {error ? 'Dismiss' : 'Cancel'}
        </button>
      </div>

      <style jsx>{`
        @keyframes overlayFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes overlayScaleIn {
          from { opacity: 0; transform: scale(0.9); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes startPulseGlow {
          0%, 100% { transform: scale(1); opacity: 0.6; }
          50% { transform: scale(1.2); opacity: 1; }
        }
        @keyframes startOrbitSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes startDotBounce {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ============================================
// State Sub-components
// ============================================

function LoadingState() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="rounded-2xl border border-white/[0.04] bg-[rgba(8,16,32,0.4)] overflow-hidden"
          style={{ animationDelay: `${i * 80}ms` }}
        >
          <div className="p-5">
            {/* Icon skeleton */}
            <div className="flex items-start justify-between mb-4">
              <div className="w-12 h-12 rounded-xl skeleton" />
            </div>
            {/* Title skeleton */}
            <div className="w-3/4 h-4 rounded skeleton mb-2" />
            {/* Description skeleton */}
            <div className="w-full h-3 rounded skeleton mb-1.5" />
            <div className="w-2/3 h-3 rounded skeleton mb-4" />
            {/* Tags skeleton */}
            <div className="flex gap-1.5 mb-4">
              <div className="w-12 h-5 rounded skeleton" />
              <div className="w-16 h-5 rounded skeleton" />
            </div>
            {/* Actions skeleton */}
            <div className="flex gap-2 pt-3 border-t border-white/[0.03]">
              <div className="w-20 h-8 rounded-lg skeleton" />
              <div className="w-8 h-8 rounded-lg skeleton" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onAddApp }: { onAddApp: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-8">
      {/* Decorative orb cluster */}
      <div className="relative w-32 h-32 mb-8">
        {/* Central orb */}
        <div className="absolute inset-4 rounded-2xl bg-gradient-to-br from-blue-500/10 to-violet-500/10 border border-white/[0.06] flex items-center justify-center">
          <Layers className="w-10 h-10 text-white/10" />
        </div>
        {/* Floating accent dots */}
        <div
          className="absolute -top-1 right-2 w-3 h-3 rounded-full bg-blue-400/30"
          style={{ animation: 'emptyFloat 3s ease-in-out infinite' }}
        />
        <div
          className="absolute bottom-0 -left-1 w-2.5 h-2.5 rounded-full bg-violet-400/25"
          style={{ animation: 'emptyFloat 3.5s ease-in-out infinite 0.5s' }}
        />
        <div
          className="absolute top-3 -left-2 w-2 h-2 rounded-full bg-cyan-400/20"
          style={{ animation: 'emptyFloat 4s ease-in-out infinite 1s' }}
        />
        {/* Glow */}
        <div className="absolute inset-0 rounded-2xl blur-2xl bg-gradient-to-br from-blue-500/5 to-violet-500/5" />
      </div>

      <h3 className="text-lg font-semibold text-white/50 mb-2" style={{ textWrap: 'balance' }}>
        Your App Library is Empty
      </h3>
      <p className="text-sm text-white/25 text-center max-w-sm mb-6 leading-relaxed">
        Register your favorite tools, services, and applications for quick access.
        Each app gets its own card with status monitoring and one-click launch.
      </p>

      <button
        onClick={onAddApp}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 hover:border-blue-500/30 hover:shadow-[0_0_20px_rgba(59,130,246,0.1)] transition-all duration-300 cursor-pointer"
      >
        <Plus className="w-4 h-4" />
        Add Your First App
        <Sparkles className="w-3.5 h-3.5 text-blue-300/60" />
      </button>

      <style jsx>{`
        @keyframes emptyFloat {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }
      `}</style>
    </div>
  );
}

function NoResultsState({
  query,
  category,
}: {
  query: string;
  category: FilterCategory;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8">
      <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4">
        <Search className="w-6 h-6 text-white/12" />
      </div>
      <h3 className="text-base font-medium text-white/40 mb-1">No apps found</h3>
      <p className="text-sm text-white/20 text-center max-w-sm">
        {query
          ? <>No apps match &ldquo;{query}&rdquo;{category !== 'all' ? ` in ${category}` : ''}. Try a different search.</>
          : `No apps in the ${category} category yet.`}
      </p>
    </div>
  );
}
