'use client';

import { useEffect, useState, useCallback } from 'react';
import { MessageCircle, RefreshCw, Settings, CheckCircle2, AlertCircle, WifiOff, Wifi } from 'lucide-react';
import type { SystemsNavState } from './systems-types';

// ─── Types ────────────────────────────────────────────────────────────────────

type BridgeStatus = 'connected' | 'pairing' | 'disconnected' | 'not_configured' | 'error';

interface BridgeState {
  id: 'whatsapp' | 'slack' | 'teams';
  label: string;
  status: BridgeStatus;
  detail?: string;
  enabled: boolean;
  lastChecked?: string;
}

interface BridgesSectionProps {
  onNavigate?: (state: Partial<SystemsNavState>) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<BridgeStatus, { label: string; color: string; bg: string; border: string; icon: React.ReactNode }> = {
  connected:      { label: 'Connected',      color: '#22c55e', bg: 'rgba(34,197,94,0.10)',   border: 'rgba(34,197,94,0.25)',   icon: <CheckCircle2 size={14} /> },
  pairing:        { label: 'Pairing',         color: '#3b82f6', bg: 'rgba(59,130,246,0.10)',  border: 'rgba(59,130,246,0.25)',  icon: <Wifi size={14} /> },
  disconnected:   { label: 'Disconnected',    color: '#ef4444', bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.25)',   icon: <WifiOff size={14} /> },
  not_configured: { label: 'Not Configured',  color: '#71717a', bg: 'rgba(113,113,122,0.10)', border: 'rgba(113,113,122,0.25)', icon: <AlertCircle size={14} /> },
  error:          { label: 'Error',           color: '#ef4444', bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.25)',   icon: <AlertCircle size={14} /> },
};

// ─── Bridge card ──────────────────────────────────────────────────────────────

function BridgeIcon({ id }: { id: string }) {
  if (id === 'slack') return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
  if (id === 'teams') return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.625 6h-2.156a2.706 2.706 0 0 0 .531-1.594A2.72 2.72 0 0 0 16.313 1.72 2.72 2.72 0 0 0 13.625 4.406c0 .586.195 1.125.516 1.594H12a1.5 1.5 0 0 0-1.5 1.5v5.25a1.5 1.5 0 0 0 1.5 1.5h3.75v5.25A2.25 2.25 0 0 1 13.5 21.75h-3A2.25 2.25 0 0 1 8.25 19.5V14.25H4.5a1.5 1.5 0 0 1-1.5-1.5V7.5A1.5 1.5 0 0 1 4.5 6h2.156A2.706 2.706 0 0 1 6.125 4.406 2.72 2.72 0 0 1 8.813 1.72a2.72 2.72 0 0 1 2.687 2.686c0 .586-.195 1.125-.516 1.594H12a1.5 1.5 0 0 1 1.5 1.5v5.25a1.5 1.5 0 0 1-1.5 1.5H8.25v5.25A2.25 2.25 0 0 0 10.5 21.75h3a2.25 2.25 0 0 0 2.25-2.25V14.25h4.875a1.5 1.5 0 0 0 1.5-1.5V7.5a1.5 1.5 0 0 0-1.5-1.5z" />
    </svg>
  );
  return <MessageCircle size={18} />;
}

function BridgeCard({ bridge, onConfigure, onNavigate }: {
  bridge: BridgeState;
  onConfigure: (id: string) => void;
  onNavigate?: (state: Partial<SystemsNavState>) => void;
}) {
  const cfg = STATUS_CONFIG[bridge.status];
  return (
    <div
      className="bridge-card"
      style={{ '--bridge-color': cfg.color, '--bridge-bg': cfg.bg, '--bridge-border': cfg.border } as React.CSSProperties}
      onClick={onNavigate ? () => onNavigate({ section: 'bridges', entityId: bridge.id, entityType: 'bridge' }) : undefined}
      role={onNavigate ? 'button' : undefined}
      tabIndex={onNavigate ? 0 : undefined}
      onKeyDown={onNavigate ? (e) => { if (e.key === 'Enter') onNavigate({ section: 'bridges', entityId: bridge.id, entityType: 'bridge' }); } : undefined}
    >
      {/* Icon + label */}
      <div className="bridge-card__header">
        <span className="bridge-card__icon" style={{ color: cfg.color }}>
          <BridgeIcon id={bridge.id} />
        </span>
        <div>
          <div className="bridge-card__name">{bridge.label}</div>
          {bridge.detail && <div className="bridge-card__detail">{bridge.detail}</div>}
        </div>
      </div>

      {/* Status badge */}
      <div className="bridge-card__status">
        <span className="bridge-card__status-icon" style={{ color: cfg.color }}>{cfg.icon}</span>
        <span className="bridge-card__status-label" style={{ color: cfg.color }}>{cfg.label}</span>
      </div>

      {/* Actions */}
      <div className="bridge-card__actions">
        <button
          className="bridge-card__btn bridge-card__btn--config"
          onClick={(e) => { e.stopPropagation(); onConfigure(bridge.id); }}
          title="Configure"
        >
          <Settings size={13} />
          Configure
        </button>
        {onNavigate && (
          <button
            className="bridge-card__btn bridge-card__btn--detail"
            onClick={(e) => { e.stopPropagation(); onNavigate({ section: 'bridges', entityId: bridge.id, entityType: 'bridge' }); }}
          >
            Details →
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BridgesSection({ onNavigate }: BridgesSectionProps) {
  const [bridges, setBridges] = useState<BridgeState[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    const results: BridgeState[] = [];

    // WhatsApp
    try {
      const res = await fetch('/api/bridges/whatsapp');
      if (res.ok) {
        const data = await res.json();
        const cfg = data.config;
        const s = data.status?.status;
        let status: BridgeStatus = 'not_configured';
        let detail: string | undefined;
        if (cfg?.enabled) {
          if (s === 'connected') {
            status = 'connected';
            detail = data.status?.phoneName || data.status?.phone;
          } else if (s === 'pairing' || s === 'connecting') {
            status = 'pairing';
          } else if (s === 'disconnected') {
            status = 'disconnected';
          }
        }
        results.push({ id: 'whatsapp', label: 'WhatsApp', status, detail, enabled: cfg?.enabled ?? false, lastChecked: new Date().toISOString() });
      } else {
        results.push({ id: 'whatsapp', label: 'WhatsApp', status: 'not_configured', enabled: false });
      }
    } catch {
      results.push({ id: 'whatsapp', label: 'WhatsApp', status: 'error', enabled: false });
    }

    // Slack
    try {
      const res = await fetch('/api/bridges/slack/status');
      if (res.ok) {
        const data = await res.json();
        const configured = data.configured ?? data.config?.enabled ?? false;
        const connected = data.connected ?? data.status?.connected ?? false;
        const status: BridgeStatus = configured ? (connected ? 'connected' : 'disconnected') : 'not_configured';
        results.push({ id: 'slack', label: 'Slack', status, enabled: configured, lastChecked: new Date().toISOString() });
      } else {
        results.push({ id: 'slack', label: 'Slack', status: 'not_configured', enabled: false });
      }
    } catch {
      results.push({ id: 'slack', label: 'Slack', status: 'not_configured', enabled: false });
    }

    // Teams
    try {
      const res = await fetch('/api/bridges/teams/status');
      if (res.ok) {
        const data = await res.json();
        const configured = data.configured ?? data.config?.enabled ?? false;
        const connected = data.connected ?? data.status?.connected ?? false;
        const status: BridgeStatus = configured ? (connected ? 'connected' : 'disconnected') : 'not_configured';
        results.push({ id: 'teams', label: 'Microsoft Teams', status, enabled: configured, lastChecked: new Date().toISOString() });
      } else {
        results.push({ id: 'teams', label: 'Microsoft Teams', status: 'not_configured', enabled: false });
      }
    } catch {
      results.push({ id: 'teams', label: 'Microsoft Teams', status: 'not_configured', enabled: false });
    }

    setBridges(results);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 20_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const connectedCount = bridges.filter(b => b.status === 'connected').length;
  const configuredCount = bridges.filter(b => b.enabled).length;

  const handleConfigure = (id: string) => {
    if (onNavigate) {
      onNavigate({ section: 'bridges', entityId: id, entityType: 'bridge', tab: 'config' });
    }
  };

  if (isLoading) return <div className="systems-section__loading">Loading bridges…</div>;

  return (
    <div className="systems-section">
      {/* Header with inline stat pills */}
      <div className="systems-section__header">
        <div className="systems-section__header-left">
          <MessageCircle size={16} style={{ color: '#22c55e', flexShrink: 0 }} />
          <h2 className="systems-section__title">Communication Bridges</h2>
          <span className="systems-stat-pill systems-stat-pill--success">
            <span className="systems-stat-pill__value">{connectedCount}</span> connected
          </span>
          <span className="systems-stat-pill systems-stat-pill--info">
            <span className="systems-stat-pill__value">{configuredCount}</span> configured
          </span>
          <span className="systems-stat-pill systems-stat-pill--muted">
            <span className="systems-stat-pill__value">{bridges.length}</span> total
          </span>
        </div>
        <button className="systems-filter-bar__action" onClick={fetchAll} title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Bridge cards grid */}
      <p className="systems-section__desc">WhatsApp, Slack, and Teams message bridges. Route conversations between external platforms and your services.</p>
      <div className="bridges-grid">
        {bridges.map(bridge => (
          <BridgeCard
            key={bridge.id}
            bridge={bridge}
            onConfigure={handleConfigure}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}
