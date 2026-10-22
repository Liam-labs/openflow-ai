'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  ExternalLink,
  Settings,
  Folder,
  WifiOff,
  AlertCircle,
  type LucideIcon,
} from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { AppRegistryEntry } from '@/lib/types';

interface AppCardProps {
  app: AppRegistryEntry;
  healthStatus?: 'online' | 'offline' | null;
  onEdit?: (app: AppRegistryEntry) => void;
  onStartService?: (app: AppRegistryEntry) => void;
  index?: number;
}

/**
 * Resolve a Lucide icon by name. Returns the icon component or null.
 * Handles kebab-case names like "hard-drive" -> "HardDrive"
 */
function resolveLucideIcon(name: string): LucideIcon | null {
  // Convert kebab-case to PascalCase
  const pascalName = name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  const icons = LucideIcons as unknown as Record<string, LucideIcon>;
  return icons[pascalName] || null;
}

/**
 * Convert hex color to RGB values
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 59, g: 130, b: 246 }; // fallback to blue
}

/** Lighten an RGB triplet toward white by `amt` (0-1). Used for text that must stay ≥4.5:1 on a dark card. */
function lightenRgb(rgb: { r: number; g: number; b: number }, amt: number) {
  const l = (c: number) => Math.min(255, Math.round(c + (255 - c) * amt));
  return { r: l(rgb.r), g: l(rgb.g), b: l(rgb.b) };
}

/** Darken an RGB triplet toward black by `amt` (0-1). Used for solid-fill surfaces that carry white text. */
function darkenRgb(rgb: { r: number; g: number; b: number }, amt: number) {
  const d = (c: number) => Math.round(c * (1 - amt));
  return { r: d(rgb.r), g: d(rgb.g), b: d(rgb.b) };
}

const CATEGORY_LABELS: Record<string, string> = {
  development: 'Dev',
  ai: 'AI',
  media: 'Media',
  automation: 'Auto',
  monitoring: 'Monitor',
  utility: 'Util',
  other: 'Other',
};

export function AppCard({ app, healthStatus, onEdit, onStartService, index = 0 }: AppCardProps) {
  const [isHovered, setIsHovered] = useState(false);

  // Detect if we are accessing via remote tunnel
  const isRemote = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const host = window.location.hostname;
    // A public domain name (not an IP address, not a tailnet or LAN name) means the tunnel.
    const isPublicDomain = host.includes('.') && !/^[\d.]+$/.test(host) && !/\.(ts\.net|local|lan|internal)$/.test(host);
    return isPublicDomain || host.includes('tunnel');
  }, []);

  // Resolve the best launch URL — prefer tunnel URL when remote
  const launchUrl = useMemo(() => {
    if (isRemote && app.tunnelUrl) return app.tunnelUrl;
    return app.url;
  }, [isRemote, app.tunnelUrl, app.url]);

  // Check if the app is unreachable remotely (localhost URL with no tunnel)
  const isUnreachable = useMemo(() => {
    return isRemote && !!app.url && app.url.includes('localhost') && !app.tunnelUrl;
  }, [isRemote, app.url, app.tunnelUrl]);

  const rgb = useMemo(() => hexToRgb(app.color), [app.color]);
  // Verified against WCAG AA (4.5:1) for all 8 registered app accents — see
  // component notes. Badge text needs lightening (raw indigo #6366F1 was
  // only 3.79:1 on the tinted card bg); the Launch button needs darkening
  // (raw/lightened accents ran 2.0-4.5:1 for white text — too bright to
  // hold white text at normal size).
  const badgeTextRgb = useMemo(() => lightenRgb(rgb, 0.2), [rgb]);
  const emblemLight = useMemo(() => lightenRgb(rgb, 0.18), [rgb]);
  const emblemDark = useMemo(() => darkenRgb(rgb, 0.3), [rgb]);
  const launchLight = useMemo(() => darkenRgb(rgb, 0.35), [rgb]);
  const launchDark = useMemo(() => darkenRgb(rgb, 0.58), [rgb]);
  const LucideIcon = useMemo(
    () => (app.iconType === 'lucide' ? resolveLucideIcon(app.icon) : null),
    [app.icon, app.iconType]
  );

  const isOffline = healthStatus === 'offline';
  const canStart = isOffline && app.pm2Name;

  const handleLaunch = useCallback(() => {
    if (!launchUrl) return;

    // If offline and has a PM2 process, start service first
    if (canStart && onStartService) {
      onStartService(app);
      return;
    }

    window.open(launchUrl, '_blank', 'noopener,noreferrer');
  }, [app, launchUrl, canStart, onStartService]);

  const handleEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onEdit?.(app);
    },
    [app, onEdit]
  );

  const animDelay = `${index * 60}ms`;

  return (
    <article
      className="app-card group relative"
      style={
        {
          '--card-accent-r': rgb.r,
          '--card-accent-g': rgb.g,
          '--card-accent-b': rgb.b,
          '--card-accent': app.color,
          animationDelay: animDelay,
        } as React.CSSProperties
      }
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleLaunch}
      role={app.url ? 'link' : undefined}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleLaunch();
        }
      }}
      aria-label={`${app.name}${app.url ? ' - Click to open' : ''}`}
    >
      {/* Ambient glow behind the card on hover */}
      <div
        className="absolute -inset-1 rounded-[20px] opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none blur-xl"
        style={{
          background: `radial-gradient(ellipse at 30% 20%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22) 0%, transparent 70%)`,
        }}
      />

      {/* Card surface — colour-tinted glass, not flat navy */}
      <div
        className="relative rounded-2xl overflow-hidden"
        style={{
          // Base stops match --df-surface-ch (10,20,40) and --df-bg (#050508) exactly,
          // so the glass tint composites consistently with the rest of the token system.
          background: `linear-gradient(155deg, rgba(${rgb.r},${rgb.g},${rgb.b},${isHovered ? 0.2 : 0.13}) 0%, rgba(10,20,40,0.9) 45%, rgba(5,5,8,0.94) 100%)`,
          backdropFilter: 'blur(20px) saturate(160%)',
          WebkitBackdropFilter: 'blur(20px) saturate(160%)',
          border: `1px solid rgba(${rgb.r},${rgb.g},${rgb.b},${isHovered ? 0.45 : 0.28})`,
          boxShadow: isHovered
            ? `0 20px 50px rgba(0,0,0,0.55), 0 0 40px rgba(${rgb.r},${rgb.g},${rgb.b},0.18), inset 0 1px 0 rgba(255,255,255,0.06)`
            : `0 8px 28px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.035)`,
        }}
      >
        {/* Top gradient accent line */}
        <div
          className="absolute top-0 left-0 right-0 h-[1px]"
          style={{
            background: `linear-gradient(90deg, transparent 10%, rgba(${rgb.r},${rgb.g},${rgb.b},0.6) 50%, transparent 90%)`,
          }}
        />

        {/* Shine sweep — a diagonal light band that crosses the glass on hover */}
        <div className="app-card-shine" aria-hidden="true" />

        <div className="p-5">
          {/* Header row: Icon */}
          <div className="flex items-start justify-between mb-4">
            {/* Icon emblem: solid saturated badge with a glass bevel, not a faint tinted box */}
            <div className="relative">
              {/* Glow layer behind emblem */}
              <div
                className="absolute inset-0 rounded-2xl blur-lg transition-all duration-500"
                style={{
                  background: `radial-gradient(circle, rgba(${rgb.r},${rgb.g},${rgb.b},${isHovered ? 0.5 : 0.3}) 0%, transparent 70%)`,
                  transform: `scale(${isHovered ? 1.7 : 1.35})`,
                }}
              />

              {/* Emblem container */}
              <div
                className="relative w-14 h-14 rounded-2xl flex items-center justify-center transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-105 group-hover:-rotate-3"
                style={{
                  background: `linear-gradient(145deg, rgb(${emblemLight.r},${emblemLight.g},${emblemLight.b}) 0%, rgb(${emblemDark.r},${emblemDark.g},${emblemDark.b}) 100%)`,
                  boxShadow: `inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -10px 14px rgba(0,0,0,0.18), 0 8px 18px rgba(${rgb.r},${rgb.g},${rgb.b},0.4)`,
                }}
              >
                {app.iconType === 'emoji' ? (
                  <span className="text-2xl leading-none select-none" role="img">
                    {app.icon}
                  </span>
                ) : LucideIcon ? (
                  <LucideIcon
                    className="w-7 h-7 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]"
                    strokeWidth={1.9}
                  />
                ) : (
                  <span className="text-2xl leading-none select-none" role="img">
                    {'\u{1F4E6}'}
                  </span>
                )}
              </div>
            </div>
            {isRemote && app.tunnelUrl && (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold uppercase tracking-wider">
                <ExternalLink className="w-3 h-3" />
                WebGate
              </div>
            )}
            {isUnreachable && (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-bold uppercase tracking-wider animate-pulse">
                <WifiOff className="w-3 h-3" />
                Local Only
              </div>
            )}

          </div>

          {/* Name + Description */}
          <div className="mb-3">
            <h3 className="text-[0.95rem] font-semibold text-white mb-1 truncate">
              {app.name}
            </h3>
            <p className="text-[0.8rem] leading-relaxed text-white/[0.64] line-clamp-2 group-hover:text-white/[0.78] transition-colors duration-200">
              {app.description || 'No description'}
            </p>
          </div>

          {/* Category badge + Tags */}
          <div className="flex items-center flex-wrap gap-1.5 mb-4">
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[0.65rem] font-semibold uppercase tracking-wider"
              style={{
                background: `rgba(${rgb.r},${rgb.g},${rgb.b},0.18)`,
                color: `rgb(${badgeTextRgb.r},${badgeTextRgb.g},${badgeTextRgb.b})`,
                border: `1px solid rgba(${rgb.r},${rgb.g},${rgb.b},0.32)`,
              }}
            >
              {CATEGORY_LABELS[app.category] || app.category}
            </span>
            {app.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 rounded text-[0.65rem] text-white/[0.62] bg-white/[0.07] border border-white/[0.14] transition-colors duration-200 group-hover:text-white/[0.75] group-hover:border-white/[0.2]"
              >
                {tag}
              </span>
            ))}
            {app.tags.length > 3 && (
              <span className="text-[0.6rem] text-white/40">
                +{app.tags.length - 3}
              </span>
            )}
          </div>

          {/* Action buttons row */}
          <div className="flex items-center gap-2 pt-3 border-t border-white/[0.05]">
            {app.url && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleLaunch();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] font-semibold text-white transition-all duration-200 cursor-pointer"
                style={{
                  background: `linear-gradient(135deg, rgb(${launchLight.r},${launchLight.g},${launchLight.b}) 0%, rgb(${launchDark.r},${launchDark.g},${launchDark.b}) 100%)`,
                  boxShadow: `0 4px 14px rgba(${rgb.r},${rgb.g},${rgb.b},0.35), inset 0 1px 0 rgba(255,255,255,0.22)`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.boxShadow = `0 6px 22px rgba(${rgb.r},${rgb.g},${rgb.b},0.55), inset 0 1px 0 rgba(255,255,255,0.32)`;
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.boxShadow = `0 4px 14px rgba(${rgb.r},${rgb.g},${rgb.b},0.35), inset 0 1px 0 rgba(255,255,255,0.22)`;
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
                title={isUnreachable ? "This service is local-only and cannot be reached via tunnel" : canStart ? `Start ${app.name} and open` : isRemote && app.tunnelUrl ? `Open via WebGate: ${app.tunnelUrl}` : "Open in browser"}
                aria-label={canStart ? `Start and launch ${app.name}` : `Launch ${app.name}`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                {isUnreachable ? "Unreachable" : canStart ? "Start" : "Launch"}
              </button>
            )}

            {app.path && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // Could integrate with folder open API
                }}
                className="flex items-center justify-center w-8 h-8 rounded-lg text-white/30 bg-white/[0.03] border border-white/[0.06] hover:text-white/60 hover:bg-white/[0.07] hover:border-white/[0.12] transition-all duration-200 cursor-pointer"
                title={`Open folder: ${app.path}`}
                aria-label={`Open ${app.name} folder`}
              >
                <Folder className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Settings button - always show, pushed to right */}
            <button
              onClick={handleEdit}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-white/20 bg-white/[0.02] border border-white/[0.04] hover:text-white/50 hover:bg-white/[0.06] hover:border-white/[0.1] transition-all duration-200 ml-auto opacity-0 group-hover:opacity-100 cursor-pointer"
              title="Edit app"
              aria-label={`Edit ${app.name}`}
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
