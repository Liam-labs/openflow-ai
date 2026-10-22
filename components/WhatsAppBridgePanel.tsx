'use client';

import { useState, useEffect, useRef } from 'react';
import {
  MessageCircle,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
} from 'lucide-react';

export interface WhatsAppStatus {
  status: 'connected' | 'connecting' | 'pairing' | 'disconnected';
  phone?: string;
  phoneName?: string;
  sessionExists?: boolean;
  reconnectAttempt?: number;
}

export interface WhatsAppBridgeConfig {
  type: 'baileys';
  enabled: boolean;
  port: number;
  allowedNumbers: string[];
  commanderName: string;
  channelName: string;
  updatedAt: string;
}

export interface WhatsAppBridgeData {
  config?: WhatsAppBridgeConfig;
  status?: WhatsAppStatus;
}

interface WhatsAppBridgePanelProps {
  onSetup: () => void;
  onShowQR: () => void;
  onPairCode: () => void;
  onDisconnect: () => void;
  onRestart: () => void;
}

type ViewState = 'loading' | 'not_configured' | 'pairing' | 'connected' | 'disconnected' | 'error';

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

export function WhatsAppBridgePanel({
  onSetup,
  onShowQR,
  onPairCode,
  onDisconnect,
  onRestart,
}: WhatsAppBridgePanelProps) {
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [data, setData] = useState<WhatsAppBridgeData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [actionLoading, setActionLoading] = useState<'restart' | 'disconnect' | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/bridges/whatsapp/status');

      if (!res.ok) {
        if (res.status === 404) {
          setViewState('not_configured');
          setData(null);
          return;
        }
        throw new Error(`Request failed (${res.status})`);
      }

      const json = await res.json() as { config?: WhatsAppBridgeConfig; bridge?: WhatsAppStatus; reachable?: boolean };
      setData({ config: json.config, status: json.bridge });

      if (!json.config || !json.config.enabled) {
        setViewState('not_configured');
        return;
      }

      const bridgeStatus = json.bridge?.status;
      if (bridgeStatus === 'connected') {
        setViewState('connected');
      } else if (bridgeStatus === 'pairing' || bridgeStatus === 'connecting') {
        setViewState('pairing');
      } else if (bridgeStatus === 'disconnected') {
        setViewState('disconnected');
      } else {
        setViewState('not_configured');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to reach bridge');
      setViewState('error');
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  // Polling — faster when not connected
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);

    const interval = viewState === 'connected' ? 30000 : 15000;
    pollRef.current = setInterval(fetchStatus, interval);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [viewState]);

  // --- Loading ---
  if (viewState === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20">
        <Loader2 className="w-8 h-8 text-white/30 animate-spin mb-3" />
        <p className="text-sm text-white/40">Checking bridge status...</p>
      </div>
    );
  }

  // --- Error ---
  if (viewState === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 px-6">
        <div className="w-full max-w-sm">
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 mb-5">
            <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-300">Bridge unavailable</p>
              <p className="text-xs text-red-400/70 mt-0.5">{errorMessage}</p>
            </div>
          </div>
          <button
            onClick={() => { setViewState('loading'); fetchStatus(); }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl
              border border-white/20 text-white/70 hover:text-white hover:bg-white/10
              text-sm transition-all"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // --- Not Configured ---
  if (viewState === 'not_configured') {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 px-6 text-center">
        <div className="p-4 rounded-2xl bg-green-500/10 border border-green-500/20 mb-5">
          <MessageCircle className="w-12 h-12 text-green-400" />
        </div>
        <h3 className="text-xl font-semibold text-white mb-2">WhatsApp Bridge</h3>
        <p className="text-sm text-white/60 mb-7 max-w-xs leading-relaxed">
          Connect your personal WhatsApp number so agents can send and receive messages on your behalf.
        </p>
        <button
          onClick={onSetup}
          className="px-6 py-2.5 rounded-xl bg-green-500 hover:bg-green-600 text-white
            text-sm font-medium transition-all shadow-lg shadow-green-500/20"
        >
          Set Up WhatsApp
        </button>
      </div>
    );
  }

  // --- Pairing ---
  if (viewState === 'pairing') {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 px-6 text-center">
        <div className="relative mb-6">
          <div className="w-3 h-3 rounded-full bg-amber-400 animate-pulse mx-auto mb-5" />
          <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20">
            <MessageCircle className="w-10 h-10 text-amber-400" />
          </div>
        </div>
        <h3 className="text-lg font-semibold text-white mb-2">Waiting for QR Scan</h3>
        <p className="text-sm text-white/60 mb-1 max-w-xs leading-relaxed">
          Open WhatsApp on your phone, go to
        </p>
        <p className="text-sm text-white/80 font-medium mb-6">
          Linked Devices &rarr; Link a Device
        </p>
        <p className="text-sm text-white/60 mb-6 max-w-xs">
          then scan the QR code.
        </p>

        <div className="flex flex-col items-center gap-3">
          <button
            onClick={onShowQR}
            className="px-6 py-2.5 rounded-xl bg-amber-500/20 border border-amber-500/40
              text-amber-300 hover:bg-amber-500/30 text-sm font-medium transition-all"
          >
            Show QR Code
          </button>
          <button
            onClick={onPairCode}
            className="text-sm text-white/50 underline underline-offset-2 hover:text-white/80
              transition-colors cursor-pointer"
          >
            Use pairing code instead
          </button>
        </div>
      </div>
    );
  }

  // --- Disconnected ---
  if (viewState === 'disconnected') {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 px-6 text-center">
        <div className="relative mb-6">
          <div className="w-3 h-3 rounded-full bg-amber-400 animate-pulse mx-auto mb-5" />
          <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20">
            <MessageCircle className="w-10 h-10 text-amber-400" />
          </div>
        </div>

        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 mb-6 max-w-sm text-left">
          <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-amber-300 leading-relaxed">
            Connection lost — your phone may be offline or the linked device was removed.
          </p>
        </div>

        <h3 className="text-lg font-semibold text-white mb-6">Waiting for QR Scan</h3>

        <div className="flex flex-col items-center gap-3">
          <button
            onClick={onShowQR}
            className="px-6 py-2.5 rounded-xl bg-amber-500/20 border border-amber-500/40
              text-amber-300 hover:bg-amber-500/30 text-sm font-medium transition-all"
          >
            Re-pair Device
          </button>
          <button
            onClick={onPairCode}
            className="text-sm text-white/50 underline underline-offset-2 hover:text-white/80
              transition-colors cursor-pointer"
          >
            Use pairing code instead
          </button>
        </div>
      </div>
    );
  }

  // --- Connected ---
  const phone = data?.status?.phone ?? '';
  const phoneName = data?.status?.phoneName ?? '';
  const lastActive = data?.config?.updatedAt;

  return (
    <div className="flex flex-col items-center justify-center h-full py-20 px-6 text-center">
      <div className="p-4 rounded-2xl bg-green-500/10 border border-green-500/20 mb-5">
        <CheckCircle2 className="w-10 h-10 text-green-400" />
      </div>

      {(phone || phoneName) && (
        <p className="text-base font-medium text-white mb-2">
          {[phone, phoneName].filter(Boolean).join(' · ')}
        </p>
      )}

      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full
        bg-green-500/20 text-green-300 border border-green-500/30 text-sm font-medium mb-3">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
        Connected
      </span>

      <p className="text-sm text-white/50 mb-8">
        Last active: {formatLastActive(lastActive)}
      </p>

      <div className="flex items-center gap-3">
        <button
          onClick={async () => { setActionLoading('restart'); await onRestart(); setActionLoading(null); }}
          disabled={actionLoading !== null}
          className="px-4 py-2 rounded-xl border border-white/20 text-white/70
            hover:text-white hover:bg-white/10 text-sm transition-all
            disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {actionLoading === 'restart' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : null}
          Restart
        </button>
        <button
          onClick={async () => { setActionLoading('disconnect'); await onDisconnect(); setActionLoading(null); }}
          disabled={actionLoading !== null}
          className="px-4 py-2 rounded-xl border border-red-500/40 text-red-400
            hover:bg-red-500/10 text-sm transition-all
            disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {actionLoading === 'disconnect' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : null}
          Disconnect
        </button>
      </div>
    </div>
  );
}
