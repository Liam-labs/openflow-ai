'use client';

import React, { useState, useCallback, useEffect } from 'react';
import {
  LayoutGrid, Server, Activity, Clock, Cpu, Shield, Database,
  Network, Link2, Layers, Puzzle, AlertCircle, HeartPulse, ScrollText, Menu, Brain, HardDrive, FolderSync, Smartphone, ShieldCheck,
} from 'lucide-react';
import { SupabaseSection } from './SupabaseSection';
import { SystemsSidebar } from './SystemsSidebar';
import { SystemsBreadcrumb } from './SystemsBreadcrumb';
import { SystemsTabStrip } from './SystemsTabStrip';
import { SystemsContextPanel } from './SystemsContextPanel';
import { ServicesSection } from './ServicesSection';
import { ProcessesSection } from './ProcessesSection';
import { ServiceDetail } from './ServiceDetail';
import { SystemsOverview } from './SystemsOverview';
import { ScheduledJobsSection } from './ScheduledJobsSection';
import { AITasksSection } from './AITasksSection';
import { ScheduledJobDetail } from './ScheduledJobDetail';
import { AITaskDetail } from './AITaskDetail';
import { WatchdogSection } from './WatchdogSection';
import { MemoryProtectionSection } from './MemoryProtectionSection';
import { PortRegistrySection } from './PortRegistrySection';
import { FirewallSection } from './FirewallSection';
import { PROVIDER_PREFIX } from './connections/provider-link';
import { ConnectionsSection } from './ConnectionsSection';
import { BridgesSection } from './BridgesSection';
import { ConnectionDetail } from './ConnectionDetail';
import { BridgeDetail } from './BridgeDetail';
import { ErrorMonitorSection } from './ErrorMonitorSection';
import { ProcessHealthPanel } from './ProcessHealthPanel';
import { LogsSection } from './LogsSection';
import { LocalAISection } from './LocalAISection';
import { MCPServersSection } from './MCPServersSection';
import { ModelsSection } from './ModelsSection';
import { ModelDetail } from './ModelDetail';
import { DiskManagementSection } from './DiskManagementSection';
import { DirectorySyncSection } from './DirectorySyncSection';
import { AndroidStudioSection } from './AndroidStudioSection';
import { SectionErrorBoundary } from './SectionErrorBoundary';
import { SystemsTopbarStatus } from './SystemsTopbarStatus';
import type { SystemsNavState, EntityTab, ContextPanelEntity, ServiceTab, SupabaseTab, ModelTab } from './systems-types';
import { SECTION_LABELS } from './systems-types';

const NARROW_BREAKPOINT = 1024;

const SECTION_ICONS: Partial<Record<SystemsNavState['section'], React.ReactNode>> = {
  overview:          <LayoutGrid size={16} />,
  services:          <Server size={16} />,
  processes:         <Activity size={16} />,
  'scheduled-jobs':  <Clock size={16} />,
  'ai-tasks':        <Cpu size={16} />,
  watchdog:          <Shield size={16} />,
  memory:            <Database size={16} />,
  ports:             <Network size={16} />,
  firewall:          <ShieldCheck size={16} />,
  connections:       <Link2 size={16} />,
  bridges:           <Layers size={16} />,
  mcp:               <Puzzle size={16} />,
  models:            <Cpu size={16} />,
  errors:            <AlertCircle size={16} />,
  'process-health':  <HeartPulse size={16} />,
  logs:              <ScrollText size={16} />,
  supabase:          <Database size={16} />,
  'local-ai':        <Brain size={16} />,
  disk:              <HardDrive size={16} />,
  'directory-sync':  <FolderSync size={16} />,
  'android-studio': <Smartphone size={16} />,
};
const MOBILE_BREAKPOINT = 768;

interface SystemsPageProps {
  onProcessCountChange?: (count: number) => void;
  refreshInterval?: number;
}

const DEFAULT_NAV: SystemsNavState = { section: 'overview' };

function readNavFromHash(): SystemsNavState {
  if (typeof window === 'undefined') return DEFAULT_NAV;
  const raw = window.location.hash;
  // Format: #systems/section[/entityId[/tab]]
  const match = raw.match(/^#systems\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?/);
  if (!match) return DEFAULT_NAV;
  const [, section, entityId, tab] = match;
  return {
    section: (section as SystemsNavState['section']) || 'overview',
    entityId: entityId || undefined,
    entityType: section === 'connections' && entityId?.startsWith(PROVIDER_PREFIX) ? 'connection' : undefined,
    tab: (tab as EntityTab) || undefined,
  } as SystemsNavState;
}

function writeNavToHash(nav: SystemsNavState) {
  if (typeof window === 'undefined') return;
  const parts: string[] = ['#systems', nav.section];
  if (nav.entityId) parts.push(nav.entityId);
  if (nav.entityId && nav.tab) parts.push(nav.tab);
  window.history.replaceState(window.history.state, '', parts.join('/'));
}

async function pm2Action(action: 'start' | 'stop' | 'restart', name: string, port?: number) {
  await fetch('/api/pm2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, target: name, ...(port ? { port } : {}) }),
  });
}

export function SystemsPage({ onProcessCountChange, refreshInterval }: SystemsPageProps) {
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280
  );

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    const saved = localStorage.getItem('systems-sidebar-collapsed');
    if (saved !== null) return saved === 'true';
    return window.innerWidth < NARROW_BREAKPOINT;
  });

  const [navState, setNavState] = useState<SystemsNavState>(readNavFromHash);
  const [contextEntity, setContextEntity] = useState<ContextPanelEntity | null>(null);
  const [contextVisible, setContextVisible] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Responsive: auto-collapse sidebar on mobile
  useEffect(() => {
    const handler = () => {
      const w = window.innerWidth;
      setWindowWidth(w);
      if (w < MOBILE_BREAKPOINT) setSidebarCollapsed(true);
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // Sync nav state → hash URL
  useEffect(() => {
    writeNavToHash(navState);
  }, [navState]);

  // Browser back/forward support
  useEffect(() => {
    const handler = () => setNavState(readNavFromHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      localStorage.setItem('systems-sidebar-collapsed', String(next));
      return next;
    });
  }, []);

  const navigate = useCallback((partial: Partial<SystemsNavState>) => {
    setNavState(prev => {
      // Clear entity context when changing sections
      if (partial.section && partial.section !== prev.section) {
        setContextEntity(null);
        setContextVisible(false);
      }
      return { ...prev, ...partial };
    });
    setMobileNavOpen(false); // close mobile nav on navigation
  }, []);

  const onTabChange = useCallback((tab: EntityTab) => {
    setNavState(prev => ({ ...prev, tab }));
  }, []);

  const onEntitySelect = useCallback((entity: ContextPanelEntity) => {
    setContextEntity(entity);
    setContextVisible(true);
  }, []);

  // Hide context panel on narrow screens or when in entity detail view
  const isNarrow = windowWidth < NARROW_BREAKPOINT;
  const showContextPanel = contextVisible && contextEntity !== null && !navState.entityId && !isNarrow;
  const isDetailView = !!navState.entityId;

  return (
    <div
      className="systems-page"
      style={{
        '--systems-sidebar-width': sidebarCollapsed ? '56px' : '240px',
        '--systems-context-width': showContextPanel ? '280px' : '0px',
      } as React.CSSProperties}
    >
      {/* Mobile nav backdrop */}
      {mobileNavOpen && (
        <div
          className="systems-mobile-backdrop"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <SystemsSidebar
        navState={navState}
        collapsed={sidebarCollapsed}
        onNavigate={navigate}
        onToggleCollapse={handleToggleSidebar}
        mobileOpen={mobileNavOpen}
      />

      <div className="systems-main">
        <div className="systems-topbar">
          <div className="systems-topbar__header">
            {/* Mobile hamburger */}
            <button
              className="systems-topbar__mobile-menu"
              onClick={() => setMobileNavOpen(v => !v)}
              aria-label="Toggle navigation"
            >
              <Menu size={18} />
            </button>
            <span className="systems-topbar__icon">
              {SECTION_ICONS[navState.section] ?? <LayoutGrid size={16} />}
            </span>
            <h1 className="systems-topbar__heading">
              {navState.section === 'overview' ? 'Systems' : SECTION_LABELS[navState.section]}
            </h1>
            <div className="systems-topbar__status">
              <SystemsTopbarStatus />
            </div>
          </div>
          {(navState.section !== 'overview' || navState.entityId) && (
            <SystemsBreadcrumb navState={navState} onNavigate={navigate} />
          )}
        </div>

        {navState.entityType && !(navState.section === 'connections' && navState.entityId?.startsWith(PROVIDER_PREFIX)) && (
          <SystemsTabStrip navState={navState} onTabChange={onTabChange} />
        )}

        <main className={`systems-content${isDetailView ? ' systems-content--detail' : ''}`}>
          <div
            key={`${navState.section}-${navState.entityId ?? ''}`}
            className={`systems-section-enter${isDetailView ? ' systems-section-enter--fill' : ''}`}
          >
            <SectionErrorBoundary sectionName={navState.section}>
              <SystemsSectionRouter
                navState={navState}
                onNavigate={navigate}
                onEntitySelect={onEntitySelect}
                onProcessCountChange={onProcessCountChange}
                refreshInterval={refreshInterval}
              />
            </SectionErrorBoundary>
          </div>
        </main>
      </div>

      <SystemsContextPanel
        entity={contextEntity}
        visible={showContextPanel}
        onClose={() => setContextVisible(false)}
        onStart={(id) => { if (contextEntity) pm2Action('start', contextEntity.name, contextEntity.port); else pm2Action('start', id); }}
        onStop={(id) => { if (contextEntity) pm2Action('stop', contextEntity.name); else pm2Action('stop', id); }}
        onRestart={(id) => { if (contextEntity) pm2Action('restart', contextEntity.name); else pm2Action('restart', id); }}
        onViewDetails={(entity) => {
          const section = entity.type === 'service' ? 'services' : 'processes';
          navigate({ section, entityId: entity.id, entityType: entity.type, tab: undefined });
        }}
      />
    </div>
  );
}

// Section router
function SystemsSectionRouter({
  navState,
  onNavigate,
  onEntitySelect,
  onProcessCountChange,
  refreshInterval,
}: {
  navState: SystemsNavState;
  onNavigate: (partial: Partial<SystemsNavState>) => void;
  onEntitySelect: (entity: ContextPanelEntity) => void;
  onProcessCountChange?: (count: number) => void;
  refreshInterval?: number;
}) {
  void refreshInterval;

  // ── Entity detail routes ──
  if (navState.entityId) {
    switch (navState.section) {
      case 'services':
        return (
          <ServiceDetail
            serviceId={navState.entityId}
            tab={(navState.tab as ServiceTab) ?? 'overview'}
            onTabChange={(tab) => onNavigate({ tab })}
            onBack={() => onNavigate({ section: 'services', entityId: undefined, entityType: undefined, tab: undefined })}
          />
        );
      case 'scheduled-jobs':
        return (
          <ScheduledJobDetail
            jobId={navState.entityId}
            initialTab={navState.tab ?? 'overview'}
            onNavigate={onNavigate}
          />
        );
      case 'ai-tasks':
        return (
          <AITaskDetail
            taskId={navState.entityId}
            initialTab={navState.tab ?? 'output'}
            onNavigate={onNavigate}
          />
        );
      case 'connections':
      case 'mcp':
        return (
          <ConnectionDetail
            connectionId={navState.entityId}
            isMcp={navState.entityType === 'mcp-server'}
          />
        );
      case 'bridges':
        return <BridgeDetail bridgeId={navState.entityId} />;
      case 'models':
        return (
          <ModelDetail
            modelId={navState.entityId}
            tab={(navState.tab as ModelTab) ?? 'overview'}
            onTabChange={(tab) => onNavigate({ tab })}
            onBack={() => onNavigate({ section: 'models', entityId: undefined, entityType: undefined, tab: undefined })}
            onNavigate={onNavigate}
          />
        );
      default:
        break;
    }
  }

  // ── Section list routes ──
  switch (navState.section) {
    case 'overview':
      return <SystemsOverview onNavigate={onNavigate} />;
    case 'services':
      return <ServicesSection onNavigate={onNavigate} onEntitySelect={onEntitySelect} />;
    case 'processes':
      return <ProcessesSection onNavigate={onNavigate} onEntitySelect={onEntitySelect} onProcessCountChange={onProcessCountChange} />;
    case 'scheduled-jobs':
      return <ScheduledJobsSection onNavigate={onNavigate} />;
    case 'ai-tasks':
      return <AITasksSection onNavigate={onNavigate} />;
    case 'watchdog':
      return <WatchdogSection />;
    case 'memory':
      return <MemoryProtectionSection />;
    case 'ports':
      return <PortRegistrySection />;
    case 'firewall':
      return <FirewallSection />;
    case 'connections':
      return <ConnectionsSection onNavigate={onNavigate} />;
    case 'bridges':
      return <BridgesSection onNavigate={onNavigate} />;
    case 'mcp':
      return <MCPServersSection />;
    case 'models':
      return <ModelsSection onNavigate={onNavigate} />;
    case 'errors':
      return <ErrorMonitorSection />;
    case 'process-health':
      return <ProcessHealthPanel />;
    case 'logs':
      return <LogsSection />;
    case 'local-ai':
      return <LocalAISection />;
    case 'disk':
      return <DiskManagementSection />;
    case 'directory-sync':
      return <DirectorySyncSection />;
    case 'android-studio':
      return <AndroidStudioSection />;
    case 'supabase':
      // navState.entityId may be a real instance UUID or a backup-script slug
      // (ServiceAlertsPanel emits slugs). SupabaseSection resolves either.
      return (
        <SupabaseSection
          initialInstanceId={navState.entityId}
          initialTab={navState.tab as SupabaseTab | undefined}
        />
      );
    default:
      return (
        <div className="systems-empty-section">
          <div className="systems-empty-section__label">{navState.section}</div>
          <p className="systems-empty-section__hint">Not yet available</p>
        </div>
      );
  }
}
