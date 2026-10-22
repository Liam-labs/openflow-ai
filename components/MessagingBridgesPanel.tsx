'use client';

import { useState, useEffect, useRef } from 'react';
import {
  X,
  MessageCircle,
} from 'lucide-react';
import { WhatsAppBridgePanel, type WhatsAppBridgeData } from './WhatsAppBridgePanel';
import { WhatsAppSetupWizard } from './WhatsAppSetupWizard';
import { WhatsAppAllowListPanel } from './WhatsAppAllowListPanel';
import { PRODUCT_NAME } from '@/lib/brand';

interface MessagingBridgesPanelProps {
  onClose: () => void;
}

type BridgeId = 'whatsapp';
type StatusDot = 'connected' | 'pairing' | 'offline' | 'not_configured';

interface BridgeEntry {
  id: BridgeId;
  label: string;
  tagline: string;
  comingSoon?: boolean;
}

const BRIDGES: BridgeEntry[] = [
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    tagline: 'Link your personal WhatsApp number',
  },
];

const COMING_SOON = [
  { label: 'Signal', tagline: 'Encrypted messaging' },
  { label: 'Telegram', tagline: 'Bot API integration' },
  { label: 'Slack DM', tagline: 'Direct message routing' },
];

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <MessageCircle className={className} />
  );
}

function StatusIndicator({ status }: { status: StatusDot }) {
  const classes: Record<StatusDot, string> = {
    connected: 'bg-green-400',
    pairing: 'bg-amber-400 animate-pulse',
    offline: 'bg-red-400',
    not_configured: 'bg-white/20',
  };
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${classes[status]}`}
      title={status.replace('_', ' ')}
    />
  );
}

function deriveStatus(data: WhatsAppBridgeData | null, fetchError: boolean): StatusDot {
  if (fetchError || data === null) return 'not_configured';
  if (!data.config || !data.config.enabled) return 'not_configured';
  const s = data.status?.status;
  if (s === 'connected') return 'connected';
  if (s === 'pairing' || s === 'connecting') return 'pairing';
  if (s === 'disconnected') return 'offline';
  return 'not_configured';
}

export function MessagingBridgesPanel({ onClose }: MessagingBridgesPanelProps) {
  const [selectedBridge, setSelectedBridge] = useState<BridgeId | null>(null);
  const [whatsAppSubView, setWhatsAppSubView] = useState<'status' | 'allowlist'>('status');
  const [showWizard, setShowWizard] = useState(false);
  const [wizardInitialStep, setWizardInitialStep] = useState<1 | 3>(1);
  const [wizardInitialTab, setWizardInitialTab] = useState<'qr' | 'code'>('qr');

  // Status polling for the sidebar dot
  const [whatsAppData, setWhatsAppData] = useState<WhatsAppBridgeData | null>(null);
  const [whatsAppError, setWhatsAppError] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollWhatsApp = async () => {
    try {
      const res = await fetch('/api/bridges/whatsapp');
      if (!res.ok) {
        setWhatsAppData(null);
        setWhatsAppError(res.status !== 404);
        return;
      }
      const json: WhatsAppBridgeData = await res.json();
      setWhatsAppData(json);
      setWhatsAppError(false);
    } catch {
      setWhatsAppError(true);
    }
  };

  useEffect(() => {
    pollWhatsApp();
    pollRef.current = setInterval(pollWhatsApp, 30000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const whatsAppStatus = deriveStatus(whatsAppData, whatsAppError);

  const openWizard = () => { setWizardInitialStep(1); setWizardInitialTab('qr'); setShowWizard(true); };
  const openWizardQR = () => { setWizardInitialStep(3); setWizardInitialTab('qr'); setShowWizard(true); };
  const openWizardCode = () => { setWizardInitialStep(3); setWizardInitialTab('code'); setShowWizard(true); };

  const handleDisconnect = async () => {
    try {
      await fetch('/api/bridges/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }),
      });
      await pollWhatsApp();
    } catch { /* non-fatal */ }
  };

  const handleRestart = async () => {
    try {
      await fetch('/api/bridges/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle' }),
      });
      await pollWhatsApp();
    } catch { /* non-fatal */ }
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="max-w-4xl w-full mx-4 h-[85vh] glass-card rounded-2xl flex flex-col overflow-hidden" style={{ background: 'rgba(8, 14, 28, 0.97)', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}>

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-white/8 flex-shrink-0">
          <div>
            <h2 className="text-lg font-bold gradient-text">Messaging Bridges</h2>
            <p className="text-sm text-white/50 mt-0.5">
              Connect messaging platforms to your {PRODUCT_NAME} agents
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-all"
            aria-label="Close panel"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">

          {/* Sidebar */}
          <div className="w-60 flex-shrink-0 border-r border-white/8 py-3 overflow-y-auto">
            <div className="px-4 pb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/30">
                Available
              </span>
            </div>

            {/* Active bridges */}
            {BRIDGES.map((bridge) => {
              const isActive = selectedBridge === bridge.id;
              const status = bridge.id === 'whatsapp' ? whatsAppStatus : 'not_configured';

              return (
                <button
                  key={bridge.id}
                  onClick={() => setSelectedBridge(bridge.id)}
                  className={`
                    w-full flex items-center gap-3 px-4 py-3 text-left transition-all duration-150
                    ${isActive
                      ? 'border-l-2 border-green-500/70 bg-green-500/10 pl-[14px]'
                      : 'border-l-2 border-transparent hover:bg-white/5 hover:pl-[14px]'
                    }
                  `}
                >
                  <div className={`
                    p-1.5 rounded-lg flex-shrink-0
                    ${isActive ? 'bg-green-500/20' : 'bg-white/5'}
                  `}>
                    <WhatsAppIcon className={`w-4 h-4 ${isActive ? 'text-green-400' : 'text-white/40'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium truncate ${isActive ? 'text-white' : 'text-white/70'}`}>
                      {bridge.label}
                    </div>
                    <div className="text-[11px] text-white/35 truncate">{bridge.tagline}</div>
                  </div>
                  <StatusIndicator status={status} />
                </button>
              );
            })}

            {/* Divider */}
            <div className="mx-4 my-3 border-t border-white/[0.06]" />
            <div className="px-4 pb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/30">
                Coming Soon
              </span>
            </div>

            {/* Future bridges */}
            {COMING_SOON.map((bridge) => (
              <div
                key={bridge.label}
                className="w-full flex items-center gap-3 px-4 py-3 opacity-35 cursor-not-allowed border-l-2 border-transparent"
              >
                <div className="p-1.5 rounded-lg flex-shrink-0 bg-white/5">
                  <MessageCircle className="w-4 h-4 text-white/40" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate text-white/70">{bridge.label}</div>
                  <div className="text-[11px] text-white/35 truncate">{bridge.tagline}</div>
                </div>
                <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-white/8 text-white/30 flex-shrink-0">
                  Soon
                </span>
              </div>
            ))}
          </div>

          {/* Right content */}
          <div className="flex-1 flex flex-col min-h-0 relative">
            {selectedBridge === null ? (
              <div className="flex flex-col items-center justify-center h-full py-20 px-6 text-center">
                <div className="p-4 rounded-2xl bg-white/5 border border-white/10 mb-5">
                  <MessageCircle className="w-10 h-10 text-white/30" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-2">Select a platform</h3>
                <p className="text-sm text-white/50 max-w-xs leading-relaxed">
                  Choose a messaging platform from the left to view its connection status and settings.
                </p>
              </div>
            ) : selectedBridge === 'whatsapp' ? (
              <>
                {/* WhatsApp sub-nav */}
                <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-white/[0.06] flex-shrink-0">
                  <button
                    onClick={() => setWhatsAppSubView('status')}
                    className={`px-3 py-2 text-sm font-medium border-b-2 transition-all -mb-px ${
                      whatsAppSubView === 'status'
                        ? 'border-green-500/70 text-white'
                        : 'border-transparent text-white/40 hover:text-white/70'
                    }`}
                  >
                    Status
                  </button>
                  <button
                    onClick={() => setWhatsAppSubView('allowlist')}
                    className={`px-3 py-2 text-sm font-medium border-b-2 transition-all -mb-px ${
                      whatsAppSubView === 'allowlist'
                        ? 'border-green-500/70 text-white'
                        : 'border-transparent text-white/40 hover:text-white/70'
                    }`}
                  >
                    Allow List
                  </button>
                </div>

                {/* Sub-view content */}
                <div className="flex-1 overflow-y-auto">
                  {whatsAppSubView === 'status' ? (
                    <WhatsAppBridgePanel
                      onSetup={openWizard}
                      onShowQR={openWizardQR}
                      onPairCode={openWizardCode}
                      onDisconnect={handleDisconnect}
                      onRestart={handleRestart}
                    />
                  ) : (
                    <WhatsAppAllowListPanel />
                  )}
                </div>

                {showWizard && (
                  <div className="absolute inset-0 bg-black/85 flex items-center justify-center z-10 rounded-r-2xl">
                    <WhatsAppSetupWizard
                      onComplete={() => { setShowWizard(false); pollWhatsApp(); }}
                      onCancel={() => setShowWizard(false)}
                      initialStep={wizardInitialStep}
                      initialTab={wizardInitialTab}
                    />
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
