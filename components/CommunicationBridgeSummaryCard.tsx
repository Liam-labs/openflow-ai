'use client';

import { useState, useEffect, useRef } from 'react';
import { MessageCircle, Settings } from 'lucide-react';
import type { WhatsAppBridgeData } from './WhatsAppBridgePanel';

type StatusDot = 'connected' | 'pairing' | 'offline' | 'not_configured';

interface BridgeSummary {
  id: 'whatsapp' | 'slack' | 'teams';
  label: string;
  status: StatusDot;
}

interface Props {
  onOpen: () => void;
}

function deriveWhatsAppStatus(data: WhatsAppBridgeData | null, error: boolean): StatusDot {
  if (error || !data) return 'not_configured';
  if (!data.config?.enabled) return 'not_configured';
  const s = data.status?.status;
  if (s === 'connected') return 'connected';
  if (s === 'pairing' || s === 'connecting') return 'pairing';
  if (s === 'disconnected') return 'offline';
  return 'not_configured';
}

function StatusDot({ status }: { status: StatusDot }) {
  const cls: Record<StatusDot, string> = {
    connected: 'bg-green-400',
    pairing: 'bg-amber-400 animate-pulse',
    offline: 'bg-red-400',
    not_configured: 'bg-white/20',
  };
  const label: Record<StatusDot, string> = {
    connected: 'Connected',
    pairing: 'Pairing',
    offline: 'Offline',
    not_configured: 'Not configured',
  };
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${cls[status]}`} />
      <span className="text-xs text-white/40">{label[status]}</span>
    </span>
  );
}

function WhatsAppIcon({ className }: { className?: string }) {
  return <MessageCircle className={className} />;
}

function SlackIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
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

const BRIDGE_ACCENT: Record<string, { icon: string; iconBg: string }> = {
  whatsapp: { icon: 'text-green-400', iconBg: 'bg-green-500/15' },
  slack:    { icon: 'text-violet-400', iconBg: 'bg-violet-500/15' },
  teams:    { icon: 'text-blue-400',   iconBg: 'bg-blue-500/15' },
};

function BridgeIcon({ id, className }: { id: string; className?: string }) {
  if (id === 'whatsapp') return <WhatsAppIcon className={className} />;
  if (id === 'slack') return <SlackIcon className={className} />;
  return <TeamsIcon className={className} />;
}

export function CommunicationBridgeSummaryCard({ onOpen }: Props) {
  const [waData, setWaData] = useState<WhatsAppBridgeData | null>(null);
  const [waError, setWaError] = useState(false);
  const [slackData, setSlackData] = useState<{ configured: boolean; connected: boolean } | null>(null);
  const [teamsData, setTeamsData] = useState<{ configured: boolean; connected: boolean } | null>(null);

  const waRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const slackRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const teamsRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollWhatsApp = async () => {
    try {
      const res = await fetch('/api/bridges/whatsapp');
      if (!res.ok) { setWaData(null); setWaError(res.status !== 404); return; }
      setWaData(await res.json());
      setWaError(false);
    } catch { setWaError(true); }
  };

  const pollSlack = async () => {
    try {
      const res = await fetch('/api/bridges/slack/status');
      if (!res.ok) { setSlackData(null); return; }
      setSlackData(await res.json());
    } catch { setSlackData(null); }
  };

  const pollTeams = async () => {
    try {
      const res = await fetch('/api/bridges/teams/status');
      if (!res.ok) { setTeamsData(null); return; }
      setTeamsData(await res.json());
    } catch { setTeamsData(null); }
  };

  useEffect(() => {
    pollWhatsApp(); pollSlack(); pollTeams();
    waRef.current    = setInterval(pollWhatsApp, 30000);
    slackRef.current = setInterval(pollSlack, 30000);
    teamsRef.current = setInterval(pollTeams, 30000);
    return () => {
      if (waRef.current)    clearInterval(waRef.current);
      if (slackRef.current) clearInterval(slackRef.current);
      if (teamsRef.current) clearInterval(teamsRef.current);
    };
  }, []);

  const bridges: BridgeSummary[] = [
    { id: 'whatsapp', label: 'WhatsApp',        status: deriveWhatsAppStatus(waData, waError) },
    { id: 'slack',    label: 'Slack',            status: slackData?.configured && slackData?.connected ? 'connected' : 'not_configured' },
    { id: 'teams',    label: 'Microsoft Teams',  status: teamsData?.configured && teamsData?.connected ? 'connected' : 'not_configured' },
  ];

  return (
    <div className="divide-y divide-white/5">
      {bridges.map((b) => {
        const accent = BRIDGE_ACCENT[b.id];
        return (
          <div
            key={b.id}
            className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 cursor-pointer transition-colors"
            onClick={onOpen}
          >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${accent.iconBg}`}>
              <BridgeIcon id={b.id} className={`w-4 h-4 ${accent.icon}`} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white/90 leading-tight">{b.label}</p>
              <StatusDot status={b.status} />
            </div>
            <Settings className="w-3.5 h-3.5 text-white/20 flex-shrink-0" />
          </div>
        );
      })}
    </div>
  );
}
