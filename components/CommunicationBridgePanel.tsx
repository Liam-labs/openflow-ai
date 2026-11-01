'use client';

import { useState, useEffect, useRef } from 'react';
import { X, MessageCircle } from 'lucide-react';
import { WhatsAppBridgePanel, type WhatsAppBridgeData } from './WhatsAppBridgePanel';
import { WhatsAppSetupWizard } from './WhatsAppSetupWizard';
import { WhatsAppAllowListPanel } from './WhatsAppAllowListPanel';
import { SlackBridgePanel } from './SlackBridgePanel';
import { SlackSetupWizard } from './SlackSetupWizard';
import { TeamsBridgePanelV2 } from './TeamsBridgePanelV2';
import { TeamsSetupWizard } from './TeamsSetupWizard';
import { PRODUCT_NAME } from '@/lib/brand';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CommunicationBridgePanelProps {
  onClose: () => void;
}

type BridgeId = 'whatsapp' | 'slack' | 'teams';
type StatusDot = 'connected' | 'pairing' | 'offline' | 'not_configured';

interface BridgeEntry {
  id: BridgeId;
  label: string;
  tagline: string;
}

// ─── Bridge Definitions ───────────────────────────────────────────────────────

const BRIDGES: BridgeEntry[] = [
  { id: 'whatsapp', label: 'WhatsApp', tagline: 'Link your personal WhatsApp number' },
  { id: 'slack', label: 'Slack', tagline: 'Connect your Slack workspace' },
  { id: 'teams', label: 'Microsoft Teams', tagline: 'Bridge Teams channels' },
];

const COMING_SOON = [
  { label: 'Telegram', tagline: 'Bot API integration' },
];

// ─── Icons ────────────────────────────────────────────────────────────────────

function WhatsAppIcon({ className }: { className?: string }) {
  return <MessageCircle className={className} />;
}

function SlackIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
    </svg>
  );
}

function TeamsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.404 4.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM20.34 5.25h-1.872a2.219 2.219 0 0 1-.534.75h2.031A2.536 2.536 0 0 1 22.5 8.534v4.216a2.535 2.535 0 0 1-2.535 2.535h-.377a5.308 5.308 0 0 1-3.088 2.965v1.5A4.252 4.252 0 0 1 12.25 24h-5.5A4.252 4.252 0 0 1 2.5 19.75V18.5h-.75A1.752 1.752 0 0 1 0 16.75v-6A1.752 1.752 0 0 1 1.75 9h6.5A1.752 1.752 0 0 1 10 10.75v6A1.752 1.752 0 0 1 8.25 18.5H4v1.25A2.753 2.753 0 0 0 6.75 22.5h5.5a2.753 2.753 0 0 0 2.75-2.75V18.5h-.75a1.752 1.752 0 0 1-1.75-1.75v-6A1.752 1.752 0 0 1 14.25 9h3.537a3.756 3.756 0 0 1-1.037-2.25h-2.5A3.754 3.754 0 0 1 10.5 3h-.25A3.754 3.754 0 0 1 6.5 6.75V9H1.75A1.752 1.752 0 0 0 0 10.75v6c0 .414.146.794.389 1.092A1.748 1.748 0 0 1 0 16.75v-6C0 9.784.784 9 1.75 9h6.5c.966 0 1.75.784 1.75 1.75v6c0 .966-.784 1.75-1.75 1.75H4v1.25A2.753 2.753 0 0 0 6.75 22.5h5.5a2.753 2.753 0 0 0 2.75-2.75V18.25c0-.414.336-.75.75-.75h.75c.966 0 1.75-.784 1.75-1.75v-6c0-.966-.784-1.75-1.75-1.75H14.25c-.966 0-1.75.784-1.75 1.75v6c0 .966.784 1.75 1.75 1.75z" />
    </svg>
  );
}

function BridgeIcon({ id, className }: { id: BridgeId; className?: string }) {
  if (id === 'whatsapp') return <WhatsAppIcon className={className} />;
  if (id === 'slack') return <SlackIcon className={className} />;
  return <TeamsIcon className={className} />;
}

// ─── Accent Colors ────────────────────────────────────────────────────────────

const ACCENT: Record<BridgeId, { border: string; bg: string; iconBg: string; text: string; dot: string }> = {
  whatsapp: {
    border: 'border-green-500/70',
    bg: 'bg-green-500/10',
    iconBg: 'bg-green-500/20',
    text: 'text-green-400',
    dot: 'bg-green-400',
  },
  slack: {
    border: 'border-violet-500/70',
    bg: 'bg-violet-500/10',
    iconBg: 'bg-violet-500/20',
    text: 'text-violet-400',
    dot: 'bg-violet-400',
  },
  teams: {
    border: 'border-blue-500/70',
    bg: 'bg-blue-500/10',
    iconBg: 'bg-blue-500/20',
    text: 'text-blue-400',
    dot: 'bg-blue-400',
  },
};

// ─── Status Dot ───────────────────────────────────────────────────────────────

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

// ─── WhatsApp Status Derivation ───────────────────────────────────────────────

function deriveWhatsAppStatus(data: WhatsAppBridgeData | null, fetchError: boolean): StatusDot {
  if (fetchError || data === null) return 'not_configured';
  if (!data.config || !data.config.enabled) return 'not_configured';
  const s = data.status?.status;
  if (s === 'connected') return 'connected';
  if (s === 'pairing' || s === 'connecting') return 'pairing';
  if (s === 'disconnected') return 'offline';
  return 'not_configured';
}

// ─── Slack Status Derivation ──────────────────────────────────────────────────

interface SlackStatusLite {
  configured: boolean;
  connected: boolean;
}

function deriveSlackStatus(data: SlackStatusLite | null): StatusDot {
  if (!data) return 'not_configured';
  if (data.configured && data.connected) return 'connected';
  return 'not_configured';
}

// ─── Teams Status Derivation ──────────────────────────────────────────────────

interface TeamsStatusLite {
  configured: boolean;
  connected: boolean;
}

function deriveTeamsStatus(data: TeamsStatusLite | null): StatusDot {
  if (!data) return 'not_configured';
  if (data.configured && data.connected) return 'connected';
  return 'not_configured';
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function CommunicationBridgePanel({ onClose }: CommunicationBridgePanelProps) {
  const [selectedBridge, setSelectedBridge] = useState<BridgeId | null>(null);

  // ── WhatsApp state (copied exactly from MessagingBridgesPanel) ──
  const [whatsAppSubView, setWhatsAppSubView] = useState<'status' | 'allowlist'>('status');
  const [showWizard, setShowWizard] = useState(false);
  const [wizardInitialStep, setWizardInitialStep] = useState<1 | 3>(1);
  const [wizardInitialTab, setWizardInitialTab] = useState<'qr' | 'code'>('qr');
  const [whatsAppData, setWhatsAppData] = useState<WhatsAppBridgeData | null>(null);
  const [whatsAppError, setWhatsAppError] = useState(false);
  const wasPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    // This refresh updates state after the bridge HTTP request completes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void pollWhatsApp();
    wasPollRef.current = setInterval(pollWhatsApp, 30000);
    return () => { if (wasPollRef.current) clearInterval(wasPollRef.current); };
  }, []);

  const whatsAppStatus = deriveWhatsAppStatus(whatsAppData, whatsAppError);

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

  // ── Slack status polling ──
  const [slackData, setSlackData] = useState<SlackStatusLite | null>(null);
  const [showSlackWizard, setShowSlackWizard] = useState(false);
  const slackPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollSlack = async () => {
    try {
      const res = await fetch('/api/bridges/slack/status');
      if (!res.ok) { setSlackData(null); return; }
      const json: SlackStatusLite = await res.json();
      setSlackData(json);
    } catch { setSlackData(null); }
  };

  useEffect(() => {
    // This refresh updates state after the bridge HTTP request completes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void pollSlack();
    slackPollRef.current = setInterval(pollSlack, 30000);
    return () => { if (slackPollRef.current) clearInterval(slackPollRef.current); };
  }, []);

  const slackStatus = deriveSlackStatus(slackData);
  const slackConfigured = slackData?.configured && slackData?.connected;

  // ── Teams status polling ──
  const [teamsData, setTeamsData] = useState<TeamsStatusLite | null>(null);
  const [showTeamsWizard, setShowTeamsWizard] = useState(false);
  const teamsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollTeams = async () => {
    try {
      const res = await fetch('/api/bridges/teams/status');
      if (!res.ok) { setTeamsData(null); return; }
      const json: TeamsStatusLite = await res.json();
      setTeamsData(json);
    } catch { setTeamsData(null); }
  };

  useEffect(() => {
    // This refresh updates state after the bridge HTTP request completes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void pollTeams();
    teamsPollRef.current = setInterval(pollTeams, 30000);
    return () => { if (teamsPollRef.current) clearInterval(teamsPollRef.current); };
  }, []);

  const teamsStatus = deriveTeamsStatus(teamsData);
  const teamsConfigured = teamsData?.configured && teamsData?.connected;

  // ── Status map ──
  const statusOf = (id: BridgeId): StatusDot => {
    if (id === 'whatsapp') return whatsAppStatus;
    if (id === 'slack') return slackStatus;
    return teamsStatus;
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="max-w-4xl w-full mx-4 h-[85vh] glass-card rounded-2xl flex flex-col overflow-hidden"
        style={{ background: 'rgba(8,14,28,0.97)', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
      >

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-white/8 flex-shrink-0">
          <div>
            <h2 className="text-lg font-bold gradient-text">Communication Bridge</h2>
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
        <div className="flex flex-col sm:flex-row flex-1 min-h-0">
          <label className="sm:hidden px-4 py-3 text-sm border-b border-white/10">
            Platform
            <select aria-label="Platform" className="glass-input mt-2 w-full" value={selectedBridge ?? ''} onChange={event => setSelectedBridge((event.target.value || null) as BridgeId | null)}>
              <option value="">Choose a platform</option>
              {BRIDGES.map(bridge => <option key={bridge.id} value={bridge.id}>{bridge.label}</option>)}
            </select>
          </label>

          {/* Sidebar */}
          <div className="hidden sm:block w-60 flex-shrink-0 border-r border-white/8 py-3 overflow-y-auto">
            <div className="px-4 pb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/30">
                Available
              </span>
            </div>

            {BRIDGES.map((bridge) => {
              const isActive = selectedBridge === bridge.id;
              const status = statusOf(bridge.id);
              const accent = ACCENT[bridge.id];

              return (
                <button
                  key={bridge.id}
                  onClick={() => setSelectedBridge(bridge.id)}
                  className={`
                    w-full flex items-center gap-3 px-4 py-3 text-left transition-all duration-150
                    ${isActive
                      ? `border-l-2 ${accent.border} ${accent.bg} pl-[14px]`
                      : 'border-l-2 border-transparent hover:bg-white/5 hover:pl-[14px]'
                    }
                  `}
                >
                  <div className={`p-1.5 rounded-lg flex-shrink-0 ${isActive ? accent.iconBg : 'bg-white/5'}`}>
                    <BridgeIcon id={bridge.id} className={`w-4 h-4 ${isActive ? accent.text : 'text-white/40'}`} />
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

            {/* Coming Soon */}
            <div className="mx-4 my-3 border-t border-white/[0.06]" />
            <div className="px-4 pb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/30">
                Coming Soon
              </span>
            </div>

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
          <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">

            {/* Empty state */}
            {selectedBridge === null && (
              <div className="flex flex-col items-center justify-center h-full py-20 px-6 text-center">
                <div className="p-4 rounded-2xl bg-white/5 border border-white/10 mb-5">
                  <MessageCircle className="w-10 h-10 text-white/30" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-2">Select a platform</h3>
                <p className="text-sm text-white/50 max-w-xs leading-relaxed">
                  Choose a messaging platform from the left to view its connection status and settings.
                </p>
              </div>
            )}

            {/* ── WhatsApp ── */}
            {selectedBridge === 'whatsapp' && (
              <>
                {/* Sub-nav */}
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
            )}

            {/* ── Slack ── */}
            {selectedBridge === 'slack' && (
              <>
                <div className="flex-1 overflow-y-auto">
                  {slackConfigured ? (
                    <SlackBridgePanel
                      onSetup={() => setShowSlackWizard(true)}
                      onRefresh={pollSlack}
                    />
                  ) : (
                    <SlackBridgePanel
                      onSetup={() => setShowSlackWizard(true)}
                      onRefresh={pollSlack}
                    />
                  )}
                </div>
                {showSlackWizard && (
                  <div className="absolute inset-0 bg-black/85 flex items-center justify-center z-10 rounded-r-2xl">
                    <SlackSetupWizard
                      onComplete={() => { setShowSlackWizard(false); pollSlack(); }}
                      onCancel={() => setShowSlackWizard(false)}
                    />
                  </div>
                )}
              </>
            )}

            {/* ── Teams ── */}
            {selectedBridge === 'teams' && (
              <>
                <div className="flex-1 overflow-y-auto">
                  <TeamsBridgePanelV2
                    onSetup={() => setShowTeamsWizard(true)}
                  />
                </div>
                {showTeamsWizard && (
                  <div className="absolute inset-0 bg-black/85 flex items-center justify-center z-10 rounded-r-2xl">
                    <TeamsSetupWizard
                      onComplete={() => { setShowTeamsWizard(false); pollTeams(); }}
                      onCancel={() => setShowTeamsWizard(false)}
                    />
                  </div>
                )}
              </>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
