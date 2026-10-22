'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Wifi,
  WifiOff,
  RefreshCw,
  Settings,
  Phone,
  AlertTriangle,
  Loader2,
  X,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface BridgeStatus {
  status: 'connected' | 'connecting' | 'pairing' | 'disconnected';
  phone?: string;
  phoneName?: string;
  channelId?: string;
  commanderAlive?: boolean;
  sessionExists?: boolean;
  reconnectAttempt?: number;
}

interface WhatsAppBridgeConfig {
  type: 'baileys';
  enabled: boolean;
  port: number;
  allowedNumbers: string[];
  commanderName: string;
  channelName: string;
  updatedAt: string;
}

interface BridgeData {
  config?: WhatsAppBridgeConfig;
  status?: BridgeStatus;
}

interface WhatsAppStatusCardProps {
  onRepair: () => void;
  onConfigEdit: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatLastActive(ts: string | undefined): string {
  if (!ts) return 'Unknown';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  danger = false,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  danger?: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <div
        className="bg-[#0a1628] rounded-2xl border border-white/[0.08] p-6 max-w-sm w-full shadow-2xl"
        style={{ boxShadow: '0 24px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(59,130,246,0.1)' }}
      >
        <div className="flex items-start justify-between mb-4">
          <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertTriangle className="w-5 h-5 text-red-400" />
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/5 transition-all"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-white/70 leading-relaxed mb-6">{message}</p>
        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="glass-button flex-1 px-4 py-2.5 text-sm text-white/60 hover:text-white/80"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={[
              'flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all',
              danger
                ? 'bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30'
                : 'glass-button primary text-white',
            ].join(' ')}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Status Pill ─────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: BridgeStatus['status'] | 'unreachable' }) {
  const map = {
    connected: {
      dot: 'online',
      label: 'Connected',
      classes: 'bg-green-500/20 text-green-300 border-green-500/30',
    },
    connecting: {
      dot: 'warning',
      label: 'Connecting',
      classes: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    },
    pairing: {
      dot: 'warning',
      label: 'Pairing',
      classes: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    },
    disconnected: {
      dot: 'offline',
      label: 'Offline',
      classes: 'bg-red-500/20 text-red-300 border-red-500/30',
    },
    unreachable: {
      dot: 'warning',
      label: 'Unreachable',
      classes: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    },
  } as const;

  const s = map[status] ?? map.unreachable;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${s.classes}`}
    >
      <span className={`status-dot ${s.dot}`} style={{ width: 6, height: 6 }} />
      {s.label}
    </span>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <div
      className="glass-card p-5 w-full"
      style={{ cursor: 'default' }}
      onMouseEnter={(e) => (e.currentTarget.style.transform = 'none')}
    >
      {/* Top row */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="skeleton w-8 h-8 rounded-full" />
          <div className="skeleton w-24 h-4 rounded-md" />
          <div className="skeleton w-16 h-5 rounded-full" />
        </div>
        <div className="flex items-center gap-2">
          <div className="skeleton w-16 h-7 rounded-lg" />
          <div className="skeleton w-7 h-7 rounded-lg" />
        </div>
      </div>
      {/* Divider */}
      <div className="h-px bg-white/[0.06] mb-4" />
      {/* Details */}
      <div className="space-y-2 mb-4">
        <div className="skeleton w-44 h-3.5 rounded-md" />
        <div className="skeleton w-56 h-3.5 rounded-md" />
        <div className="skeleton w-32 h-3 rounded-md" />
      </div>
      {/* Footer */}
      <div className="h-px bg-white/[0.06] mb-4" />
      <div className="skeleton w-24 h-7 rounded-lg" />
    </div>
  );
}

// ─── Main Card ───────────────────────────────────────────────────────────────

export function WhatsAppStatusCard({ onRepair, onConfigEdit }: WhatsAppStatusCardProps) {
  const [data, setData] = useState<BridgeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bridges/whatsapp/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: BridgeStatus = await res.json();
      setData((prev) => ({
        config: prev?.config,
        status: json,
      }));
      setFetchError(false);
      setLastFetched(new Date());
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial full fetch (config + status)
  useEffect(() => {
    const init = async () => {
      try {
        const res = await fetch('/api/bridges/whatsapp', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: BridgeData = await res.json();
        setData(json);
        setFetchError(false);
        setLastFetched(new Date());
      } catch {
        // Fall back to status-only
        await fetchStatus();
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [fetchStatus]);

  // Poll every 15s
  useEffect(() => {
    pollRef.current = setInterval(fetchStatus, 15000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatus]);

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await fetch('/api/bridges/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', enabled: false }),
      });
      await new Promise((r) => setTimeout(r, 1000));
      await fetch('/api/bridges/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', enabled: true }),
      });
      await fetchStatus();
    } catch {
      // ignore — status will update on next poll
    } finally {
      setRestarting(false);
    }
  };

  const handleDisconnect = async () => {
    setShowConfirm(false);
    setDisconnecting(true);
    try {
      await fetch('/api/bridges/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }),
      });
      onRepair();
    } catch {
      // ignore
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) return <CardSkeleton />;

  const status = data?.status;
  const config = data?.config;
  const bridgeStatus: BridgeStatus['status'] | 'unreachable' = fetchError
    ? 'unreachable'
    : status?.status ?? 'disconnected';

  const isConnected = bridgeStatus === 'connected';
  const isPairing = bridgeStatus === 'pairing' || bridgeStatus === 'connecting';
  const isOffline = bridgeStatus === 'disconnected';
  const isUnreachable = bridgeStatus === 'unreachable';

  return (
    <>
      {showConfirm && (
        <ConfirmDialog
          message="This will remove the linked device and require re-pairing. Your WhatsApp session will be disconnected. Continue?"
          confirmLabel="Disconnect"
          danger
          onConfirm={handleDisconnect}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      <div className="glass-card p-5 w-full" style={{ cursor: 'default' }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = 'none'; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = ''; }}
      >
        {/* Top row: icon + title + pill + actions */}
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            {/* WhatsApp icon */}
            <div
              className={[
                'p-2 rounded-xl flex-shrink-0 transition-all duration-300',
                isConnected
                  ? 'bg-green-500/10 border border-green-500/20'
                  : isPairing
                  ? 'bg-amber-500/10 border border-amber-500/20'
                  : 'bg-white/[0.05] border border-white/[0.08]',
              ].join(' ')}
            >
              <svg
                className={[
                  'w-5 h-5',
                  isConnected ? 'text-green-400' : isPairing ? 'text-amber-400' : 'text-white/40',
                ].join(' ')}
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
              </svg>
            </div>

            <div className="min-w-0 flex items-center gap-2.5 flex-wrap">
              <span className="text-sm font-semibold text-white/90 whitespace-nowrap">WhatsApp</span>
              <StatusPill status={bridgeStatus} />
              {fetchError && lastFetched && (
                <span className="text-[10px] text-amber-400/60 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  stale
                </span>
              )}
            </div>
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Restart button */}
            <button
              onClick={handleRestart}
              disabled={restarting}
              title="Restart bridge"
              className={[
                'glass-button flex items-center gap-1.5 px-3 py-1.5 text-xs transition-all',
                isOffline || isUnreachable ? 'primary text-white' : 'text-white/60 hover:text-white/80',
              ].join(' ')}
            >
              {restarting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              {restarting ? 'Restarting…' : 'Restart'}
            </button>

            {/* Settings icon */}
            <button
              onClick={onConfigEdit}
              title="Edit configuration"
              className="glass-button p-2 text-white/50 hover:text-white/80"
              aria-label="Edit configuration"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-white/[0.06] mb-4" />

        {/* Status body */}
        {isConnected && (
          <div className="space-y-1.5 mb-4">
            {(status?.phone || status?.phoneName) && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
                <span className="text-white/80 font-medium">
                  {[status?.phone, status?.phoneName].filter(Boolean).join(' · ')}
                </span>
              </div>
            )}
            {config && (
              <div className="flex items-center gap-2 text-xs text-white/45">
                <Wifi className="w-3.5 h-3.5 flex-shrink-0" />
                <span>
                  Commander: <span className="text-white/60">{config.commanderName}</span>
                  {config.channelName && (
                    <>
                      {' '}·{' '}Channel: <span className="text-white/60">{config.channelName}</span>
                    </>
                  )}
                </span>
              </div>
            )}
            <p className="text-xs text-white/30">
              Last active: {formatLastActive(config?.updatedAt)}
            </p>
          </div>
        )}

        {isPairing && (
          <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 mb-4">
            <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs text-amber-300 font-medium mb-1">Scan QR to connect</p>
              <button
                onClick={onRepair}
                className="text-xs text-[#60a5fa] hover:text-white underline underline-offset-2 transition-colors"
              >
                Open pairing wizard →
              </button>
            </div>
          </div>
        )}

        {(isOffline || isUnreachable) && (
          <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-red-500/10 border border-red-500/20 mb-4">
            <WifiOff className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs text-red-300 font-medium">
                {isUnreachable ? 'Bridge unreachable' : 'Bridge offline'}
              </p>
              <p className="text-xs text-red-400/60 mt-0.5">
                {isUnreachable
                  ? 'Could not contact the bridge service. Check that it is running.'
                  : 'Your phone may be offline or the linked device was removed.'}
              </p>
            </div>
          </div>
        )}

        {/* Divider */}
        <div className="h-px bg-white/[0.06] mb-4" />

        {/* Bottom actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowConfirm(true)}
            disabled={disconnecting}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-red-500/30
              text-red-400 hover:bg-red-500/10 text-xs font-medium transition-all disabled:opacity-50"
          >
            {disconnecting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <X className="w-3.5 h-3.5" />
            )}
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>

          {lastFetched && (
            <span className="text-[10px] text-white/20 ml-auto">
              Updated {formatLastActive(lastFetched.toISOString())}
            </span>
          )}
        </div>
      </div>
    </>
  );
}
