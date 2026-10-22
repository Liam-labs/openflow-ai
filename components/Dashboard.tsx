'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { Project, ProjectHealthStatus, ConfigSettings, ServerStatus, PortInfo } from '@/lib/types';
import { Header } from './Header';
import { TabType } from './TabNavigation';
import { AppLibrary } from './AppLibrary';
import { SiteCard } from './SiteCard';
import { DocsPanel } from './DocsPanel';
import { SystemsPage } from './systems/SystemsPage';
import { AddProjectModal } from './AddProjectModal';
import { OnboardingCard } from './OnboardingCard';
import { LoopsFloatingIndicator } from './LoopsFloatingIndicator';
import { CatalogHealthWidget } from './CatalogHealthWidget';
import { SprintProgressWidget } from './SprintProgressWidget';
import { useEventStreamContext } from '@/lib/contexts/EventStreamContext';
import { Loader2, Globe, ArrowRight, Activity, Shield } from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/brand';

export function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [healthStatuses, setHealthStatuses] = useState<
    Record<string, ProjectHealthStatus>
  >({});
  const [serverStatuses, setServerStatuses] = useState<
    Record<string, ServerStatus>
  >({});
  const [activePorts, setActivePorts] = useState<PortInfo[]>([]);
  const [settings, setSettings] = useState<ConfigSettings>({
    refreshInterval: 2000,
    defaultCategory: 'all',
  });

  // SSE: subscribe to push events for health status and ports
  const eventStream = useEventStreamContext();
  useEffect(() => {
    return eventStream.subscribe<{ statuses: Record<string, ProjectHealthStatus> }>(
      'health:status',
      (data) => {
        if (data?.statuses) {
          setHealthStatuses(data.statuses);
        }
      }
    );
  }, [eventStream]);

  useEffect(() => {
    return eventStream.subscribe<{ ports: PortInfo[] }>(
      'ports:change',
      (data) => {
        if (data?.ports) {
          setActivePorts(data.ports);
        }
      }
    );
  }, [eventStream]);
  const [isLoading, setIsLoading] = useState(true);
  // The dashboard is the Operations hub (/operations): it always opens on Systems.
  const [activeTab, setActiveTab] = useState<TabType>('servers');
  const [docsCount, setDocsCount] = useState(0);
  const [pm2Count, setPm2Count] = useState(0);
  const [appCount, setAppCount] = useState(0);
  const [showAddProject, setShowAddProject] = useState(false);
  const [collabChannelCount, setCollabChannelCount] = useState(0);
  const [showOnboarding, setShowOnboarding] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('devflow-onboarding-dismissed') !== 'true';
  });
  const [onboardingUser, setOnboardingUser] = useState<{ name?: string; teamName?: string }>({});

  // Guard against overlapping polling rounds (prevents ERR_INSUFFICIENT_RESOURCES)
  const isPollingServersRef = useRef(false);

  const sites = projects.filter((p) => p.category === 'site');

  const fetchProjects = useCallback(async () => {
    try {
      const response = await fetch('/api/projects');
      const data = await response.json();
      setProjects(data.projects);
      setSettings(data.settings);
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    }
  }, []);

  const fetchAppCount = useCallback(async () => {
    try {
      const response = await fetch('/api/apps');
      const data = await response.json();
      setAppCount(data.apps?.length || 0);
    } catch (error) {
      console.error('Failed to fetch app count:', error);
    }
  }, []);

  const fetchHealthStatuses = useCallback(async () => {
    if (projects.length === 0) return;

    try {
      const response = await fetch('/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectIds: projects.map((p) => p.id) }),
      });
      const data = await response.json();

      const statusMap: Record<string, ProjectHealthStatus> = {};
      data.statuses.forEach((status: ProjectHealthStatus) => {
        statusMap[status.projectId] = status;
      });

      setHealthStatuses(statusMap);
    } catch (error) {
      console.error('Failed to fetch health statuses:', error);
    }
  }, [projects]);

  const fetchActivePorts = useCallback(async () => {
    try {
      const response = await fetch('/api/ports');
      const data = await response.json();
      setActivePorts(data.ports || []);
    } catch (error) {
      console.error('Failed to fetch ports:', error);
    }
  }, []);

  const fetchServerStatuses = useCallback(async () => {
    if (isPollingServersRef.current) return; // skip if previous round still in-flight
    const serverProjects = projects.filter((p) => p.category === 'server' && p.server);
    if (serverProjects.length === 0) return;

    isPollingServersRef.current = true;
    try {
      const statuses: Record<string, ServerStatus> = {};
      for (const project of serverProjects) {
        try {
          const response = await fetch(`/api/servers?projectId=${project.id}`);
          const status = await response.json();
          statuses[project.id] = status;
        } catch {
          statuses[project.id] = { projectId: project.id, isRunning: false };
        }
      }
      setServerStatuses(statuses);
    } finally {
      isPollingServersRef.current = false;
    }
  }, [projects]);

  const fetchCollabChannels = useCallback(async () => {
    try {
      const response = await fetch('/api/collab');
      const data = await response.json();
      setCollabChannelCount(data.channels?.length || 0);
    } catch (error) {
      console.error('Failed to fetch collab channels:', error);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      await fetchProjects();
      await fetchAppCount();
      await fetchCollabChannels();

      // Fetch setup status for onboarding personalization
      if (showOnboarding) {
        try {
          const res = await fetch('/api/setup/status');
          const data = await res.json();
          if (!data.setupComplete) {
            setShowOnboarding(false);
          } else {
            const name = data.steps?.[1]?.data?.name as string | undefined;
            const teamName = data.steps?.[4]?.data?.teamName as string | undefined;
            setOnboardingUser({ name, teamName });
          }
        } catch {
          // Non-fatal — onboarding still shows without personalization
        }
      }

      setIsLoading(false);
    };
    init();
  }, [fetchProjects, fetchAppCount, fetchCollabChannels]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (projects.length > 0) {
      fetchHealthStatuses();
      fetchActivePorts();
      fetchServerStatuses();
    }
  }, [projects, fetchHealthStatuses, fetchActivePorts, fetchServerStatuses]);

  // Polling for non-SSE data (servers, collab channels still poll at 2s)
  // Health checks and ports are now SSE-pushed
  useEffect(() => {
    if (projects.length === 0 || settings.refreshInterval <= 0) return;

    const interval = setInterval(() => {
      fetchServerStatuses();
      fetchCollabChannels();
    }, settings.refreshInterval);
    return () => clearInterval(interval);
  }, [projects, settings.refreshInterval, fetchServerStatuses, fetchCollabChannels]);

  // SSE fallback: slow poll at 30s for health + ports when SSE is disconnected
  useEffect(() => {
    if (projects.length === 0) return;
    if (eventStream.isSSE) return;

    const interval = setInterval(() => {
      fetchHealthStatuses();
      fetchActivePorts();
    }, 30000);
    return () => clearInterval(interval);
  }, [projects, eventStream.isSSE, fetchHealthStatuses, fetchActivePorts]);

  // Global keyboard shortcuts for Collab panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // Ctrl+K or Ctrl+/ to open AgentChat (the home page)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === '/')) {
        e.preventDefault();
        router.push('/');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const onlineCount = Object.values(healthStatuses).filter(
    (s) => s.overallStatus === 'online'
  ).length + Object.values(serverStatuses).filter((s) => s.isRunning).length;

  const handleOpenFolder = (project: Project) => {
    console.log('Open folder:', project.path);
  };

  const handleOpenTerminal = (project: Project) => {
    console.log('Open terminal:', project.path);
  };

  const handleStartServer = async (project: Project) => {
    try {
      await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', projectId: project.id }),
      });
      await fetchServerStatuses();
      await fetchActivePorts();
    } catch (error) {
      console.error('Failed to start server:', error);
    }
  };

  const handleStopServer = async (project: Project) => {
    try {
      await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', projectId: project.id }),
      });
      await fetchServerStatuses();
      await fetchActivePorts();
    } catch (error) {
      console.error('Failed to stop server:', error);
    }
  };

  const getPortConflict = (project: Project): PortInfo | undefined => {
    if (!project.server?.port) return undefined;
    const serverStatus = serverStatuses[project.id];
    if (serverStatus?.isRunning) return undefined;
    return activePorts.find((p) => p.port === project.server?.port);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-accent" />
          <p className="text-muted">Loading {PRODUCT_NAME}...</p>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'apps':
        return (
          <>
            <SprintProgressWidget />
            <CatalogHealthWidget />
            <AppLibrary onAppCountChange={setAppCount} />
          </>
        );

      case 'sites':
        return (
          <div>
            {sites.length === 0 ? (
              <div className="glass-card empty-state">
                <div className="flex items-center justify-center gap-3 mb-5">
                  <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                    <Globe className="w-6 h-6 text-white/50" />
                  </div>
                  <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                    <Activity className="w-6 h-6 text-white/50" />
                  </div>
                  <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                    <Shield className="w-6 h-6 text-white/50" />
                  </div>
                </div>
                <p className="text-lg font-medium mb-2">No sites registered</p>
                <p className="text-sm text-white/50 mb-5 max-w-xs mx-auto">
                  Monitor uptime, health status, and response times for your live websites — all from one place.
                </p>
                <button
                  onClick={() => setActiveTab('apps')}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 border border-white/15 text-sm font-medium transition-colors"
                >
                  Register a site
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {sites.map((project) => (
                  <SiteCard
                    key={project.id}
                    project={project}
                    healthStatus={healthStatuses[project.id]}
                    onDelete={fetchProjects}
                  />
                ))}
              </div>
            )}
          </div>
        );

      case 'servers':
        return <SystemsPage refreshInterval={settings.refreshInterval} onProcessCountChange={setPm2Count} />;

      case 'docs':
        return <DocsPanel onDocsCountChange={setDocsCount} />;

    }
  };

  return (
    <>
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        appCount={appCount}
        siteCount={sites.length}
        serverCount={pm2Count}
        docsCount={docsCount}
        onlineCount={onlineCount}
        onAddProject={() => setShowAddProject(true)}
        collabChannelCount={collabChannelCount}
      />

      {showOnboarding && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
          <OnboardingCard
            userName={onboardingUser.name}
            teamName={onboardingUser.teamName}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onDismiss={() => setShowOnboarding(false)}
            onOpenAddProject={() => setShowAddProject(true)}
            projectCount={projects.length}
          />
        </div>
      )}

      <main className={activeTab === 'servers' ? 'px-4 sm:px-6 lg:px-6 py-6' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8'}>
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>

      {showAddProject && (
        <AddProjectModal
          onClose={() => setShowAddProject(false)}
          onSuccess={fetchProjects}
        />
      )}

      {/* Floating loops indicator - shows when loops are active */}
      <LoopsFloatingIndicator refreshInterval={settings.refreshInterval} />
    </>
  );
}
