// Shared types for the Systems Tab rebuild

// ─── Chart / Metrics types ────────────────────────────────────────────────────

/** One sample from useMetricsBuffer — cpu is aggregate % across non-dev services, memory is bytes */
export interface CpuMemorySample {
  timestamp: number;  // Unix ms
  cpu: number;        // aggregate CPU %
  memory: number;     // total memory in bytes
}

export type SystemsSection =
  | 'overview'
  | 'services'
  | 'processes'
  | 'scheduled-jobs'
  | 'ai-tasks'
  | 'watchdog'
  | 'memory'
  | 'ports'
  | 'firewall'
  | 'connections'
  | 'bridges'
  | 'mcp'
  | 'models'
  | 'errors'
  | 'process-health'
  | 'logs'
  | 'supabase'
  | 'local-ai'
  | 'disk'
  | 'directory-sync'
  | 'android-studio';

export type EntityType =
  | 'service'
  | 'process'
  | 'scheduled-job'
  | 'ai-task'
  | 'connection'
  | 'bridge'
  | 'mcp-server'
  | 'model';

// Tab definitions per entity type
export type ServiceTab = 'overview' | 'logs' | 'config' | 'health' | 'cron';
export type ProcessTab = 'overview' | 'logs';
export type ScheduledJobTab = 'overview' | 'history' | 'config';
export type AITaskTab = 'output' | 'details';
export type ConnectionTab = 'overview' | 'health';
export type BridgeTab = 'status' | 'config';
export type MCPServerTab = 'overview' | 'tools';
export type ModelTab = 'overview' | 'integration' | 'config';
// Supabase instance tabs — mirrors SupabaseSection's internal TabKey so that
// navTargets from ServiceAlertsPanel ('backups' on failure alerts) and future
// deep links can carry a tab through SystemsNavState.
export type SupabaseTab = 'overview' | 'data' | 'sql' | 'schema' | 'backups' | 'auth';

export type EntityTab =
  | ServiceTab
  | ProcessTab
  | ScheduledJobTab
  | AITaskTab
  | ConnectionTab
  | BridgeTab
  | MCPServerTab
  | ModelTab
  | SupabaseTab;

export interface BreadcrumbSegment {
  label: string;
  section?: SystemsSection;
  entityId?: string;
  entityName?: string;
}

export interface SystemsNavState {
  section: SystemsSection;
  entityId?: string;
  entityType?: EntityType;
  tab?: EntityTab;
}

// Entity status for ContextPanel
export type EntityStatus = 'online' | 'stopped' | 'errored' | 'warning' | 'launching' | 'unknown';

export interface ContextPanelEntity {
  id: string;
  name: string;
  type: EntityType;
  status: EntityStatus;
  category?: string;
  createdAt?: string;
  owner?: string;
  port?: number;
  pid?: number;
  uptime?: string;
  cpu?: number;
  memory?: number;
}

export const SECTION_LABELS: Record<SystemsSection, string> = {
  overview: 'Overview',
  services: 'Services',
  processes: 'Processes',
  'scheduled-jobs': 'Scheduled Jobs',
  'ai-tasks': 'AI Tasks',
  watchdog: 'Watchdog',
  memory: 'Memory',
  ports: 'Ports',
  firewall: 'Firewall',
  connections: 'Connections',
  bridges: 'Bridges',
  mcp: 'MCP Gateway',
  models: 'Models',
  errors: 'Error Monitor',
  'process-health': 'Process Health',
  logs: 'Logs',
  supabase: 'Supabase',
  'local-ai': 'Local AI',
  disk: 'Disk Management',
  'directory-sync': 'Directory Sync',
  'android-studio': 'Android Studio',
};

export const ENTITY_TABS: Record<EntityType, { id: string; label: string }[]> = {
  service: [
    { id: 'overview', label: 'Overview' },
    { id: 'logs', label: 'Logs' },
    { id: 'config', label: 'Config' },
    { id: 'health', label: 'Health' },
    { id: 'cron', label: 'Cron' },
  ],
  process: [
    { id: 'overview', label: 'Overview' },
    { id: 'logs', label: 'Logs' },
  ],
  'scheduled-job': [
    { id: 'overview', label: 'Overview' },
    { id: 'history', label: 'History' },
    { id: 'config', label: 'Config' },
  ],
  'ai-task': [
    { id: 'output', label: 'Output' },
    { id: 'details', label: 'Details' },
  ],
  connection: [
    { id: 'overview', label: 'Overview' },
    { id: 'health', label: 'Health' },
  ],
  bridge: [
    { id: 'status', label: 'Status' },
    { id: 'config', label: 'Config' },
  ],
  'mcp-server': [
    { id: 'overview', label: 'Overview' },
    { id: 'tools', label: 'Tools' },
  ],
  model: [
    { id: 'overview', label: 'Overview' },
    { id: 'integration', label: 'Integration' },
    { id: 'config', label: 'Config' },
  ],
};
