'use client';

import React, { useRef, useCallback } from 'react';
import {
  ChevronLeft, ChevronRight,
  LayoutGrid, Server, Activity, Clock, Cpu,
  Shield, Database, Network, HeartPulse, ScrollText,
  Link2, Layers, Puzzle, Brain, HardDrive, FolderSync, Smartphone, ShieldCheck,
} from 'lucide-react';
import type { SystemsNavState, SystemsSection } from './systems-types';

interface NavItem {
  id: SystemsSection;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: '',
    items: [
      { id: 'overview',   label: 'Overview',   icon: <LayoutGrid size={16} /> },
      { id: 'services',   label: 'Services',   icon: <Server size={16} /> },
      { id: 'processes',  label: 'Processes',  icon: <Activity size={16} /> },
    ],
  },
  {
    label: 'Automation',
    items: [
      { id: 'scheduled-jobs',  label: 'Scheduled Jobs',  icon: <Clock size={16} /> },
      { id: 'ai-tasks',        label: 'AI Tasks',         icon: <Cpu size={16} /> },
      { id: 'directory-sync',  label: 'Directory Sync',   icon: <FolderSync size={16} /> },
      { id: 'android-studio',  label: 'Android Studio',   icon: <Smartphone size={16} /> },
      { id: 'local-ai',        label: 'Local AI',         icon: <Brain size={16} /> },
    ],
  },
  {
    label: 'Monitoring',
    items: [
      { id: 'watchdog',        label: 'Watchdog',        icon: <Shield size={16} /> },
      { id: 'memory',          label: 'Memory',          icon: <Database size={16} /> },
      { id: 'ports',           label: 'Ports',           icon: <Network size={16} /> },
      { id: 'firewall',        label: 'Firewall',        icon: <ShieldCheck size={16} /> },
      { id: 'process-health',  label: 'Process Health',  icon: <HeartPulse size={16} /> },
      { id: 'logs',            label: 'Logs',            icon: <ScrollText size={16} /> },
      { id: 'disk',            label: 'Disk Management', icon: <HardDrive size={16} /> },
    ],
  },
  {
    label: 'AI Infrastructure',
    items: [
      { id: 'models', label: 'Models',      icon: <Cpu size={16} /> },
      { id: 'mcp',    label: 'MCP Gateway', icon: <Puzzle size={16} /> },
    ],
  },
  {
    label: 'Integrations',
    items: [
      { id: 'connections', label: 'Connections', icon: <Link2 size={16} /> },
      { id: 'bridges',     label: 'Bridges',     icon: <Layers size={16} /> },
    ],
  },
  {
    label: 'Databases',
    items: [
      { id: 'supabase', label: 'Supabase', icon: <Database size={16} /> },
    ],
  },
];

interface SystemsSidebarProps {
  navState: SystemsNavState;
  collapsed: boolean;
  onNavigate: (partial: Partial<SystemsNavState>) => void;
  onToggleCollapse: () => void;
  mobileOpen?: boolean;
}

export function SystemsSidebar({
  navState,
  collapsed,
  onNavigate,
  onToggleCollapse,
  mobileOpen = false,
}: SystemsSidebarProps) {
  const navRef = useRef<HTMLElement>(null);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (!navRef.current) return;
    const items = Array.from(
      navRef.current.querySelectorAll<HTMLButtonElement>('.systems-sidebar__item')
    );
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(idx + 1, items.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(idx - 1, 0)]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  }, []);

  return (
    <aside
      className={`systems-sidebar${collapsed ? ' systems-sidebar--collapsed' : ''}${mobileOpen ? ' systems-sidebar--mobile-open' : ''}`}
      aria-label="Systems navigation"
    >
      <nav ref={navRef} className="systems-sidebar__nav" onKeyDown={handleKeyDown}>
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className="systems-sidebar__group">
            {group.label && !collapsed && (
              <div className="systems-sidebar__group-label">{group.label}</div>
            )}
            {group.items.map((item) => {
              const isActive = navState.section === item.id;
              return (
                <button
                  key={item.id}
                  className={`systems-sidebar__item${isActive ? ' systems-sidebar__item--active' : ''}`}
                  onClick={() =>
                    onNavigate({
                      section: item.id,
                      entityId: undefined,
                      entityType: undefined,
                      tab: undefined,
                    })
                  }
                  aria-label={item.label}
                  title={collapsed ? item.label : undefined}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="systems-sidebar__item-icon">{item.icon}</span>
                  {!collapsed && (
                    <span className="systems-sidebar__item-label">{item.label}</span>
                  )}
                  {!collapsed && item.badge !== undefined && (
                    <span className="systems-sidebar__badge">{item.badge}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <button
        className="systems-sidebar__collapse-btn"
        onClick={onToggleCollapse}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>
    </aside>
  );
}
