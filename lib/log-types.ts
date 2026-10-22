/**
 * Log Types — Unified log entry interfaces for the DevFlow Logs Dashboard
 *
 * All log sources write UnifiedLogEntry to logs/event-logs/current.jsonl
 * via writeLogEntry() from lib/log-writer.ts
 */

export type LogSource = 'agent' | 'api' | 'cron' | 'service' | 'build' | 'error' | 'tools' | 'crash' | 'supabase-backup';
export type LogSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'debug';

export interface UnifiedLogEntry {
  id: string;
  timestamp: string;           // ISO 8601
  source: LogSource;
  severity: LogSeverity;
  title: string;               // One-line summary for list view
  details?: string;            // Expandable content (error stacks, command output, etc.)
  metadata: Record<string, unknown>; // Source-specific fields
}

// ============================================
// Agent Lifecycle
// ============================================

export type AgentLifecycleEventType =
  | 'spawn' | 'ready' | 'crash' | 'exit'
  | 'respawn' | 'compaction' | 'blocked' | 'unblocked';

export interface AgentLifecycleMeta {
  event: AgentLifecycleEventType;
  agentName: string;
  channelId: string;
  channelName?: string;
  tmuxSession?: string;
  pid?: number;
  signal?: string;
  exitCode?: number;
  memoryMB?: number;
  systemMemAvailMB?: number;
  crashCount?: number;
  sessionId?: string;
  trigger?: string;
  error?: string;
}

// ============================================
// Service Events
// ============================================

export type ServiceEventType =
  | 'start' | 'stop' | 'restart' | 'error'
  | 'watchdog-restart' | 'health-fail' | 'health-recover' | 'health-check' | 'oom-kill';

export interface ServiceEventMeta {
  event: ServiceEventType;
  serviceName: string;
  pm2Id?: number;
  pid?: number;
  reason?: string;
  memoryMB?: number;
  cpuPercent?: number;
  restartCount?: number;
}

// ============================================
// Build Events
// ============================================

export type BuildEventType = 'start' | 'complete' | 'failed' | 'skipped';

export interface BuildEventMeta {
  event: BuildEventType;
  buildId?: string;
  durationMs?: number;
  trigger: string;
  error?: string;
}

// ============================================
// Tool Activity
// ============================================

export type ToolEventType =
  | 'submitted' | 'spawned' | 'connected' | 'disconnected'
  | 'completed' | 'failed' | 'timeout' | 'retry';

export interface ToolActivityMeta {
  tool: string;               // 'browser-test' | 'computer-use' | future tools
  event: ToolEventType;
  taskId?: string;
  requestedBy?: string;
  targetUrl?: string;
  taskType?: string;
  durationMs?: number;
  retryCount?: number;
  connectionStatus?: string;
  result?: 'pass' | 'fail' | 'timeout' | 'error';
  error?: string;
}

// ============================================
// Crash Recovery
// ============================================

export interface CrashRecoveryMeta {
  event: 'crash-detected' | 'recovery-complete';
  downtime: {
    estimatedStart: string;
    recoveredAt: string;
    durationMs: number;
  };
  snapshot: {
    pm2Dump?: string;
    lastAgentStates: Array<{
      name: string;
      status: string;
      pid: number;
      crashCount: number;
      lastStoppedAt?: string;
    }>;
    systemMemory: {
      totalMB: number;
      availableMB: number;
      swapUsedMB: number;
    };
    diskUsage: {
      totalGB: number;
      usedGB: number;
      availableGB: number;
    };
    lastCronExecution?: {
      jobName: string;
      command: string;
      executedAt: string;
      exitCode: number;
    };
    recentErrors: string[];
    pm2LogsTail?: string[];
    dmesg?: string[];
  };
}
