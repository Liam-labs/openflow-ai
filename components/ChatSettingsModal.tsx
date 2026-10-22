'use client';

import React from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Settings,
  X,
  FolderOpen,
  Layers,
  Shield,
  SpellCheck,
  Volume2,
  VolumeX,
  EyeOff,
  Mic,
  Sparkles,
} from 'lucide-react';
import { ScaffoldingFilesPanel } from './ScaffoldingFilesPanel';
import { AnchorRulesPanel } from './AnchorRulesPanel';
import { ToolsPanel } from './ToolsPanel';
import { StructurePromptPanel } from './StructurePromptPanel';
import { RILEY_VOICE_ENABLED } from './RileyVoiceEnabled';

type ChatSettingsTab = 'general' | 'scaffolding' | 'tools' | 'anchor' | 'structure';

export interface ChatSettingsModalProps {
  onClose: () => void;
  chatSettingsTab: ChatSettingsTab;
  setChatSettingsTab: (tab: ChatSettingsTab) => void;
  spellcheckEnabled: boolean;
  setSpellcheckEnabled: (updater: (v: boolean) => boolean) => void;
  setSpellcheckResults: (results: Array<{ word: string; isCorrect: boolean; suggestions: string[] }>) => void;
  soundEnabled: boolean;
  toggleSound: () => void;
  showSilentMessages: boolean;
  toggleSilentMessages: () => void;
}

export function ChatSettingsModal({
  onClose,
  chatSettingsTab,
  setChatSettingsTab,
  spellcheckEnabled,
  setSpellcheckEnabled,
  setSpellcheckResults,
  soundEnabled,
  toggleSound,
  showSilentMessages,
  toggleSilentMessages,
}: ChatSettingsModalProps) {
  return (
    <>
      <div
        className="fixed inset-0 z-10"
        onClick={onClose}
      />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 w-[1600px] max-w-[96vw] bg-[#0a1428]/80 backdrop-blur-3xl border border-white/10 rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col" style={{ height: '82vh', maxHeight: '92vh' }}>

        {/* ── Header ── */}
        <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-500/20 border border-blue-400/30 flex items-center justify-center">
              <Settings className="w-5 h-5 text-blue-300" />
            </div>
            <div>
              <p className="text-[15px] font-semibold text-white leading-none">Settings</p>
              <p className="text-xs text-white/60 mt-1">Agent chat configuration</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/10 text-white/50 hover:text-white/90 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Mobile tab bar (small screens only) ── */}
        <div className="flex sm:hidden border-b border-white/10 overflow-x-auto flex-shrink-0">
          {([
            { id: 'general', label: 'General', icon: Settings },
            { id: 'scaffolding', label: 'Scaffolding', icon: FolderOpen },
            { id: 'tools', label: 'Tools', icon: Layers },
            { id: 'anchor', label: 'Anchor', icon: Shield },
            { id: 'structure', label: 'Enhance', icon: Sparkles },
          ] as { id: ChatSettingsTab; label: string; icon: React.ElementType }[]).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => { setChatSettingsTab(id); }}
              className={`flex-shrink-0 flex items-center gap-1.5 px-4 py-3 text-xs font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                chatSettingsTab === id
                  ? 'border-blue-400 text-white/95'
                  : 'border-transparent text-white/45 hover:text-white/75'
              }`}
            >
              <Icon className="w-3.5 h-3.5 flex-shrink-0" />
              {label}
            </button>
          ))}
        </div>

        {/* ── Body: sidebar + content ── */}
        <div className="flex flex-1 min-h-0 flex-col sm:flex-row">

          {/* Left nav sidebar — desktop only */}
          <nav className="hidden sm:flex w-52 flex-shrink-0 border-r border-white/5 bg-white/[0.02] py-3 flex-col gap-0.5 px-2">
            {([
              { id: 'general',     label: 'General',      icon: Settings    },
              { id: 'scaffolding', label: 'Scaffolding',   icon: FolderOpen  },
              { id: 'tools',       label: 'Tools',         icon: Layers      },
              { id: 'anchor',      label: 'Anchor Rules',  icon: Shield      },
              { id: 'structure',   label: 'Enhance',       icon: Sparkles    },
            ] as { id: ChatSettingsTab; label: string; icon: React.ElementType }[]).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => { setChatSettingsTab(id); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left ${
                  chatSettingsTab === id
                    ? 'bg-blue-500/20 text-blue-200 border border-blue-500/30'
                    : 'text-white/55 hover:text-white/85 hover:bg-white/[0.06] border border-transparent'
                }`}
              >
                <Icon className={`w-4 h-4 flex-shrink-0 ${chatSettingsTab === id ? 'text-blue-300' : 'text-white/50'}`} />
                {label}
              </button>
            ))}
          </nav>

          {/* Right content area */}
          <div className="flex-1 overflow-y-auto min-h-0 px-4 py-5 sm:px-7 sm:py-6">

            {/* ── General ── */}
            {chatSettingsTab === 'general' && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-base font-semibold text-white mb-1">General</h2>
                  <p className="text-[13px] text-white/60 leading-relaxed">Control how the chat input behaves and how you receive notifications. Changes take effect immediately.</p>
                </div>
                <div className="h-px bg-white/10" />
                <div className="space-y-3">
                  {/* Riley Voice setup */}
                  {RILEY_VOICE_ENABLED && (
                    <Link
                      href="/riley-voice"
                      onClick={onClose}
                      className="flex items-center justify-between px-4 py-4 rounded-xl bg-blue-500/10 border border-blue-400/25 hover:bg-blue-500/15 hover:border-blue-400/40 transition-colors group"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-9 h-9 rounded-xl bg-blue-500/20 border border-blue-400/30 flex items-center justify-center flex-shrink-0">
                          <Mic className="text-blue-300" style={{ width: 18, height: 18 }} />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-white">Riley Voice setup</p>
                          <p className="text-[12px] text-white/55 mt-0.5">Configure wake listening and Riley’s speech</p>
                        </div>
                      </div>
                      <ArrowRight className="w-4 h-4 text-blue-300/70 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                    </Link>
                  )}

                  {/* Spell check */}
                  <div className="flex items-center justify-between px-4 py-4 rounded-xl bg-white/[0.05] border border-white/10 hover:bg-white/[0.08] transition-colors">
                    <div className="flex items-center gap-4">
                      <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center flex-shrink-0">
                        <SpellCheck className="w-4.5 h-4.5 text-amber-400" style={{ width: 18, height: 18 }} />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-white">Spell check</p>
                        <p className="text-[12px] text-white/55 mt-0.5">Underline misspelled words as you type</p>
                      </div>
                    </div>
                    <button
                      onClick={() => { setSpellcheckEnabled(v => !v); setSpellcheckResults([]); }}
                      className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${spellcheckEnabled ? 'bg-amber-500' : 'bg-white/20'}`}
                    >
                      <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full bg-white shadow transition-transform ${spellcheckEnabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
                    </button>
                  </div>

                  {/* Sound notifications */}
                  <div className="flex items-center justify-between px-4 py-4 rounded-xl bg-white/[0.05] border border-white/10 hover:bg-white/[0.08] transition-colors">
                    <div className="flex items-center gap-4">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${soundEnabled ? 'bg-blue-500/15 border border-blue-500/25' : 'bg-red-500/10 border border-red-500/20'}`}>
                        {soundEnabled ? <Volume2 style={{ width: 18, height: 18 }} className="text-blue-300" /> : <VolumeX style={{ width: 18, height: 18 }} className="text-red-400" />}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-white">Sound notifications</p>
                        <p className="text-[12px] text-white/55 mt-0.5">Play a tone when new messages arrive</p>
                      </div>
                    </div>
                    <button
                      onClick={toggleSound}
                      className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${soundEnabled ? 'bg-blue-500' : 'bg-white/20'}`}
                    >
                      <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full bg-white shadow transition-transform ${soundEnabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
                    </button>
                  </div>

                  {/* Show hidden messages */}
                  <div className="flex items-center justify-between px-4 py-4 rounded-xl bg-white/[0.05] border border-white/10 hover:bg-white/[0.08] transition-colors">
                    <div className="flex items-center gap-4">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
                        showSilentMessages
                          ? 'bg-purple-500/15 border border-purple-500/25'
                          : 'bg-white/5 border border-white/10'
                      }`}>
                        <EyeOff style={{ width: 18, height: 18 }} className={showSilentMessages ? 'text-purple-300' : 'text-white/40'} />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-white">Show hidden messages</p>
                        <p className="text-[12px] text-white/55 mt-0.5">Display silent system messages in the chat view</p>
                      </div>
                    </div>
                    <button
                      onClick={toggleSilentMessages}
                      className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${
                        showSilentMessages ? 'bg-purple-500' : 'bg-white/20'
                      }`}
                    >
                      <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                        showSilentMessages ? 'translate-x-6' : 'translate-x-0.5'
                      }`} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Scaffolding ── */}
            {chatSettingsTab === 'scaffolding' && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-base font-semibold text-white mb-1">Scaffolding</h2>
                  <p className="text-[13px] text-white/60 leading-relaxed">Template files automatically deployed to new agent working directories when agents are provisioned. Changes here affect all future agent spawns.</p>
                </div>
                <div className="h-px bg-white/10" />
                <ScaffoldingFilesPanel />
              </div>
            )}

            {/* ── Tools ── */}
            {chatSettingsTab === 'tools' && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-base font-semibold text-white mb-1">Tools Library</h2>
                  <p className="text-[13px] text-white/60 leading-relaxed">Manage the tool guides available to agents. Each entry provides context and usage instructions that agents receive when working in this environment. Add, edit, or reorder tools to shape how agents interact with your stack.</p>
                </div>
                <div className="h-px bg-white/10" />
                <ToolsPanel />
              </div>
            )}

            {/* ── Anchor ── */}
            {chatSettingsTab === 'anchor' && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-base font-semibold text-white mb-1">Anchor Rules</h2>
                  <p className="text-[13px] text-white/60 leading-relaxed">Behavioural rules injected into every agent prompt automatically. These act as a persistent anchor — rules you enable here apply to all agents across all channels. Enable, disable, reorder, and edit rules as your needs evolve.</p>
                </div>
                <div className="h-px bg-white/10" />
                <AnchorRulesPanel />
              </div>
            )}

            {/* ── Structure ── */}
            {chatSettingsTab === 'structure' && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-base font-semibold text-white mb-1">Enhance</h2>
                  <p className="text-[13px] text-white/60 leading-relaxed">The Enhance button runs your draft message through an AI enhancement pass before sending. Tune the guide it follows, choose the model, or switch the feature off.</p>
                </div>
                <div className="h-px bg-white/10" />
                <StructurePromptPanel />
              </div>
            )}

          </div>
        </div>
      </div>
    </>
  );
}
