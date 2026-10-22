/**
 * Host-Bridge API Type Definitions
 *
 * Typed contract for the host-bridge daemon (localhost:3001).
 * The host-bridge isolates system-level operations (PM2, PTY, script exec)
 * from the Next.js web process. DevFlow API routes call the bridge instead
 * of spawning child processes directly.
 *
 * Both the host-bridge daemon and DevFlow API routes import these types.
 */

// ============================================
// Shared Types
// ============================================

/** Standard envelope for all bridge responses */
export interface BridgeResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** ISO timestamp of when the bridge processed the request */
  timestamp: string;
}

/** Auth header: Authorization: Bearer <token> */
export interface BridgeAuthConfig {
  /** Shared secret between DevFlow and host-bridge. Set via HOST_BRIDGE_TOKEN env var. */
  token: string;
}

// ============================================
// PM2 Endpoints
// ============================================

/**
 * GET /pm2/status
 *
 * Returns all PM2 processes with metrics and port mappings.
 * Wraps: pm2 jlist + TCP port overlay
 */
export interface PM2StatusResponse {
  processes: PM2ProcessInfo[];
  portsInUse: Record<number, string>;
}

export interface PM2ProcessInfo {
  name: string;
  pm_id: number;
  pid: number;
  status: 'online' | 'stopped' | 'errored' | 'launching';
  cpu: number;
  memory: number;
  memoryFormatted: string;
  uptime: number;
  uptimeFormatted: string;
  restarts: number;
  port: number | null;
  cwd: string;
  execMode: 'fork' | 'cluster' | 'systemd';
}

/**
 * POST /pm2/exec
 *
 * Execute a PM2 action on a named process.
 * Only allowlisted actions are accepted — others return 403.
 */
export interface PM2ExecRequest {
  action: 'start' | 'stop' | 'restart';
  target: string;
  /** Optional port for pre-start conflict detection */
  port?: number;
}

export interface PM2ExecResponse {
  action: string;
  target: string;
  output?: string;
  portConflict?: {
    port: number;
    ownedBy: string;
  };
}

/**
 * GET /pm2/logs?name={name}&lines={n}
 *
 * Fetch recent log lines for a PM2 process.
 * Wraps: pm2 logs {name} --nostream --lines {n}
 */
export interface PM2LogsQuery {
  name: string;
  /** Max lines to return. Default 50, max 500. */
  lines?: number;
}

export interface PM2LogsResponse {
  name: string;
  lines: string[];
  count: number;
}

// ============================================
// PTY Endpoints
// ============================================

/**
 * POST /pty/spawn
 *
 * Spawn a new PTY session via tmux.
 * Returns a session ID for subsequent read/write/close calls.
 */
export interface PtySpawnRequest {
  /** Working directory for the shell session */
  workingDirectory: string;
  /** Command to run. If omitted, spawns default shell. */
  command?: string;
  /** Args to pass to the command */
  args?: string[];
  /** Environment variables to set */
  env?: Record<string, string>;
  /** tmux history limit. Default 50000. */
  historyLimit?: number;
}

export interface PtySpawnResponse {
  sessionId: string;
  pid: number;
  tmuxSession: string;
}

/**
 * POST /pty/:id/write
 *
 * Send input to a PTY session.
 * Wraps: tmux send-keys -t {session} -l "{input}" Enter
 */
export interface PtyWriteRequest {
  /** Text to send to the PTY. Enter is appended automatically. */
  input: string;
  /** If true, do NOT append Enter after input. Default false. */
  raw?: boolean;
}

export interface PtyWriteResponse {
  sessionId: string;
  sent: boolean;
}

/**
 * GET /pty/:id/read?since={offset}
 *
 * Read output from a PTY session's pipe log.
 * Returns new content since the given byte offset.
 */
export interface PtyReadQuery {
  /** Byte offset to start reading from. Default 0. */
  since?: number;
}

export interface PtyReadResponse {
  sessionId: string;
  output: string;
  /** Byte offset for the next read (pass as 'since' to get only new content) */
  offset: number;
  /** True if the tmux session is still alive */
  alive: boolean;
}

/**
 * POST /pty/:id/close
 *
 * Gracefully close a PTY session.
 * Wraps: tmux kill-session -t {session}
 */
export interface PtyCloseResponse {
  sessionId: string;
  closed: boolean;
}

/**
 * GET /pty/list
 *
 * List all active PTY sessions managed by the bridge.
 */
export interface PtySessionInfo {
  sessionId: string;
  tmuxSession: string;
  pid: number;
  workingDirectory: string;
  createdAt: string;
  alive: boolean;
}

export interface PtyListResponse {
  sessions: PtySessionInfo[];
}

// ============================================
// Script Execution Endpoints
// ============================================

/**
 * POST /script/run
 *
 * Execute an allowlisted script from the DevFlow scripts/ directory.
 * Only scripts in the allowlist can be executed — others return 403.
 *
 * The allowlist is defined in the bridge config, not by the caller.
 */
export interface ScriptRunRequest {
  /** Script name (relative to DEVFLOW_HOME/scripts/). e.g. "safe-build.sh" */
  script: string;
  /** Arguments to pass to the script */
  args?: string[];
  /** Override working directory. Default: DEVFLOW_HOME */
  cwd?: string;
  /** Timeout in ms. Default 60000, max 600000. */
  timeout?: number;
}

export interface ScriptRunResponse {
  script: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Duration in ms */
  durationMs: number;
}

/**
 * GET /script/allowlist
 *
 * Returns the current script allowlist (for UI display / debugging).
 */
export interface ScriptAllowlistResponse {
  scripts: AllowedScript[];
}

export interface AllowedScript {
  /** Script name relative to scripts/ */
  name: string;
  /** Human-readable description */
  description: string;
  /** Max timeout override for this script. Default applies if not set. */
  maxTimeout?: number;
}

// ============================================
// Health & Meta Endpoints
// ============================================

/**
 * GET /health
 *
 * Health check endpoint. Returns 200 if the bridge is running.
 */
export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
  /** ISO timestamp of when the bridge started */
  startedAt: string;
}

/**
 * GET /audit/recent?limit={n}
 *
 * Returns recent audit log entries. For debugging and monitoring.
 */
export interface AuditEntry {
  timestamp: string;
  method: string;
  path: string;
  /** What command or script was executed */
  command: string;
  /** Source IP (should always be 127.0.0.1) */
  sourceIp: string;
  result: 'success' | 'denied' | 'error';
  /** Duration in ms */
  durationMs?: number;
  error?: string;
}

export interface AuditRecentResponse {
  entries: AuditEntry[];
  total: number;
}

// ============================================
// Bridge Configuration
// ============================================

/**
 * Configuration file: DEVFLOW_HOME/config/host-bridge.json
 *
 * Created by the install script with sensible defaults.
 * Users can edit to add scripts or adjust limits.
 */
export interface BridgeConfig {
  /** Port to listen on. Default 3001. */
  port: number;
  /** Bind address. MUST be 127.0.0.1 — never 0.0.0.0. */
  host: '127.0.0.1';
  /** Shared auth token. Generated on install if not set. */
  authToken: string;
  /** PM2 command allowlist — regex patterns. */
  pm2Allowlist: string[];
  /** Script allowlist — filenames relative to scripts/. */
  scriptAllowlist: AllowedScript[];
  /** Rate limit: max requests per minute per endpoint group. */
  rateLimit: {
    pm2: number;
    pty: number;
    script: number;
  };
  /** Max concurrent PTY sessions. Default 20. */
  maxPtySessions: number;
  /** Audit log retention in days. Default 7. */
  auditRetentionDays: number;
}

// ============================================
// Default Allowlists
// ============================================

/** PM2 commands that are safe by default */
export const DEFAULT_PM2_ALLOWLIST: string[] = [
  '^pm2 jlist$',
  '^pm2 (start|stop|restart) [\\w-]+$',
  '^pm2 logs [\\w-]+ --nostream --lines \\d+$',
  '^pm2 describe [\\w-]+$',
];

/** Scripts approved for execution by default */
export const DEFAULT_SCRIPT_ALLOWLIST: AllowedScript[] = [
  { name: 'safe-build.sh', description: 'Atomic Next.js build with flock', maxTimeout: 600000 },
  { name: 'ensure-build.sh', description: 'Verify build exists' },
  { name: 'devflow-debug.sh', description: 'Diagnostics report' },
  { name: 'rollout-agent-dirs.py', description: 'Scaffold agent directories' },
  { name: 'check-rotate.sh', description: 'Rotate agent log files' },
  { name: 'write-session-end.sh', description: 'Write session end marker' },
  { name: 'patch-hooks.py', description: 'Update agent hooks' },
  { name: 'rotate-logs.sh', description: 'Rotate system logs' },
  { name: 'collab_helper.py', description: 'Send collab channel message' },
];
