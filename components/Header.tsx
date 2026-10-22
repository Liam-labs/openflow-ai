'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import {
  Activity, Settings, LayoutGrid, Globe, Server, Lock, FileText, Plus,
  Bot, Users2, HardDrive, Key, Cloud, Cpu, Monitor, MessageCircle,
  ChevronDown, Menu, X, PhoneCall
} from 'lucide-react';
import { TabType } from './TabNavigation';
import { useChatPanel } from '@/lib/contexts/ChatContext';
import { AgentRosterEntry, CollabChannel } from '@/lib/types';
import { SettingsDropdown } from './SettingsDropdown';
import { AlertsPanel } from './AlertsPanel';

import { getHomeDir } from '@/lib/home-dir';
import { PRODUCT_NAME } from '@/lib/brand';
interface HeaderProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  appCount: number;
  siteCount: number;
  serverCount: number;
  docsCount: number;
  onlineCount: number;
  onAddProject: () => void;
  collabChannelCount?: number;
}

const navItems: { id: TabType; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'apps', label: 'Apps', icon: LayoutGrid },
  { id: 'sites', label: 'Sites', icon: Globe },
  { id: 'servers', label: 'Systems', icon: Server },
  { id: 'docs', label: 'Docs', icon: FileText },
];

export function Header({
  activeTab,
  onTabChange,
  appCount,
  siteCount,
  serverCount,
  docsCount,
  onlineCount,
  onAddProject,
  collabChannelCount = 0,
}: HeaderProps) {
  const { openSession, sessions, isPanelOpen, openPanel } = useChatPanel();
  
  // Settings dropdown state
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

  // Mobile menu state
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Roster agents state
  const [agents, setAgents] = useState<AgentRosterEntry[]>([]);

  // Load agents on mount
  useEffect(() => {
    // Fetch all channels to aggregate agents
    fetch('/api/collab')
      .then(r => r.ok ? r.json() : null)
      .then((data: { channels?: CollabChannel[] } | null) => {
        if (data?.channels) {
          const allAgents: AgentRosterEntry[] = [];
          const seenIds = new Set<string>();
          
          data.channels.forEach(channel => {
            channel.roster?.agents?.forEach(agent => {
              if (!seenIds.has(agent.id) && (agent.status === 'running' || agent.status === 'starting')) {
                allAgents.push(agent);
                seenIds.add(agent.id);
              }
            });
          });
          setAgents(allAgents);
        }
      })
      .catch(() => {});
  }, []);

  const getCount = (tab: TabType) => {
    switch (tab) {
      case 'apps':       return appCount;
      case 'sites':      return siteCount;
      case 'servers':    return serverCount;
      case 'docs':       return docsCount;
    }
  };

  return (
    <>
      <header className="sticky top-0 z-50 py-4 px-4">
        {/* Desktop Navbar */}
        <div className="hidden md:flex items-center justify-between max-w-[1600px] mx-auto glass-pill px-5 py-2.5 shadow-2xl relative gap-2">
          
          {/* Left Section: Logo & Avatars */}
          <div className="flex-1 flex items-center gap-4 min-w-0">
            <div className="flex items-center gap-3 flex-shrink-0">
              <div className="relative group">
                <div className="absolute inset-0 bg-accent/30 blur-md rounded-full group-hover:bg-accent/50 transition-all" />
                <div className="relative p-1.5 rounded-lg bg-gradient-to-br from-accent/40 to-accent/10 border border-accent/20">
                  <Activity className="w-5 h-5 text-accent" />
                </div>
              </div>
              <div className="flex flex-col hidden sm:flex">
                <span className="text-sm font-bold tracking-tight text-white leading-tight">{PRODUCT_NAME}</span>
                <span className="text-[10px] text-white/40 font-mono leading-tight">{`${getHomeDir().split('/').filter(Boolean).pop() ?? 'home'}/SG-1`}</span>
              </div>
            </div>

            <div className="h-8 w-px bg-white/5 hidden lg:block flex-shrink-0" />

            {/* Avatar Stack */}
            <div className="flex items-center hidden xl:flex min-w-0">
              <div className="avatar-stack">
                {agents.slice(0, 5).map((agent) => (
                  <div 
                    key={agent.id} 
                    className="avatar-stack-item border-2 border-[#0a0a0a]"
                    style={{ backgroundColor: agent.color || '#3b82f6' }}
                    title={`${agent.name} (${agent.status})`}
                  >
                    {agent.name.charAt(0).toUpperCase()}
                  </div>
                ))}
                {agents.length > 5 && (
                  <div className="avatar-stack-item bg-white/10 text-white/60">
                    +{agents.length - 5}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Center Section: Navigation Pill */}
          <div className="flex-shrink-0 flex justify-center">
            <div className="navbar-pill-group">
              {/* Projects = AgentChat, the home page */}
              <Link href="/" className="nav-item-pill" title="Projects (AgentChat)">
                <Users2 className="w-4 h-4 text-white/40" />
                <span className="font-medium hidden lg:inline">Projects</span>
                {collabChannelCount > 0 && (
                  <span className="text-[10px] bg-blue-500/80 px-1.5 py-0.5 rounded-full text-white hidden sm:inline">
                    {collabChannelCount}
                  </span>
                )}
              </Link>
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                const count = getCount(item.id);

                return (
                  <button
                    key={item.id}
                    onClick={() => onTabChange(item.id)}
                    className={`nav-item-pill ${isActive ? 'active' : ''}`}
                  >
                    <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-white/40'}`} />
                    <span className="font-medium hidden lg:inline">{item.label}</span>
                    {count > 0 && !isActive && (
                      <span className="text-[10px] bg-white/10 px-1.5 py-0.5 rounded-full text-white/40 hidden sm:inline">
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right Section: Actions */}
          <div className="flex-1 flex items-center justify-end gap-3 min-w-0">
            {/* Status */}
            <div className="status-indicator hidden min-[1560px]:flex flex-shrink-0">
              <div className="status-dot-breathing" />
              <span>{onlineCount} Online</span>
            </div>

            <div className="flex items-center gap-1.5 bg-white/[0.03] p-1 rounded-full border border-white/[0.05] flex-shrink-0">
              <Link
                href="/vault"
                className="action-button-pill text-white/40 hover:text-white/80 hover:bg-white/10"
                title="Security Vault"
              >
                <Lock className="w-4 h-4" />
              </Link>
              <Link
                href="/gateway"
                className="action-button-pill text-white/40 hover:text-white/80 hover:bg-white/10"
                title="WebGate Entry"
              >
                <Cloud className="w-4 h-4" />
              </Link>
              <Link
                href="/backups"
                className="action-button-pill text-white/40 hover:text-white/80 hover:bg-white/10"
                title="System Backups"
              >
                <HardDrive className="w-4 h-4" />
              </Link>
              <Link
                href="/computer-use"
                className="action-button-pill text-white/40 hover:text-white/80 hover:bg-white/10"
                title="Computer Use"
              >
                <Monitor className="w-4 h-4" />
              </Link>

              <AlertsPanel />
            </div>

            <div className="h-6 w-px bg-white/5 mx-1 hidden sm:block flex-shrink-0" />

            <div className="relative flex-shrink-0" ref={settingsMenuRef}>
              <button
                onClick={() => setShowSettingsMenu(!showSettingsMenu)}
                className={`action-button-pill ${showSettingsMenu ? 'bg-white/15 text-white border-white/20' : ''}`}
                title="Settings"
              >
                <Settings className="w-4 h-4" />
              </button>

              <SettingsDropdown
                isOpen={showSettingsMenu}
                onClose={() => setShowSettingsMenu(false)}
                anchorRef={settingsMenuRef}
                onAddProject={onAddProject}
              />
            </div>
          </div>
        </div>

        {/* Mobile Top Bar */}
        <div className="md:hidden flex items-center justify-between glass-pill px-4 py-2 shadow-xl">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-accent" />
            <span className="font-bold text-sm">{PRODUCT_NAME}</span>
          </div>
          
          <div className="flex items-center gap-2">
            <button onClick={onAddProject} className="p-2 rounded-full bg-accent/10 text-accent" aria-label="Add project">
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="p-2 rounded-full bg-white/5 text-white/70"
              aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
            >
              {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Mobile Menu Overlay */}
        {isMobileMenuOpen && (
          <div className="fixed inset-0 z-[60] bg-[#0a0a0a]/95 backdrop-blur-xl p-6 md:hidden animate-in fade-in slide-in-from-top-4 duration-300">
            <div className="flex justify-between items-center mb-8">
              <div className="flex items-center gap-3">
                <Activity className="w-6 h-6 text-accent" />
                <span className="text-xl font-bold">Menu</span>
              </div>
              <button onClick={() => setIsMobileMenuOpen(false)} className="p-2 rounded-full bg-white/5">
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-8">
              <button onClick={() => { onTabChange('apps'); setIsMobileMenuOpen(false); }} className={`flex flex-col items-center gap-2 p-4 rounded-2xl border ${activeTab === 'apps' ? 'bg-accent/10 border-accent/30 text-accent' : 'bg-white/5 border-white/10 text-white/60'}`}>
                <LayoutGrid className="w-6 h-6" /> <span className="text-xs font-medium">Apps</span>
              </button>
              <button onClick={() => { onTabChange('sites'); setIsMobileMenuOpen(false); }} className={`flex flex-col items-center gap-2 p-4 rounded-2xl border ${activeTab === 'sites' ? 'bg-accent/10 border-accent/30 text-accent' : 'bg-white/5 border-white/10 text-white/60'}`}>
                <Globe className="w-6 h-6" /> <span className="text-xs font-medium">Sites</span>
              </button>
              <button onClick={() => { onTabChange('servers'); setIsMobileMenuOpen(false); }} className={`flex flex-col items-center gap-2 p-4 rounded-2xl border ${activeTab === 'servers' ? 'bg-accent/10 border-accent/30 text-accent' : 'bg-white/5 border-white/10 text-white/60'}`}>
                <Server className="w-6 h-6" /> <span className="text-xs font-medium">Systems</span>
              </button>
              <button onClick={() => { onTabChange('docs'); setIsMobileMenuOpen(false); }} className={`flex flex-col items-center gap-2 p-4 rounded-2xl border ${activeTab === 'docs' ? 'bg-accent/10 border-accent/30 text-accent' : 'bg-white/5 border-white/10 text-white/60'}`}>
                <FileText className="w-6 h-6" /> <span className="text-xs font-medium">Docs</span>
              </button>
            </div>

            <div className="space-y-3">
              <Link href="/" className="flex items-center gap-3 p-4 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-300">
                <Users2 className="w-5 h-5" /> <span>Projects</span>
                {collabChannelCount > 0 && <span className="ml-auto bg-blue-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">{collabChannelCount}</span>}
              </Link>
              <button 
                onClick={() => { 
                  setShowSettingsMenu(true); 
                  setIsMobileMenuOpen(false); 
                }} 
                className="w-full flex items-center gap-3 p-4 rounded-2xl bg-white/5 border border-white/10 text-white/70 text-left"
              >
                <Settings className="w-5 h-5" /> <span>Settings & Tools</span>
              </button>
            </div>
          </div>
        )}
      </header>

      {/* Mobile Bottom Navigation (Floating) */}
      <div className="md:hidden mobile-bottom-nav">
        <div className="navbar-pill-group px-2 py-1.5 shadow-2xl scale-110">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`flex flex-col items-center justify-center w-16 py-1 rounded-full transition-all ${isActive ? 'bg-accent/20 text-accent' : 'text-white/40'}`}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[9px] font-bold mt-0.5 uppercase tracking-tighter">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Global Settings Dropdown for Mobile (rendered when opened from menu) */}
      <div className="md:hidden">
        <SettingsDropdown
          isOpen={showSettingsMenu && !isMobileMenuOpen}
          onClose={() => setShowSettingsMenu(false)}
          anchorRef={settingsMenuRef}
          onAddProject={onAddProject}
        />
      </div>
    </>
  );
}
