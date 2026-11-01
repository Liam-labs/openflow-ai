'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { MessageCircle, ChevronRight } from 'lucide-react';
import type { SystemsNavState } from './systems-types';

// ─── Types ─────────────────────────────────────────────────────────────────────

type BridgeStatus = 'connected' | 'pairing' | 'disconnected' | 'not_configured' | 'error';

interface BridgeState {
  id: 'whatsapp' | 'slack' | 'teams';
  label: string;
  status: BridgeStatus;
  detail?: string;
  enabled: boolean;
}

const STATUS_DOT: Record<BridgeStatus, string> = {
  connected:      '#22c55e',
  pairing:        '#3b82f6',
  disconnected:   '#ef4444',
  not_configured: '#71717a',
  error:          '#ef4444',
};

const STATUS_LABEL: Record<BridgeStatus, string> = {
  connected:      'Connected',
  pairing:        'Pairing',
  disconnected:   'Disconnected',
  not_configured: 'Not set up',
  error:          'Error',
};

// ─── Bridge icon (inline SVG) ──────────────────────────────────────────────────

function BridgeIcon({ id }: { id: string }) {
  if (id === 'slack') return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" />
    </svg>
  );
  if (id === 'teams') return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M20.625 6h-2.156a2.706 2.706 0 0 0 .531-1.594A2.72 2.72 0 0 0 16.313 1.72 2.72 2.72 0 0 0 13.625 4.406c0 .586.195 1.125.516 1.594H12a1.5 1.5 0 0 0-1.5 1.5v5.25a1.5 1.5 0 0 0 1.5 1.5h3.75v5.25A2.25 2.25 0 0 1 13.5 21.75h-3A2.25 2.25 0 0 1 8.25 19.5V14.25H4.5a1.5 1.5 0 0 1-1.5-1.5V7.5A1.5 1.5 0 0 1 4.5 6z" />
    </svg>
  );
  return <MessageCircle size={14} style={{ flexShrink: 0 }} />;
}

// ─── Row ───────────────────────────────────────────────────────────────────────

function BridgeRow({
  bridge,
  onNavigate,
}: {
  bridge: BridgeState;
  onNavigate?: (state: Partial<SystemsNavState>) => void;
}) {
  const dotColor = STATUS_DOT[bridge.status];
  const statusLabel = STATUS_LABEL[bridge.status];

  return (
    <button
      className={`bsw-row${onNavigate ? ' bsw-row--clickable' : ''}`}
      onClick={onNavigate ? () => onNavigate({ section: 'bridges', entityId: bridge.id, entityType: 'bridge' }) : undefined}
      disabled={!onNavigate}
    >
      <span className="bsw-row__icon" style={{ color: dotColor }}>
        <BridgeIcon id={bridge.id} />
      </span>
      <span className="bsw-row__name">{bridge.label}</span>
      {bridge.detail && (
        <span className="bsw-row__detail">{bridge.detail}</span>
      )}
      <span className="bsw-row__status">
        <span className="bsw-row__dot" style={{ background: dotColor }} />
        <span className="bsw-row__status-text" style={{ color: dotColor }}>{statusLabel}</span>
      </span>
      {onNavigate && <ChevronRight size={11} className="bsw-row__arrow" />}
    </button>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────

interface BridgesStatusWidgetProps {
  onNavigate?: (state: Partial<SystemsNavState>) => void;
}

export function BridgesStatusWidget({ onNavigate }: BridgesStatusWidgetProps) {
  const [bridges, setBridges] = useState<BridgeState[]>([]);

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
          if (s === 'connected') { status = 'connected'; detail = data.status?.phoneName || data.status?.phone; }
          else if (s === 'pairing' || s === 'connecting') { status = 'pairing'; }
          else { status = 'disconnected'; }
        }
        results.push({ id: 'whatsapp', label: 'WhatsApp', status, detail, enabled: cfg?.enabled ?? false });
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
        const status: BridgeStatus = data.configured ? (data.connected ? 'connected' : 'disconnected') : 'not_configured';
        results.push({ id: 'slack', label: 'Slack', status, enabled: data.configured ?? false });
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
        const status: BridgeStatus = data.configured ? (data.connected ? 'connected' : 'disconnected') : 'not_configured';
        results.push({ id: 'teams', label: 'Microsoft Teams', status, enabled: data.configured ?? false });
      } else {
        results.push({ id: 'teams', label: 'Microsoft Teams', status: 'not_configured', enabled: false });
      }
    } catch {
      results.push({ id: 'teams', label: 'Microsoft Teams', status: 'not_configured', enabled: false });
    }

    setBridges(results);
  }, []);

  useEffect(() => {
    // The callback updates state after the bridge HTTP requests complete.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchAll();
    const id = setInterval(fetchAll, 30_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  if (bridges.length === 0) return null;

  const connectedCount = bridges.filter((b) => b.status === 'connected').length;

  return (
    <div className="sov-panel">
      <div className="sov-panel__header">
        <span className="sov-panel__title">
          <MessageCircle size={14} />
          Comms
        </span>
        <span className="bsw-count">
          <span
            className="bsw-count__dot"
            style={{ background: connectedCount > 0 ? '#22c55e' : '#71717a' }}
          />
          {connectedCount}/{bridges.length}
        </span>
      </div>
      <div className="sov-panel__body bsw-body">
        {bridges.map((b) => (
          <BridgeRow key={b.id} bridge={b} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}
