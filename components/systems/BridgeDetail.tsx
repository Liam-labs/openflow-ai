'use client';

import { useEffect, useState, useCallback } from 'react';
import { MessageCircle, Settings, Phone, Clock, CheckCircle2, WifiOff, Wifi, AlertCircle } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type BridgeId = 'whatsapp' | 'slack' | 'teams';
type BridgeTab = 'status' | 'config';

interface BridgeStatus {
  status?: string;
  phone?: string;
  phoneName?: string;
  sessionExists?: boolean;
  reconnectAttempt?: number;
  connected?: boolean;
}

interface BridgeConfig {
  enabled: boolean;
  port?: number;
  allowedNumbers?: string[];
  commanderName?: string;
  channelName?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface BridgeData {
  config?: BridgeConfig;
  status?: BridgeStatus;
}

interface BridgeDetailProps {
  bridgeId: BridgeId | string;
}

const BRIDGE_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  teams: 'Microsoft Teams',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveStatus(data: BridgeData | null, bridge: string): string {
  if (!data || !data.config?.enabled) return 'not_configured';
  const s = bridge === 'whatsapp' ? data.status?.status : (data.status?.connected ? 'connected' : 'disconnected');
  if (s === 'connected') return 'connected';
  if (s === 'pairing' || s === 'connecting') return 'pairing';
  if (s === 'disconnected') return 'disconnected';
  return 'not_configured';
}

function StatusRow({ status }: { status: string }) {
  const config: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
    connected:      { icon: <CheckCircle2 size={16} />, label: 'Connected',      color: '#22c55e' },
    pairing:        { icon: <Wifi size={16} />,        label: 'Pairing',         color: '#3b82f6' },
    disconnected:   { icon: <WifiOff size={16} />,     label: 'Disconnected',    color: '#ef4444' },
    not_configured: { icon: <AlertCircle size={16} />, label: 'Not Configured',  color: '#71717a' },
    error:          { icon: <AlertCircle size={16} />, label: 'Error',           color: '#ef4444' },
  };
  const c = config[status] ?? config.not_configured;
  return (
    <div className="bridge-detail__status-row" style={{ color: c.color }}>
      {c.icon}
      <span className="bridge-detail__status-label">{c.label}</span>
    </div>
  );
}

// ─── Status Tab ───────────────────────────────────────────────────────────────

function StatusTab({ data, bridge, onRefresh }: { data: BridgeData | null; bridge: string; onRefresh: () => void }) {
  const status = deriveStatus(data, bridge);

  return (
    <div className="bridge-detail__content">
      <div className="bridge-detail__row bridge-detail__row--hero">
        <StatusRow status={status} />
        {data?.status?.phoneName && (
          <span className="bridge-detail__chip">
            <Phone size={11} /> {data.status.phoneName}
          </span>
        )}
        {data?.status?.phone && !data.status.phoneName && (
          <span className="bridge-detail__chip">
            <Phone size={11} /> {data.status.phone}
          </span>
        )}
      </div>

      {data?.status?.reconnectAttempt !== undefined && data.status.reconnectAttempt > 0 && (
        <div className="bridge-detail__section">
          <div className="bridge-detail__section-label">Reconnect Attempts</div>
          <div className="bridge-detail__section-value" style={{ color: '#eab308' }}>
            {data.status.reconnectAttempt}
          </div>
        </div>
      )}

      {bridge === 'whatsapp' && data?.status?.sessionExists !== undefined && (
        <div className="bridge-detail__section">
          <div className="bridge-detail__section-label">Session</div>
          <div className="bridge-detail__section-value">
            {data.status.sessionExists ? (
              <span style={{ color: '#22c55e' }}>Session file exists</span>
            ) : (
              <span style={{ color: '#ef4444' }}>No session — requires pairing</span>
            )}
          </div>
        </div>
      )}

      <div className="bridge-detail__actions">
        <button className="bridge-detail__action-btn bridge-detail__action-btn--secondary" onClick={onRefresh}>
          <Clock size={13} /> Refresh Status
        </button>
      </div>
    </div>
  );
}

// ─── Config Tab ───────────────────────────────────────────────────────────────

function ConfigTab({ data, bridge }: { data: BridgeData | null; bridge: string }) {
  const cfg = data?.config;
  if (!cfg) return <div className="bridge-detail__empty">No configuration found.</div>;

  const entries: { label: string; value: string }[] = [
    cfg.enabled !== undefined && { label: 'Enabled', value: cfg.enabled ? 'Yes' : 'No' },
    cfg.port !== undefined && { label: 'Port', value: String(cfg.port) },
    cfg.commanderName && { label: 'Commander Name', value: cfg.commanderName as string },
    cfg.channelName && { label: 'Channel Name', value: cfg.channelName as string },
    cfg.updatedAt && { label: 'Last Updated', value: new Date(cfg.updatedAt as string).toLocaleString() },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <div className="bridge-detail__content">
      <div className="bridge-detail__config-list">
        {entries.map(({ label, value }) => (
          <div key={label} className="bridge-detail__config-row">
            <div className="bridge-detail__config-label">{label}</div>
            <div className="bridge-detail__config-value">{value}</div>
          </div>
        ))}
      </div>

      {bridge === 'whatsapp' && cfg.allowedNumbers && (cfg.allowedNumbers as string[]).length > 0 && (
        <div className="bridge-detail__section">
          <div className="bridge-detail__section-label">Allowed Numbers</div>
          <div className="bridge-detail__tag-list">
            {(cfg.allowedNumbers as string[]).map((n: string) => (
              <span key={n} className="bridge-detail__chip">
                <Phone size={11} />{n}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="bridge-detail__config-note">
        <Settings size={12} />
        Configuration changes are made via the Bridges panel or CLI.
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BridgeDetail({ bridgeId }: BridgeDetailProps) {
  const [data, setData] = useState<BridgeData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<BridgeTab>('status');

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(`/api/bridges/${bridgeId}`);
      if (res.ok) {
        const json = await res.json() as BridgeData;
        setData(json);
      }
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [bridgeId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const label = BRIDGE_LABELS[bridgeId] ?? bridgeId;

  const TABS: { id: BridgeTab; label: string }[] = [
    { id: 'status', label: 'Status' },
    { id: 'config', label: 'Config' },
  ];

  if (isLoading) return <div className="systems-section__loading">Loading bridge…</div>;

  return (
    <div className="bridge-detail">
      {/* Header */}
      <div className="bridge-detail__header">
        <span className="bridge-detail__header-icon">
          <MessageCircle size={16} style={{ color: '#22c55e' }} />
        </span>
        <h2 className="bridge-detail__name">{label}</h2>
      </div>

      {/* Tabs */}
      <div className="bridge-detail__tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`bridge-detail__tab${activeTab === tab.id ? ' bridge-detail__tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'status' && <StatusTab data={data} bridge={bridgeId} onRefresh={fetch_} />}
      {activeTab === 'config' && <ConfigTab data={data} bridge={bridgeId} />}
    </div>
  );
}
