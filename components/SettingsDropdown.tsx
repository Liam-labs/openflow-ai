'use client';

import React, { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import {
  Settings, Globe, Key, Cpu, MessageCircle, HardDrive,
  Lock, Cloud, Monitor, ChevronRight, LayoutGrid, Server, FileText,
  Palette, Check, Copy, Loader2, Plus, Mic, FlaskConical, Shield, RefreshCw, Download
} from 'lucide-react';
import { useTheme, THEMES, type ThemeMeta } from '@/lib/contexts/ThemeContext';
import { ApiTokensModal } from './ApiTokensModal';
import { LocalProxyModal } from './LocalProxyModal';
import { ModelConfigPanel } from './ModelConfigPanel';
import { ModelConfigModal } from './ModelConfigModal';
import { CommunicationBridgePanel } from './CommunicationBridgePanel';
import { SetupWizardModal } from './SetupWizardModal';
import { WSLResourcesModal } from './WSLResourcesModal';
import { TedVoiceButton } from './TedVoiceButton';
import { SupabaseConfigPanel } from './SupabaseConfigPanel';
import { AlignmentRulesPanel } from './AlignmentRulesPanel';
import { RileyVoiceInstallModal } from './RileyVoiceInstallModal';
import { RILEY_VOICE_ENABLED } from './RileyVoiceEnabled';
import { triggerRebuild } from '@/lib/settings-rebuild';
import { PRODUCT_NAME } from '@/lib/brand';

interface SettingsDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onAddProject?: () => void;
}

export function SettingsDropdown({ isOpen, onClose, anchorRef, onAddProject }: SettingsDropdownProps) {
  const { theme, setTheme } = useTheme();
  const [showApiTokensModal, setShowApiTokensModal] = useState(false);
  const [showLocalProxyModal, setShowLocalProxyModal] = useState(false);
  const [showModelConfigPanel, setShowModelConfigPanel] = useState(false);
  const [showMessagingBridgesPanel, setShowMessagingBridgesPanel] = useState(false);
  const [showWSLResourcesModal, setShowWSLResourcesModal] = useState(false);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [showSupabaseConfigPanel, setShowSupabaseConfigPanel] = useState(false);
  const [showAlignmentRulesPanel, setShowAlignmentRulesPanel] = useState(false);
  const [showRileyVoiceInstall, setShowRileyVoiceInstall] = useState(false);
  const [selectedModelForConfig, setSelectedModelForConfig] = useState<React.ComponentProps<typeof ModelConfigModal>['model'] | null>(null);
  
  const [computerUseEnabled, setComputerUseEnabled] = useState(false);
  const [computerUseBackend, setComputerUseBackend] = useState<'api' | 'max'>('api');
  const [computerUseToggling, setComputerUseToggling] = useState(false);

  // Alpha clone state
  const [alphaCloning, setAlphaCloning] = useState(false);
  const [alphaResult, setAlphaResult] = useState<{ success: boolean; message: string } | null>(null);
  const [alphaLatestVersion, setAlphaLatestVersion] = useState<number | null>(null);

  // Rebuild state
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildResult, setRebuildResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetch('/api/settings')
        .then(r => r.ok ? r.json() : null)
        .then((data: { settings?: { computerUse?: { enabled?: boolean; backend?: 'api' | 'max' } } } | null) => {
          if (data?.settings?.computerUse) {
            setComputerUseEnabled(!!data.settings.computerUse.enabled);
            if (data.settings.computerUse.backend) setComputerUseBackend(data.settings.computerUse.backend);
          }
        })
        .catch(() => {});

      // Fetch alpha version info
      fetch('/api/settings/alpha-clone')
        .then(r => r.ok ? r.json() : null)
        .then((data: { latestVersion?: number } | null) => {
          if (data?.latestVersion !== undefined) {
            setAlphaLatestVersion(data.latestVersion);
          }
        })
        .catch(() => {});

      setAlphaResult(null);
    }
  }, [isOpen]);

  const handleToggleComputerUse = async () => {
    if (computerUseToggling) return;
    setComputerUseToggling(true);
    const newValue = !computerUseEnabled;
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerUse: { enabled: newValue } }),
      });
      if (res.ok) setComputerUseEnabled(newValue);
    } catch { /* ignore */ }
    finally { setComputerUseToggling(false); }
  };

  const handleAlphaClone = async () => {
    if (alphaCloning) return;
    setAlphaCloning(true);
    setAlphaResult(null);
    try {
      const res = await fetch('/api/settings/alpha-clone', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const nextVer = (alphaLatestVersion ?? 0) + 1;
        setAlphaLatestVersion(nextVer);
        setAlphaResult({ success: true, message: `Alpha v${nextVer} created` });
      } else {
        setAlphaResult({ success: false, message: data.error || 'Clone failed' });
      }
    } catch {
      setAlphaResult({ success: false, message: 'Request failed' });
    } finally {
      setAlphaCloning(false);
    }
  };

  const handleRebuild = async () => {
    if (rebuilding) return;
    setRebuilding(true);
    setRebuildResult(null);
    const result = await triggerRebuild();
    setRebuilding(false);
    setRebuildResult(result);
    if (result.success) {
      setTimeout(() => setRebuildResult(null), 5000);
    }
  };

  if (!isOpen) return null;
  const panelOpen = showApiTokensModal || showLocalProxyModal || showModelConfigPanel ||
    !!selectedModelForConfig || showMessagingBridgesPanel || showWSLResourcesModal ||
    showSetupWizard || showSupabaseConfigPanel || showAlignmentRulesPanel || showRileyVoiceInstall;

  return (
    <>
      {!panelOpen && <>
      <div className="fixed inset-0 z-[100]" onClick={onClose} />
      <div
        className="absolute right-0 top-full mt-3 w-[320px] backdrop-blur-3xl border border-white/10 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.6)] overflow-hidden z-[101] animate-in fade-in slide-in-from-top-2 duration-200"
        style={{ background: 'rgba(var(--df-surface-ch), 0.92)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/5 bg-white/[0.02]">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Settings className="w-4 h-4 text-accent" />
            System Settings
          </h3>
          <p className="text-[11px] text-white/40 mt-0.5">Manage your {PRODUCT_NAME} environment</p>
        </div>

        <div className="max-h-[70vh] overflow-y-auto custom-scrollbar">
          {/* Group: Appearance */}
          <div className="p-4 border-b border-white/5">
            <div className="flex items-center gap-2 mb-3">
              <Palette className="w-3.5 h-3.5 text-white/25" />
              <span className="text-[10px] font-bold text-white/20 uppercase tracking-wider">Display Theme</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {THEMES.map(t => (
                <ThemeCard
                  key={t.id}
                  theme={t}
                  active={theme === t.id}
                  onClick={() => setTheme(t.id)}
                />
              ))}
            </div>
          </div>

          {/* Group: Core Systems */}
          <div className="p-2">
            <div className="px-3 py-2 text-[10px] font-bold text-white/20 uppercase tracking-wider">Environment</div>
            <div className="grid grid-cols-1 gap-1">
              {RILEY_VOICE_ENABLED && (
                <>
                  <SettingsItem
                    icon={<Mic className="w-4 h-4 text-blue-400" />}
                    label="Riley Voice"
                    description="Voice training, provider & delivery"
                    onClick={() => { onClose(); window.location.assign('/riley-voice'); }}
                  />
                  <SettingsItem
                    icon={<Download className="w-4 h-4 text-blue-400" />}
                    label="Install Riley Voice"
                    description="Its own app on your laptop or phone"
                    onClick={() => { setShowRileyVoiceInstall(true); }}
                  />
                </>
              )}
              <SettingsItem 
                icon={<Globe className="w-4 h-4 text-blue-400" />} 
                label="Local Proxy" 
                description="Manage local service routing"
                onClick={() => { setShowLocalProxyModal(true); }} 
              />
              <SettingsItem 
                icon={<Key className="w-4 h-4 text-amber-400" />} 
                label="API Tokens" 
                description="Configure LLM & service keys"
                onClick={() => { setShowApiTokensModal(true); }} 
              />
              <SettingsItem 
                icon={<Cpu className="w-4 h-4 text-purple-400" />} 
                label="Model Config" 
                description="Global model defaults & params"
                onClick={() => { setShowModelConfigPanel(true); }} 
              />
              <SettingsItem 
                icon={<MessageCircle className="w-4 h-4 text-emerald-400" />} 
                label="Messaging Bridges" 
                description="Slack, Teams & WhatsApp"
                onClick={() => { setShowMessagingBridgesPanel(true); }} 
              />
              <SettingsItem
                icon={<HardDrive className="w-4 h-4 text-sky-400" />}
                label="WSL Resources"
                description="Memory & CPU allocation"
                onClick={() => { setShowWSLResourcesModal(true); }}
              />
              <SettingsItem
                icon={<FlaskConical className="w-4 h-4" style={{ color: '#3ECF8E' }} />}
                label="Supabase"
                description="Register & manage database instances"
                onClick={() => { setShowSupabaseConfigPanel(true); }}
              />
              <SettingsItem
                icon={<Shield className="w-4 h-4 text-blue-400" />}
                label="Alignment Rules"
                description="Edit agent behavioral guardrail files"
                onClick={() => { setShowAlignmentRulesPanel(true); }}
              />
            </div>
          </div>

          <div className="mx-4 border-t border-white/5 my-1" />

          {/* Group: Quick Actions */}
          <div className="p-2">
            <div className="px-3 py-2 text-[10px] font-bold text-white/20 uppercase tracking-wider">Quick Actions</div>
            <div className="grid grid-cols-1 gap-1">
              <SettingsItem
                icon={<Plus className="w-4 h-4 text-accent" />}
                label="Add Project"
                description="Register a new project"
                onClick={() => { onAddProject?.(); onClose(); }}
              />
              <div className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-white/5 transition-all group">
                <div className="p-2 rounded-lg bg-white/[0.02] border border-white/[0.03] group-hover:border-white/10 group-hover:bg-white/[0.06] transition-all">
                  <Mic className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-white/80 group-hover:text-white transition-colors">Legacy Voice</div>
                  <div className="text-[10px] text-white/30 group-hover:text-white/50 transition-colors truncate">Ted voice control</div>
                </div>
                <TedVoiceButton refreshInterval={30000} />
              </div>
            </div>
          </div>

          <div className="mx-4 border-t border-white/5 my-1" />

          {/* Group: Alpha Channel */}
          <div className="p-4 bg-cyan-500/5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Copy className="w-4 h-4 text-cyan-400" />
                <span className="text-sm font-semibold text-white">Alpha Channel</span>
              </div>
              {alphaLatestVersion !== null && (
                <span className="text-[10px] font-mono text-white/30">
                  {alphaLatestVersion > 0 ? `Latest: v${alphaLatestVersion}` : 'No versions yet'}
                </span>
              )}
            </div>
            <p className="text-[10px] text-white/30 mb-3">Clone production {PRODUCT_NAME} to a new versioned alpha</p>
            <button
              onClick={handleAlphaClone}
              disabled={alphaCloning}
              className={`w-full py-2.5 text-[11px] font-bold rounded-lg border transition-all text-center flex items-center justify-center gap-2 ${
                alphaCloning
                  ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-400/60 cursor-wait'
                  : alphaResult?.success
                    ? 'bg-green-500/10 border-green-500/30 text-green-400'
                    : 'bg-cyan-500/10 hover:bg-cyan-500/20 border-cyan-500/20 hover:border-cyan-500/40 text-cyan-400'
              }`}
            >
              {alphaCloning ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Cloning... (this may take a minute)
                </>
              ) : alphaResult?.success ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  {alphaResult.message}
                </>
              ) : (
                `Clone to Alpha v${(alphaLatestVersion ?? 0) + 1}`
              )}
            </button>
            {alphaResult && !alphaResult.success && (
              <p className="text-[10px] text-red-400 mt-2">{alphaResult.message}</p>
            )}
          </div>

          <div className="mx-4 border-t border-white/5 my-1" />

          {/* Group: Rebuild DevFlow */}
          <div className="p-4 bg-amber-500/5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-semibold text-white">Rebuild {PRODUCT_NAME}</span>
              </div>
            </div>
            <p className="text-[10px] text-white/30 mb-3">Trigger a fresh production build and restart</p>
            <button
              onClick={handleRebuild}
              disabled={rebuilding}
              className={`w-full py-2.5 text-[11px] font-bold rounded-lg border transition-all text-center flex items-center justify-center gap-2 ${
                rebuilding
                  ? 'bg-amber-500/10 border-amber-500/20 text-amber-400/60 cursor-wait'
                  : rebuildResult?.success
                    ? 'bg-green-500/10 border-green-500/30 text-green-400'
                    : 'bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/20 hover:border-amber-500/40 text-amber-400'
              }`}
            >
              {rebuilding ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Rebuilding... (~60s)
                </>
              ) : rebuildResult?.success ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Build started
                </>
              ) : (
                `Rebuild ${PRODUCT_NAME}`
              )}
            </button>
            {rebuildResult && !rebuildResult.success && (
              <p className="text-[10px] text-red-400 mt-2">{rebuildResult.message}</p>
            )}
          </div>

          <div className="mx-4 border-t border-white/5 my-1" />

          {/* Group: Computer Use */}
          <div className="p-4 bg-accent/5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-accent" />
                <span className="text-sm font-semibold text-white">Computer Use</span>
              </div>
              <button 
                onClick={handleToggleComputerUse} 
                disabled={computerUseToggling}
                className={`relative w-10 h-5 rounded-full transition-colors ${computerUseEnabled ? 'bg-green-500' : 'bg-white/10'}`}
              >
                <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full transition-transform ${computerUseEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>
            
            {computerUseEnabled && (
              <div className="flex gap-2 mb-3">
                <button 
                  onClick={() => {/* handleSetBackend('api') */}} 
                  className={`flex-1 py-1.5 text-[10px] font-bold rounded-lg border transition-all ${computerUseBackend === 'api' ? 'bg-blue-500/20 border-blue-500/40 text-blue-400' : 'bg-black/20 border-white/5 text-white/30'}`}
                >
                  API CLOUD
                </button>
                <button 
                  onClick={() => {/* handleSetBackend('max') */}} 
                  className={`flex-1 py-1.5 text-[10px] font-bold rounded-lg border transition-all ${computerUseBackend === 'max' ? 'bg-purple-500/20 border-purple-500/40 text-purple-400' : 'bg-black/20 border-white/5 text-white/30'}`}
                >
                  MAX LOCAL
                </button>
              </div>
            )}
            
            <button 
              onClick={() => { setShowSetupWizard(true); }}
              className="w-full py-2 bg-white/5 hover:bg-white/10 text-white/60 text-[11px] font-medium rounded-lg border border-white/5 transition-all text-center"
            >
              Run Setup Wizard →
            </button>
          </div>
        </div>
      </div>

      </>}
      {/* Hide the menu and its higher backdrop while a child panel owns input. */}
      {showApiTokensModal && <ApiTokensModal onClose={() => setShowApiTokensModal(false)} />}
      {showLocalProxyModal && <LocalProxyModal onClose={() => setShowLocalProxyModal(false)} />}
      {showModelConfigPanel && (
        <ModelConfigPanel
          onClose={() => setShowModelConfigPanel(false)}
          onModelSelect={(model) => setSelectedModelForConfig(model)}
        />
      )}
      {selectedModelForConfig && (
        <ModelConfigModal
          model={selectedModelForConfig}
          onClose={() => setSelectedModelForConfig(null)}
          onConfigured={() => {}}
        />
      )}
      {showMessagingBridgesPanel && <CommunicationBridgePanel onClose={() => setShowMessagingBridgesPanel(false)} />}
      {showWSLResourcesModal && <WSLResourcesModal onClose={() => setShowWSLResourcesModal(false)} />}
      {showSetupWizard && <SetupWizardModal initialBackend={computerUseBackend} onClose={() => setShowSetupWizard(false)} />}
      {showSupabaseConfigPanel && <SupabaseConfigPanel onClose={() => setShowSupabaseConfigPanel(false)} />}
      {showAlignmentRulesPanel && <AlignmentRulesPanel onClose={() => setShowAlignmentRulesPanel(false)} />}
      {showRileyVoiceInstall && <RileyVoiceInstallModal onClose={() => setShowRileyVoiceInstall(false)} />}
    </>
  );
}

function ThemeCard({ theme, active, onClick }: { theme: ThemeMeta; active: boolean; onClick: () => void }) {
  const { bg, surface, accent, text } = theme.preview;
  return (
    <button
      onClick={onClick}
      className={`group relative flex flex-col gap-2 p-2 rounded-xl border transition-all ${
        active
          ? 'border-blue-500/50 bg-blue-500/8 shadow-[0_0_12px_rgba(59,130,246,0.12)]'
          : 'border-white/[0.06] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]'
      }`}
    >
      {/* Colour swatch: bg fill + accent strip + surface dot */}
      <div
        className="w-full rounded-lg overflow-hidden relative"
        style={{ aspectRatio: '4/3', background: bg }}
      >
        {/* Surface chip — top left */}
        <div
          className="absolute top-1.5 left-1.5 w-4 h-4 rounded-sm opacity-80"
          style={{ background: surface }}
        />
        {/* Text chip — top right */}
        <div
          className="absolute top-1.5 right-1.5 w-4 h-2 rounded-sm opacity-60"
          style={{ background: text }}
        />
        {/* Accent strip — bottom */}
        <div
          className="absolute bottom-0 left-0 right-0 h-[6px]"
          style={{ background: accent }}
        />
      </div>

      {/* Label */}
      <div className="text-center">
        <div className={`text-[10px] font-bold leading-none mb-0.5 transition-colors ${
          active ? 'text-blue-400' : 'text-white/50 group-hover:text-white/75'
        }`}>
          {theme.label}
        </div>
        <div className="text-[8px] text-white/20 leading-none truncate">{theme.description}</div>
      </div>

      {/* Active indicator */}
      {active && (
        <div className="absolute top-1.5 right-1.5 w-3.5 h-3.5 rounded-full bg-blue-500 flex items-center justify-center shadow-[0_0_6px_rgba(59,130,246,0.6)]">
          <Check className="w-2 h-2 text-white" strokeWidth={3} />
        </div>
      )}
    </button>
  );
}

function SettingsItem({ icon, label, description, onClick }: { icon: React.ReactNode, label: string, description: string, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-white/5 transition-all group"
    >
      <div className="p-2 rounded-lg bg-white/[0.02] border border-white/[0.03] group-hover:border-white/10 group-hover:bg-white/[0.06] transition-all">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-white/80 group-hover:text-white transition-colors">{label}</div>
        <div className="text-[10px] text-white/30 group-hover:text-white/50 transition-colors truncate">{description}</div>
      </div>
      <ChevronRight className="w-3 h-3 text-white/10 group-hover:text-white/30 transition-all group-hover:translate-x-0.5" />
    </button>
  );
}

function SettingsLink({ icon, label, href }: { icon: React.ReactNode, label: string, href: string }) {
  return (
    <Link 
      href={href}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left hover:bg-white/5 transition-all group"
    >
      <div className="p-1.5 rounded-lg transition-all group-hover:scale-110">
        {icon}
      </div>
      <div className="text-[13px] font-medium text-white/60 group-hover:text-white/90 transition-colors">{label}</div>
      <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
        <ChevronRight className="w-3 h-3 text-white/20" />
      </div>
    </Link>
  );
}
