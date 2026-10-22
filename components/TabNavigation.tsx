'use client';

import { LayoutGrid, Globe, Server, FileText } from 'lucide-react';

export type TabType = 'apps' | 'sites' | 'servers' | 'docs';

interface TabNavigationProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  appCount: number;
  siteCount: number;
  serverCount: number;
  docsCount: number;
}

const tabs: { id: TabType; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'apps', label: 'Apps', icon: LayoutGrid },
  { id: 'sites', label: 'Sites', icon: Globe },
  { id: 'servers', label: 'Systems', icon: Server },
  { id: 'docs', label: 'Docs', icon: FileText },
];

export function TabNavigation({
  activeTab,
  onTabChange,
  appCount,
  siteCount,
  serverCount,
  docsCount,
}: TabNavigationProps) {
  const getCounts = (tab: TabType): number => {
    switch (tab) {
      case 'apps':       return appCount;
      case 'sites':      return siteCount;
      case 'servers':    return serverCount;
      case 'docs':       return docsCount;
    }
  };

  return (
    <nav className="tab-nav">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const count = getCounts(tab.id);
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`tab-item ${isActive ? 'active' : ''}`}
          >
            <span className="flex items-center gap-2">
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
              {count > 0 && (
                <span className="text-xs opacity-60">({count})</span>
              )}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
