/**
 * DevFlow Type Definitions
 * Central type definitions for the DevFlow dashboard application.
 * Includes types for health checks, project configuration, PM2 processes,
 * Ralph loops, Claude session collaboration, and documentation chat.
 */

export type HealthCheckType = 'port' | 'http' | 'command' | 'process';

export type HealthStatus = 'online' | 'offline' | 'warning' | 'unknown' | 'checking';

export type ProjectCategory = 'tool' | 'site' | 'server' | 'service' | 'api' | 'ai' | 'development' | 'automation' | 'media' | 'monitoring' | 'utility' | 'infrastructure' | 'agent';

export interface PortHealthCheck {
  type: 'port';
  port: number;
  label: string;
}

export interface HttpHealthCheck {
  type: 'http';
  url: string;
  label: string;
  expectedStatus?: number;
}

export interface CommandHealthCheck {
  type: 'command';
  command: string;
  label: string;
}

export interface ProcessHealthCheck {
  type: 'process';
  processName: string;
  label: string;
}

export type HealthCheck =
  | PortHealthCheck
  | HttpHealthCheck
  | CommandHealthCheck
  | ProcessHealthCheck;

export interface ProjectLinks {
  repo?: string;
  docs?: string;
  local?: string;
  [key: string]: string | undefined;
}

export interface WatchdogConfig {
  enabled: boolean;
  maxRestarts?: number;      // Max restarts in cooldown window (default: 3)
  cooldownMs?: number;       // Cooldown after max restarts hit (default: 300000 = 5 min)
  restartDelayMs?: number;   // Delay before restart attempt (default: 5000 = 5s)
  maxCycles?: number;        // Max cooldown cycles before circuit breaker trips (default: 3)
}

export interface ServerConfig {
  port: number;
  startCommand: string;
  stopCommand?: string;
  autoRestart?: boolean;
  autoStart?: boolean;  // Whether server is configured to auto-start on boot
  pm2Name?: string;     // PM2 process name for auto-start detection
  systemdService?: string;  // systemd unit name (e.g., "ollama")
  watchdog?: WatchdogConfig; // Auto-restart when health checks detect service is down
  cronJobs?: ServiceCronJob[]; // Scheduled cron jobs associated with this service
}

export interface ServiceCronJob {
  name: string;               // Human-readable name (e.g., "Nightly Restart")
  schedule: string;           // Cron expression (e.g., "0 4 * * *")
  action: 'restart' | 'shell'; // 'restart' runs stopCommand then startCommand; 'shell' runs command
  command?: string;           // For 'shell' action: the shell command to execute
  enabled?: boolean;          // Default: true
  description?: string;
}

export interface DevServerConfig {
  enabled: boolean;     // Whether this project supports local dev server
}

export interface Project {
  id: string;
  name: string;
  description: string;
  path: string;
  category: ProjectCategory;
  tags: string[];
  healthChecks: HealthCheck[];
  links: ProjectLinks;
  server?: ServerConfig;
  devServer?: DevServerConfig;  // Controls whether Dev button is shown
  autoRegistered?: boolean;     // Set by auto-discovery daemon
  portConflict?: {              // Set when auto-registration hit 409
    port: number;
    conflictsWith: string;
  };
}

export interface HealthCheckResult {
  checkId: string;
  label: string;
  status: HealthStatus;
  message?: string;
  responseTime?: number;
}

export interface ProjectHealthStatus {
  projectId: string;
  overallStatus: HealthStatus;
  checks: HealthCheckResult[];
  lastChecked: string;
}

export interface ConfigSettings {
  refreshInterval: number;
  defaultCategory: string;
}

export interface Config {
  projects: Project[];
  settings: ConfigSettings;
}

export interface RunningProcess {
  pid: number;
  port: number;
  command: string;
  cwd?: string;
}

export interface PortInfo {
  port: number;
  pid: number;
  process: string;
  status: 'listening' | 'established';
}

export interface ServerStatus {
  projectId: string;
  isRunning: boolean;
  pid?: number;
  port?: number;
  uptime?: number;
}

// Documentation types
export interface DocMeta {
  id: string;
  title: string;
  category: 'snippets' | 'guides';
  tags: string[];
  created: string;
  path: string;
}

export interface Doc extends DocMeta {
  content: string;
  excerpt: string;
}

export interface DocSearchResult {
  id: string;
  title: string;
  category: string;
  tags: string[];
  excerpt: string;
  score: number;
  matches?: string[];
}

// PM2 Process Types
export type PM2Status = 'online' | 'stopped' | 'errored' | 'launching';

export interface PM2Process {
  name: string;
  pm_id: number;
  pid: number;
  status: PM2Status;
  cpu: number;
  memory: number;
  memoryFormatted: string;
  uptime: number;
  uptimeFormatted: string;
  restarts: number;
  unstableRestarts?: number;  // PM2's count of restarts under min_uptime. Distinguishes scheduled/manual restarts (unstable=0) from crash loops (unstable>0).
  cronRestart?: string;        // PM2 cron_restart schedule string ("0 * * * *"). Present iff configured. Used by pm2-monitor to downgrade scheduled bounces from 'high' to 'low' severity.
  port: number | null;
  cwd: string;
  execMode: 'fork' | 'cluster' | 'systemd';
}

export interface PM2Response {
  processes: PM2Process[];
  portsInUse: Record<number, string>;
  timestamp: string;
  error?: string;
  warning?: string;
}

export interface PM2ActionRequest {
  action: 'start' | 'stop' | 'restart' | 'delete';
  target: string;
  port?: number;
}

export interface PM2ActionResponse {
  success: boolean;
  message?: string;
  error?: string;
  portConflict?: {
    port: number;
    ownedBy: string;
  };
}

// Image Optimization Types
export interface ImageInfo {
  path: string;
  relativePath: string;
  filename: string;
  size: number;
  width: number;
  height: number;
  format: string;
}

export type CropDirection = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface OptimizeSettings {
  quality: number;
  resize?: {
    width?: number;
    height?: number;
    maintainAspect: boolean;
  };
  crop?: {
    direction: CropDirection;
    amount: number;
    unit: 'px' | '%';
  };
  format: 'original' | 'webp' | 'jpeg' | 'png';
  overwrite: boolean;
}

export interface OptimizeResult {
  path: string;
  originalSize: number;
  newSize: number;
  savings: number;
  savingsPercent: number;
  newPath: string;
  success: boolean;
  error?: string;
}

// Secrets Scanner Types
export interface SecretPattern {
  name: string;
  pattern: RegExp;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface SecretFinding {
  ruleId: string;
  description: string;
  file: string;
  line: number;
  column: number;
  match: string;
  snippet: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface ScanResult {
  projectId: string;
  findings: SecretFinding[];
  filesScanned: number;
  duration: number;
  timestamp: string;
}

// Ralph Loop Types
export type LoopStatus = 'running' | 'completed' | 'stuck' | 'cancelled' | 'max_iterations' | 'awaiting_input';
export type LoopDecision = 'continue' | 'complete' | 'stuck' | 'needs_input';
export type LoopProgress = 'good' | 'slow' | 'none' | 'regressing';

export interface AwaitingInput {
  reason: string;           // Why human input is needed
  context?: string;         // What was being attempted
  options?: string[];       // Suggested choices (max 4)
  requested_at: string;     // ISO timestamp
  iteration: number;        // Which iteration triggered this
}

export interface LoopIteration {
  number: number;
  timestamp: string;
  decision: LoopDecision;
  progress: LoopProgress;
  summary: string;
  screenshot_path?: string;
  duration_seconds?: number;
}

export interface ConsolidatedSummary {
  iteration_summary?: string;     // Brief description of current state
  completed_items?: string[];     // List of completed tasks/features
  remaining_items?: string[];     // List of remaining tasks/features
  progress_percent?: number;      // 0-100 progress estimate
  status_line?: string;           // Short status like "4/6 features complete"
  updated_at?: string;            // When this summary was generated (legacy)
  last_updated?: string;          // When this summary was generated
}

export interface RalphLoop {
  session_id: string;
  project_path: string;
  project_name: string;
  started_at: string;
  completed_at: string | null;
  final_status: LoopStatus;
  last_heartbeat: string;
  evaluator_model: string;
  screenshot_url: string;
  max_iterations: number;
  original_prompt: string;
  iterations: LoopIteration[];
  awaiting_input?: AwaitingInput;           // Present when status is awaiting_input
  consolidated?: ConsolidatedSummary;       // Summary from consolidator (legacy)
  current_status?: ConsolidatedSummary;     // Summary from consolidator sub-agent
}

export interface LoopsResponse {
  active: RalphLoop[];
  history: RalphLoop[];
  timestamp: string;
  error?: string;
}

export interface LoopActionRequest {
  action: 'cancel' | 'submit_input';
  project_path: string;
  input_response?: string;        // Free text response
  selected_option?: number;       // Index of selected option (0-based)
}

export interface LoopActionResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface LoopsConfig {
  watchPaths: string[];
  historyLimit: number;
}

// ============================================
// Claude Session Collaboration Types
// ============================================

export type SessionStatus = 'active' | 'idle' | 'busy' | 'offline';

export interface ClaudeSession {
  sessionId: string;          // UUID from ~/.claude/projects/{project}/{sessionId}.jsonl
  pid: number;                // Process ID
  projectPath: string;        // Working directory
  projectName: string;        // Derived from path
  displayName?: string;       // User-friendly name set by the session
  status: SessionStatus;
  registeredAt: string;       // ISO timestamp
  lastHeartbeat: string;      // ISO timestamp
  lastActivity: string;       // Last message/action timestamp
  capabilities: string[];     // ['code', 'web', 'mcp:snapshot', etc.]
  currentTask?: string;       // Brief description of current work
  currentTaskId?: string;     // Sprint task ID currently claimed by this session
  collabReady?: boolean;      // Whether collab session file exists (added at query time)
}

export interface SessionsConfig {
  pollInterval: number;       // Heartbeat interval (default: 5000ms)
  staleThreshold: number;     // Seconds before session considered offline (default: 30)
  autoDiscovery: boolean;     // Scan processes for unregistered sessions
}

export interface WindowsTerminalTab {
  name: string;
  processId: number;
  isActive: boolean;
}

export interface SessionsResponse {
  sessions: ClaudeSession[];
  terminalTabs?: WindowsTerminalTab[];  // Windows Terminal tab names
  timestamp: string;
  error?: string;
}

export interface SessionActionRequest {
  action: 'register' | 'heartbeat' | 'unregister' | 'spawn' | 'spawn_pty' | 'invite_to_channel';
  sessionId?: string;          // Optional for spawn, spawn_pty, invite_to_channel actions
  projectPath?: string;
  pid?: number;                // Process ID - used to track if session is still alive, and for invite_to_channel
  capabilities?: string[];
  status?: SessionStatus;
  currentTask?: string;
  displayName?: string;
  channelId?: string;          // For spawn/spawn_pty/invite_to_channel actions
  channelName?: string;        // For spawn/spawn_pty/invite_to_channel actions
  agentName?: string;          // For spawn_pty action - custom agent display name
  systemPrompt?: string;       // For spawn_pty action - initial system context
}

export interface SessionActionResponse {
  success: boolean;
  message?: string;
  sessionId?: string;
  error?: string;
  ptySession?: CollabPtySession;      // For spawn_pty action
  participant?: CollabParticipant;    // For spawn_pty action
}

// Message System Types
export type MessageType = 'chat' | 'request' | 'response' | 'broadcast' | 'system';
export type MessageStatus = 'pending' | 'delivered' | 'read' | 'responded';

export interface Message {
  id: string;                 // UUID
  type: MessageType;
  from: string;               // Session ID or 'devflow' for system messages
  to: string;                 // Session ID or 'all' for broadcast
  content: string;
  timestamp: string;          // ISO timestamp
  status: MessageStatus;
  replyTo?: string;           // Message ID for request/response pattern
  threadId?: string;          // Group related messages
  metadata?: {
    requestId?: string;       // For request/response correlation
    priority?: 'low' | 'normal' | 'high';
    expires?: string;         // ISO timestamp for auto-cleanup
  };
}

export interface MessageThread {
  id: string;
  participants: string[];     // Session IDs
  subject?: string;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
}

export interface MessagesResponse {
  messages: Message[];
  threads: MessageThread[];
  timestamp: string;
  error?: string;
}

export interface MessageActionRequest {
  action: 'send' | 'broadcast' | 'respond' | 'markRead';
  type?: MessageType;
  from: string;               // Session ID
  to?: string;                // Session ID (required for 'send')
  content?: string;
  messageId?: string;         // For 'respond' or 'markRead'
  threadId?: string;
  metadata?: Message['metadata'];
}

export interface MessageActionResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

// Sessions Data Storage
export interface SessionsData {
  sessions: ClaudeSession[];
  config: SessionsConfig;
  lastUpdated: string;
}

// Messages Data Storage
export interface MessagesData {
  messages: Message[];
  threads: MessageThread[];
  lastUpdated: string;
}

// ============================================
// Docs Chat Types
// ============================================

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatStreamEvent {
  type: 'text' | 'error';
  content?: string;
  message?: string;
}

// Global Chat Panel Types
export type ChatSourceType = 'doc' | 'project' | 'loop' | 'general';

export interface GlobalChatSession {
  id: string;                    // Server session ID from /api/docs/chat
  sourceType: ChatSourceType;
  sourceId: string;              // e.g., doc ID, project ID
  sourceTitle: string;           // Display name
  sourceContent?: string;        // Document content for context
  messages: ChatMessage[];       // Local copy of conversation
  streamingContent: string;      // Current streaming response
  isStreaming: boolean;
  createdAt: string;             // ISO timestamp
  lastActivity: string;          // For auto-close after inactivity
}

// Chat UI State Types
export interface CardPosition {
  x: number;
  y: number;
}

export interface ChatUIState {
  panelWidth: number;
  cardPositions: Record<string, CardPosition>;
}

// ============================================
// Browser Bridge Types (WSL ↔ Chrome Integration)
// ============================================

export type BrowserSessionStatus = 'connected' | 'disconnected' | 'busy' | 'unknown';
export type BrowserTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
export type BrowserTaskType = 'navigate' | 'screenshot' | 'interact' | 'inspect' | 'verify' | 'debug';

export interface BrowserCapability {
  name: string;
  available: boolean;
}

export interface BrowserSession {
  sessionId: string;
  platform: 'windows-powershell' | 'wsl' | 'native';
  status: BrowserSessionStatus;
  connectedAt: string;
  lastHeartbeat: string;
  capabilities: BrowserCapability[];
  currentPage?: string;
  projectContext?: string;
}

export interface BrowserTaskStep {
  action: 'navigate' | 'screenshot' | 'find' | 'click' | 'type' | 'verify' | 'readConsole' | 'readNetwork' | 'report';
  url?: string;
  query?: string;
  target?: string;
  expect?: string;
  filter?: string;
  note?: string;
  details?: string[];
}

export interface BrowserTask {
  id: string;
  timestamp: string;
  project: string;
  from: 'wsl' | 'chrome-powershell' | 'devflow';
  devServerUrl: string;
  context: string;
  type: BrowserTaskType;
  steps: BrowserTaskStep[];
  status: BrowserTaskStatus;
  priority?: 'low' | 'normal' | 'high';
  timeout?: number;
}

export interface BrowserTaskResult {
  id: string;
  taskId: string;
  timestamp: string;
  from: string;
  status: 'success' | 'partial' | 'failure';
  summary: string;
  findings: Record<string, unknown>;
  consoleErrors: string[];
  networkCalls: Array<{ url: string; status: number; method?: string }>;
  screenshots: string[];
  issues: string[];
  executionTime?: number;
}

export interface BrowserBridgeData {
  sessions: BrowserSession[];
  pendingTasks: BrowserTask[];
  completedTasks: BrowserTaskResult[];
  config: BrowserBridgeConfig;
  lastUpdated: string;
}

export interface BrowserBridgeConfig {
  bridgePath: string;
  pollInterval: number;
  taskTimeout: number;
  maxHistory: number;
  autoCleanup: boolean;
}

export interface BrowserBridgeResponse {
  sessions: BrowserSession[];
  pendingTasks: BrowserTask[];
  recentResults: BrowserTaskResult[];
  timestamp: string;
  error?: string;
}

export interface BrowserBridgeActionRequest {
  action: 'submit_task' | 'cancel_task' | 'get_results' | 'clear_history' | 'register_session' | 'heartbeat';
  task?: Partial<BrowserTask>;
  taskId?: string;
  sessionId?: string;
  platform?: BrowserSession['platform'];
  capabilities?: BrowserCapability[];
}

export interface BrowserBridgeActionResponse {
  success: boolean;
  taskId?: string;
  sessionId?: string;
  result?: BrowserTaskResult;
  error?: string;
}

// BroadcastChannel message types for cross-window sync
export type ChatBroadcastMessageType =
  | 'SESSION_OPENED'
  | 'SESSION_CLOSED'
  | 'MESSAGE_SENT'
  | 'STREAM_UPDATE'
  | 'STREAM_COMPLETE'
  | 'POPOUT_OPENED'
  | 'POPOUT_CLOSED'
  | 'COLLAB_MESSAGE'
  | 'COLLAB_JOIN'
  | 'COLLAB_LEAVE'
  | 'COLLAB_CHANNEL_CREATED';

export interface ChatBroadcastMessage {
  type: ChatBroadcastMessageType;
  sourceId: string;
  data?: unknown;
  timestamp: string;
}

// ============================================
// Collaboration Channel Types (Multi-Agent Chat)
// ============================================

/**
 * Participant types in a collaboration channel
 * - claude-terminal: Claude Code running in WSL/PowerShell terminal
 * - claude-browser: Claude spawned by DevFlow in browser context
 * - gemini: Google Gemini CLI agent
 * - grok: xAI Grok agent (direct API, no pexpect wrapper)
 * - user: Human user via DevFlow UI
 */
export type CollabParticipantType = 'claude' | 'claude-terminal' | 'claude-browser' | 'gemini' | 'gemini-powershell' | 'gemini-terminal' | 'grok' | 'codex' | 'user'; // Participant types

// Computed presence status based on lastSeen (online = active, offline = stale/gone)
// "Working..." is derived from activityStatus on the frontend, not from presence
// "away" means the agent is active but in a different channel
export type CollabPresenceStatus = 'online' | 'offline' | 'away';

// Real-time activity status (broadcast by wrapper)
export type CollabActivityStatus = 'idle' | 'typing' | 'working';

export interface CollabParticipant {
  id: string;                    // Session ID or generated ID
  type: CollabParticipantType;
  name: string;                  // Display name (e.g., "API Developer", "Frontend Agent")
  source: string;                // "WSL", "PowerShell", "Browser", "DevFlow UI"
  joinedAt: string;              // ISO timestamp
  lastSeen: string;              // ISO timestamp - updated on each message or poll
  lastRead?: string;             // ISO timestamp - last message timestamp this participant has read
  pid?: number;                  // Process ID for terminal agents
  projectPath?: string;          // Working directory for terminal agents
  sessionId?: string;            // Claude Code session ID (for /ask command routing)
  color?: string;                // UI color for message attribution
  unreadCount?: number;          // Computed: messages since lastRead (not persisted)
  status?: CollabPresenceStatus; // Computed: online/offline based on lastSeen (not persisted). 'away' = active in another channel (persisted)
  activityStatus?: CollabActivityStatus; // Real-time: idle/typing/working (broadcast by wrapper/task board)
  activityDetail?: string | null; // Human-readable label: "Reading file...", "Thinking...", etc. null = no detail
  activityUpdatedAt?: string;    // ISO timestamp - when activityStatus last changed
  host?: CollabHostReport;       // Self-reported by the wrapper on heartbeat (host id, pid, tmux session, cwd, model)
  jsonlMtimeMs?: number | null;  // Pre-computed JSONL transcript mtime (server-side). null=lookup failed, undefined=not attempted
  awayInChannelId?: string;      // Channel ID where the agent is currently active (set when status = 'away')
  awayInChannelName?: string;    // Display name of that channel (for UI tooltip)
  roleId?: string;               // Role UUID from roles.json — used for recipient selection in reminder logic
  deliveryProtocol?: 'ledger-v1'; // Runtime opted into durable server-ledger delivery
  displayName?: string;          // The account owner's chosen name (lib/account-store.ts). `name` stays the stable routing name agents address
}

export interface CollabMessage {
  id: string;
  channelId: string;
  from: CollabParticipant;
  content: string;
  timestamp: string;
  mentions?: string[];           // @participant IDs
  recipients?: string[];         // Participant IDs who should receive this message (undefined = broadcast to all)
  replyTo?: {                    // Reply context for threading (enriched from message ID)
    id: string;                  // Original message ID
    from?: CollabParticipant;    // Original message sender
    content?: string;            // Original message content (may be truncated)
  };
  image?: {                      // Optional attached image (deprecated - use images array)
    data?: string;               // Base64 data URL (cleared after save to disk)
    name: string;                // Filename
    type: string;                // MIME type
    url?: string;                // Served URL (set by server after saving to disk)
  };
  images?: Array<{               // Multiple attached files (images + documents)
    data?: string;               // Base64 data URL (cleared after save to disk)
    name: string;                // Filename
    type: string;                // MIME type
    url?: string;                // Served URL (set by server after saving to disk)
    size?: number;               // File size in bytes
    clientId?: string;           // Composer-only ID for resolving an inline attachment reference
  }>;
  metadata?: {
    triggeredBy?: string;        // If this was auto-spawned response, which message triggered it
    agentContext?: string;       // System context passed to spawned agent
    isAutoResponse?: boolean;    // True if DevFlow auto-spawned this response
    isStreaming?: boolean;       // True while message is still being streamed from PTY
    streamStartedAt?: string;    // ISO timestamp when stream started
    deliveryMode?: 'targeted' | 'broadcast'; // How message was delivered
    imageUrls?: string[];        // Accessible URLs for terminal agents (set when images saved to disk)
    _optimistic?: boolean;       // True on client-only optimistic messages — cleared when server confirms
    _teamsBridge?: {             // Teams bridge metadata (set on bridged messages)
      source: 'devflow' | 'teams';
      originalMessageId?: string;
      bridgedAt?: string;
      mappingId?: string;
    };
    isHidden?: boolean;          // True to suppress message from UI (still stored and delivered via SSE)
    durableDelivery?: 'ledger-v1'; // Message has server-side delivery records; SSE/poll are wake-up only
    voice?: {                    // Server-created Riley Voice transport metadata; never part of transcript/response text
      kind: 'riley.voice.turn';
      label: 'Riley Voice';
      source: 'recorded-text';
      conversationSessionId: string;
      audioTurnId: string;
      revision: number;
      transcriptSha256: string;
      supersedesMessageId?: string;
    } | {
      kind: 'riley.voice.response';
      label: 'Riley Voice';
      conversationSessionId: string;
      audioTurnId: string;
      revision: number;
      inReplyToMessageId: string;
    };
    crossChannel?: {             // Explicit Agent API cross-channel delivery and authoritative reply route
      sourceChannelId: string;
      sourceChannelName: string;
      deliveryChannelId: string;
      deliveryChannelName: string;
      senderId: string;
      senderName: string;
      senderType?: string;
      senderSource?: string;
      senderPid?: number;
      senderProjectPath?: string;
      targetParticipantId?: string;
      targetParticipantName?: string;
      replyTargetParticipantId: string;
    };
    alsoSentTo?: CrossChannelCopyResult; // Server-set: a human's message was also sent cross-channel to this agent
    client?: Record<string, unknown>; // T16 (2026-04-30): namespaced passthrough for client-supplied metadata. The /api/agent collab.message handler accepts only this subkey from request bodies — server retains exclusive ownership of every other top-level metadata field. First consumer: outlook-events.ts emit() (`{ kind: 'outlook.notification', payload: OutlookEvent }`).
  };
  reactions?: {                  // Emoji reactions on message
    [emoji: string]: string[];   // Emoji -> array of participant IDs who reacted
  };
  pinnedAt?: string;             // ISO timestamp when message was pinned
  pinnedBy?: string;             // Participant ID who pinned the message
  editedAt?: string;             // ISO timestamp when message was last edited
  system?: boolean;              // True for internal system messages (flush prompts etc) — hidden from UI
  silent?: boolean;              // True for silent system messages — delivered to agents via SSE but hidden from UI and poll history
}

export interface CollabChannel {
  id: string;
  name: string;                  // User-defined or auto-generated
  description?: string;          // Optional channel description
  parentChannelId?: string;      // If set, this is a sub-channel (private side conversation) of the given channel
  teamId?: string;               // Links channel back to source team template (set on team launch)
  projectId?: string;            // Links channel to a specific project
  createdAt: string;
  lastActivity: string;
  lastMessageAt?: string;          // Response-only: latest visible human/agent message, for sidebar ordering
  lastMessagePreview?: string;     // Response-only: "Sender: text" of that message, one short line, for the sidebar's Needs you list
  ownerId?: string;              // Participant ID who created the channel (only they can delete)
  participants: CollabParticipant[];
  messages: CollabMessage[];
  teamLeadId?: string;           // ID of the participant designated as Team Lead
  preferredNames?: Record<string, string>; // Maps stable participantId to preferred display name (survives rejoins)
  blockedParticipantIds?: string[]; // Participant IDs blocked from auto-rejoining after explicit removal
  blockedParticipantTimestamps?: Record<string, number>; // Unix ms timestamp when each entry was added (for TTL pruning)
  roster?: {
    agents: AgentRosterEntry[];
    lastUpdated: string;
  };
  removedRoster?: Array<{
    agentId: string;
    name: string;
    participantId: string;
    removedAt: string;
    reason: string;
    callerParticipantId?: string;
    callerName?: string;
  }>;
  pinnedAt?: string;             // ISO timestamp — pinned channels sort to top of channel list
  protected?: boolean;           // If true, channel cannot be deleted
  projectPath?: string;          // Filesystem path of the project this channel is associated with
  settings: {
    autoRespond: boolean;        // Auto-spawn browser agent when terminal posts
    respondingAgentName?: string; // Name for auto-spawned agent (default: "Assistant")
    reminderPausedUntil?: string; // ISO timestamp — sprint reminders are suppressed until this time
    category?: string;           // ChannelGroup id for the sidebar group; missing → the home group ('work'), unknown → the first group
  };
}

/** A sidebar tab channels are organised into (Work / Life / Fun + user-added). */
export interface ChannelTab {
  id: string;
  name: string;
}

/**
 * A sidebar group channels are organised into. Replaces the tab model: one ordered list in which
 * every group (Work, Life and Fun included) can be renamed, reordered and deleted. Ids are the
 * same as the old tab ids, so every channel's `settings.category` stays valid.
 */
export interface ChannelGroup {
  id: string;
  name: string;
}

export interface CollabChannelsData {
  channels: CollabChannel[];
  lastUpdated: string;
  channelTabs?: ChannelTab[];    // User-added tabs only; the built-in tabs are implicit. Kept for rollback; the new model is channelGroups
  channelGroups?: ChannelGroup[]; // Ordered sidebar groups (lib/collab-groups.ts). Missing = not migrated yet
}

/**
 * A full snapshot of a channel saved at archive time.
 * The channel object is preserved exactly (including roster, participants, settings).
 */
export interface ArchivedChannel {
  id: string;                    // Archive entry UUID (distinct from channel.id)
  channel: CollabChannel;        // Full channel snapshot — roster, participants, settings intact
  archivedAt: string;            // ISO timestamp when archived
  archivedBy?: string;           // Participant ID or 'user' who triggered the archive
  subChannelIds?: string[];      // IDs of sub-channels archived together with this parent
}

export interface ArchivedChannelsData {
  archives: ArchivedChannel[];
  lastUpdated: string;
}

/**
 * Per-channel message file structure (data/collab-messages/{channelId}.json)
 */
export interface ChannelMessagesData {
  channelId: string;
  messages: CollabMessage[];
  lastUpdated: string;
}

/**
 * Archived message batch (data/collab-messages/{channelId}-archive-{ts}.json)
 */
export interface ChannelMessagesArchive {
  channelId: string;
  messages: CollabMessage[];
  archivedAt: string;
  oldestTimestamp: string;
  newestTimestamp: string;
}

export interface CollabChannelResponse {
  channels: CollabChannel[];
  timestamp: string;
  participantId?: string;          // Server-resolved browser/WebGate identity used for unread counts
  channelTabs?: ChannelTab[];      // Full sidebar tab list (built-in + user-added)
  channelGroups?: ChannelGroup[];  // Ordered sidebar groups (the model that replaces tabs)
  error?: string;
}

/** An agent in another channel that a human's message is also sent to. */
export interface CrossChannelTarget {
  channelId: string;
  channelName: string;
  participantId: string;
  participantName: string;
}

/** Outcome of the cross-channel copy, stored on the human's local message. */
export interface CrossChannelCopyResult {
  channelId: string;
  channelName: string;
  participantName: string;
  ok: boolean;
  error?: string;
}

export interface CollabHostReport {
  hostId: string;
  pid: number | null;
  wrapperPid: number | null;
  tmuxSession: string | null;
  cwd: string;
  model: string | null;
}

export interface CollabChannelActionRequest {
  action: 'create' | 'create_subchannel' | 'reparent' | 'join' | 'message' | 'leave' | 'delete' | 'archive' | 'restore' | 'list_archived' | 'permanently_delete' | 'update_settings' | 'mark_read' | 'heartbeat' | 'react' | 'rename' | 'pin' | 'edit' | 'delete_message' | 'rename_participant' | 'recall' | 'create_tab' | 'create_group' | 'rename_group' | 'reorder_groups' | 'delete_group' | 'move_channel_to_group';
  category?: string;              // For 'create' / 'update_settings' - ChannelGroup id
  tabName?: string;               // For 'create_tab' (legacy; creates the tab and the matching group)
  groupId?: string;               // For 'rename_group' / 'delete_group' / 'move_channel_to_group'
  groupName?: string;             // For 'create_group' / 'rename_group'
  groupIds?: string[];            // For 'reorder_groups' - the new order
  parentChannelId?: string | null; // For 'reparent' - new parent channel ID (null to make top-level)
  channelId?: string;            // Required for all except 'create'
  crossChannelTarget?: { channelId: string; participantId: string }; // For 'message' - also deliver to an agent in another channel
  name?: string;                 // For 'create' and 'rename'
  description?: string;          // For 'rename' - channel description
  ownerId?: string;              // For 'create' - participant ID of channel creator
  projectId?: string;            // For 'create'/'update_settings' - links channel to a project
  participant?: Omit<CollabParticipant, 'joinedAt' | 'lastSeen'>; // For 'join'
  force?: boolean;               // For 'join' - bypass block list (explicit re-invite from UI)
  participantId?: string;        // For 'message', 'leave', 'mark_read', 'heartbeat', 'react', 'rename', 'pin', and 'delete'
  messageTimestamp?: string;     // For 'mark_read' - advance lastRead to this specific timestamp only (prevents race condition)
  messageId?: string;            // For 'react' and 'pin'
  content?: string;              // For 'message'
  mentions?: string[];           // For 'message'
  replyTo?: string;              // For 'message'
  voiceResponseContext?: {       // Wrapper-provided active delivery identity; server validates before attaching voice metadata
    recordId: string;
    messageId: string;
    conversationSessionId: string;
    audioTurnId: string;
    revision: number;
  };
  image?: {                      // For 'message' - attached image (deprecated, use images)
    data: string;
    name: string;
    type: string;
  };
  images?: Array<{               // For 'message' - multiple attached files (images + documents)
    data: string;
    name: string;
    type: string;
    size?: number;               // File size in bytes
    clientId?: string;           // Composer-only ID for resolving an inline attachment reference
  }>;
  emoji?: string;                // For 'react' - emoji to toggle
  participantIds?: string[];     // For 'create_subchannel' - participants to invite
  settings?: CollabChannel['settings']; // For 'update_settings'
  teamLeadId?: string;           // For 'update_settings'
  pinned?: boolean;              // For 'update_settings' — pin/unpin channel to top
  projectPath?: string;          // For 'update_settings' or 'rename' — associate/move the channel project directory
  status?: CollabPresenceStatus; // For 'heartbeat'
  activityStatus?: CollabActivityStatus; // For 'heartbeat' - typing/working/idle
  activityDetail?: string | null; // For 'heartbeat' - human-readable label ("Reading file...", "Thinking...", etc)
  host?: CollabHostReport;       // For 'heartbeat' - wrapper-reported host facts
  block?: boolean;               // For 'leave' - add to blocked list (default true for non-roster agents; false = remove without blocking)
  permanent?: boolean;           // For 'delete' - if true, skip archive and permanently delete (default: false = soft-delete)
  archiveId?: string;            // For 'restore' and 'permanently_delete' - the archive entry ID
  includeSubChannels?: boolean;  // For 'list_archived' - include sub-channel archive entries
  metadata?: Record<string, unknown>; // For 'message' - extra metadata (e.g. Teams bridge echo prevention)
  isHidden?: boolean;                // For 'message' - hide in the human feed; preserve normal agent delivery
  silent?: boolean;                  // For 'message' - if true, store in silent-messages (not main feed)
}

export interface CollabChannelActionResponse {
  success: boolean;
  channelId?: string;
  participantId?: string;
  messageId?: string;
  deduplicated?: boolean;          // True when message was dropped as duplicate
  message?: { id: string };        // Original message ID when deduplicated
  channel?: CollabChannel;       // Returned on create/join for immediate use
  tab?: ChannelTab;              // Returned on create_tab
  channelTabs?: ChannelTab[];    // Returned on create_tab — full tab list
  group?: ChannelGroup;          // Returned on create_group / rename_group
  channelGroups?: ChannelGroup[]; // Returned by every group action — the full ordered list
  movedTo?: ChannelGroup;        // Returned on delete_group — the group its channels moved to
  movedChannelCount?: number;    // Returned on delete_group — top-level channels that were shown in the deleted group
  teamLeadId?: string;           // Returned on join
  deletedSubChannels?: number;   // Returned on delete when sub-channels were cascade-deleted
  archiveId?: string;            // Returned on archive/soft-delete — the archive entry ID
  archivedSubChannels?: number;  // Returned on archive — count of sub-channels archived
  restoredSubChannels?: number;  // Returned on restore — count of sub-channels restored
  error?: string;
}

// Poll response for terminal agents
export interface CollabPollResponse {
  messages: CollabMessage[];     // Messages since the 'since' timestamp
  participants: CollabParticipant[]; // Current participant list
  timestamp: string;             // Use as 'since' for next poll
  hasMore?: boolean;             // True if there are older messages available
  oldestTimestamp?: string;      // Timestamp of oldest message returned (for cursor pagination)
  roster?: {                     // Roster agents — included so frontend updates status every poll cycle
    agents: AgentRosterEntry[];
    lastUpdated: string;
  };
  error?: string;
}

// PTY Session for collab agents
export type PtySessionStatus = 'starting' | 'ready' | 'responding' | 'idle' | 'error' | 'closed';

export interface CollabPtySession {
  id: string;                    // UUID for this PTY session
  participantId: string;         // Links to CollabParticipant
  channelId: string;             // Which channel this PTY is for
  status: PtySessionStatus;
  createdAt: string;             // ISO timestamp
  lastActivity: string;          // ISO timestamp
  currentResponseId?: string;    // Message ID if currently streaming a response
  pid?: number;                  // PTY process ID
  model?: string;                // Claude model being used
  error?: string;                // Error message if status is 'error'
}

export interface CollabPtySessionsData {
  sessions: CollabPtySession[];
  lastUpdated: string;
}

// ============================================
// App Registry Types (App Library Dashboard)
// ============================================

export type AppCategory = 'development' | 'ai' | 'media' | 'automation' | 'monitoring' | 'utility' | 'other';

export interface AppRegistryEntry {
  id: string;                        // UUID
  name: string;                      // Display name
  description: string;               // Short description
  icon: string;                      // Emoji or lucide icon name (e.g. "rocket" or "🚀")
  iconType: 'emoji' | 'lucide';     // How to render the icon
  color: string;                     // Accent color for the card (hex)
  category: AppCategory;
  tags: string[];
  url?: string;                      // Launch URL (e.g. http://localhost:3000)
  tunnelUrl?: string;                // WebGate tunnel URL — enriched at API level from gateway-services.json
  webGate?: {                        // WebGate config — enriched at API level, never persisted
    name: string;
    url: string;
    port: number;
    status: 'active' | 'inactive' | 'error';
    locked: boolean;
  };
  path?: string;                     // Local filesystem path
  pm2Name?: string;                  // PM2 process name for starting/stopping the service
  alwaysOn?: boolean;                // Start with DevFlow and watch/recover the PM2 service
  runsOn?: string;                   // Machine hostname (the desktop | devflow) the PM2 service lives on; the Always-On watchdog skips it elsewhere. Unset = any host
  healthCheck?: {                    // Optional health check
    type: 'port' | 'http';
    target: string;                  // Port number or URL
  };
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  // Auto-registration fields — set by pm2-auto-register daemon, cleared on manual edit
  source?: 'manual' | 'auto';       // How the entry was created
  autoRegistered?: boolean;          // True if registered by daemon (needs user review)
  portConflict?: {                   // Set if port was already claimed at registration time
    port: number;
    conflictsWith: string;           // Name of conflicting process
  };
}

export interface AppRegistryData {
  apps: AppRegistryEntry[];
  lastUpdated: string;
}

// ============================================
// Agent Role Types
// ============================================

export interface AgentRole {
  id: string;                        // UUID
  name: string;                      // Display name ("Backend Dev", "Researcher")
  slug: string;                      // Kebab-case for filename ("backend-dev", "researcher")
  description?: string;              // Short description of the role
  mdPath: string;                    // Path to the role .md file (e.g., "data/roles/backend-dev.md")
  mcpServers?: string[];             // MCP server names to pre-enable at provision (Sprint 38 T3.2). Empty/missing → universal default ['qdrant', 'snapshot'] via resolveMcpServersForRole.
  capabilities?: string[];           // Capability tokens for this role (e.g. ["browser","chrome"]). Used by /invite router to match agents.
  characterIds?: string[];            // Personality catalogue IDs offered by the role-first Add Agent flow.
  defaultCharacterId?: string;        // Character preselected for the common Add Agent path.
  recommendedModelId?: string;        // Model preselected for new agents in this role.
  builtIn?: boolean;                 // If true, role cannot be deleted via API
  createdAt: string;
  updatedAt: string;
}

// ============================================
// Agent Roster Types (Persistent Agent Management)
// ============================================

export type AgentRosterStatus = 'running' | 'stopped' | 'crashed' | 'starting' | 'away' | 'restarting' | 'shutting-down';

export interface AgentRosterEntry {
  id: string;                        // UUID - stable identity
  name: string;                      // Display name ("Vini")
  workingDirectory: string;          // Absolute path
  channelId: string;                 // Parent channel
  participantId: string;             // Stable collab participant ID
  color: string;                     // Persisted UI color

  // Runtime
  status: AgentRosterStatus;
  statusChangedAt?: string;           // Set when a graceful shutdown/restart marks the agent; lets a stuck transition be detected
  pid?: number;
  tmuxSessionName?: string;
  ptySessionId?: string;
  ptySessionStatus?: PtySessionStatus; // Response-only enrichment (GET /api/collab) — live session status for per-message (powershell) agents. Never persisted to collab-channels.json.
  effectiveWorkingDirectory?: string; // Agent-specific workspace path (set at spawn time)

  // Home channel — immutable anchor set on first join, agent always returns here
  homeChannelId?: string;            // Channel where agent belongs (set on first join or roster creation)
  homeChannelName?: string;          // Display name of home channel

  // Away tracking (when agent is in another channel)
  awayInChannelId?: string;          // Channel where agent currently is (when status = 'away')
  awayInChannelName?: string;        // Display name of that channel

  // Resume
  lastClaudeSessionId?: string;      // For `claude --resume`
  autoResume: boolean;               // Use --resume on respawn

  // Config
  useCollabWrapper: boolean;         // Use collab-claude.py (default: true)
  dangerouslySkipPermissions: boolean;
  claudeFlags?: string[];
  roleId?: string;                   // Links to AgentRole — injects role .md at spawn
  model?: string;                    // Claude model: 'opus', 'sonnet', 'haiku' (default: account default)
  agentType?: 'claude' | 'gemini' | 'grok' | 'codex' | 'antigravity';  // Agent runtime type (default: 'claude')
  deliveryProtocol?: 'ledger-v1'; // Persisted wrapper capability for stopped-agent delivery
  spawnMode?: 'wsl' | 'powershell'; // Execution environment (default: 'wsl' = tmux, 'powershell' = claude.exe per-message)
  harnessHealth?: { credentialId: string; state: 'needs_login' | 'limit_reached'; detail: string; resetsAt?: string; since: string; reportedAt?: string }; // Present only while the agent's harness login is broken or at its limit. Written by POST /api/system/harness-auth/report (lib/harness-auth); hide it when reportedAt is older than 15 minutes (watcher down)
  runLocation?: 'server'; // Machine the agent runs on: unset = the owner's desktop (WSL or PowerShell per spawnMode), 'server' = DevFlow server. Drives the generated Runtime-Location.md note.
  psWorkingDirectory?: string;       // Windows-native working directory when spawnMode = 'powershell' (e.g. C:\Users\<windows-user>\Team\Agent)
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';  // Reasoning effort. Codex applies changes live; other runtimes use it on spawn.
  fastMode?: boolean;                 // Codex Fast mode (1.5x). Applied live and explicitly restored on spawn.
  liveModel?: string;                 // Response-only enrichment from the live Codex TUI. Never persisted.
  liveEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'; // Response-only enrichment from the live Codex TUI. Never persisted.
  liveFastMode?: boolean;             // Response-only enrichment from the live Codex TUI. Never persisted.
  runtimeConfigPending?: {            // Durable live-apply request retried when the Codex prompt becomes idle.
    revision: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    fastMode?: boolean;
    requestedAt: string;
  };
  personality?: string;              // Character personality name (e.g. 'Tealc', 'Picard') — maps to data/roles/personalities/{name}.md
  mcpServers?: string[];             // List of enabled MCP server names (from ~/.mcp.json / project .mcp.json)
  temporary?: boolean;               // If true, agent is ephemeral — removable via "Remove from Channel" and auto-cleaned from roster on leave
  disableAcp?: boolean;              // If true, use legacy API wrapper instead of ACP harness (grok agents only)

  // Context health — posted to POST /api/agent/context-health. Since 18 Oct 2026 the writer is scripts/context_sampler.py,
  // which reads each agent's own transcript; readings older than lib/context-health/merge.ts CONTEXT_HEALTH_MAX_AGE_MS are not shown.
  lastContextHealth?: {
    percent: number;    // 0–100 context fill percentage
    turnCount: number;  // turn number at time of report
    model: string;      // model in use at report time
    reportedAt: string; // ISO timestamp
    tokens?: number;    // context tokens behind the percentage
    window?: number;    // context window the tokens were measured against
    source?: string;    // who measured it, e.g. 'transcript-sampler'
  };

  // Meta
  createdAt: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  crashCount: number;
}

// ============================================
// Collaboration Task Board Types
// ============================================

export type CollabTaskStatus = 'todo' | 'in_progress' | 'done';
export type CollabTaskPriority = 'low' | 'normal' | 'high';

// Sprint and Phase hierarchy types
export type CollabSprintStatus = 'planned' | 'active' | 'completed' | 'cancelled';

export interface CollabSprint {
  id: string;                      // UUID
  channelId: string;
  name: string;                    // "Sprint 1: Core Features"
  description?: string;
  status: CollabSprintStatus;
  startDate?: string;              // ISO timestamp
  endDate?: string;                // ISO timestamp
  createdBy: string;               // Participant ID
  createdAt: string;
  updatedAt: string;
  sortOrder: number;               // Position in sprint list
  activatedAt?: string;            // ISO timestamp — when sprint was last set to active (idle clock floor)
  // Sprint-stall reminder fields (Sprint 61)
  reminderSnoozeUntil?: string;    // ISO timestamp — reminders suppressed until this time
  reminderSnoozeReason?: string;   // Human-readable reason for snooze
  lastReminderSentAt?: string;     // ISO timestamp — throttle: don't send two in one window
  reminderCount?: number;          // Total reminders sent (for future escalation logic)
}

export interface CollabPhase {
  id: string;                      // UUID
  sprintId?: string;               // Parent sprint (optional — may be unset if sprint was deleted)
  channelId: string;
  name: string;                    // "Phase 1: Authentication"
  description?: string;
  sortOrder: number;               // Position within sprint
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  color?: string;                  // Visual indicator (e.g., "#3B82F6")
}

export interface CollabTask {
  id: string;                      // UUID
  channelId: string;               // Which channel this task belongs to
  title: string;                   // Task title
  description?: string;            // Optional detailed description
  status: CollabTaskStatus;
  priority: CollabTaskPriority;
  sortOrder: number;               // Position within status column (lower = higher)
  createdBy: string;               // Participant ID who created the task
  createdAt: string;               // ISO timestamp
  assigneeId?: string;             // Participant ID assigned to task
  assignedAt?: string;             // When assignment happened
  completedAt?: string;            // When marked done
  updatedAt: string;               // Last modification
  tags?: string[];                 // Optional tags for categorization
  notes?: string;                  // Free-form progress notes from the claimer
  resolution?: string;             // Final outcome / what was actually shipped
  // Hierarchy fields (optional for backward compatibility)
  sprintId?: string;               // Parent sprint (null = unassigned)
  phaseId?: string;                // Parent phase (null = unassigned)
}

export interface CollabTasksData {
  tasks: CollabTask[];
  sprints?: CollabSprint[];        // Sprints embedded in same file for atomic operations
  phases?: CollabPhase[];          // Phases embedded in same file for atomic operations
  /** Idempotent completion receipts, keyed by receiptId(); written with the mutation, never pruned. */
  completionReceipts?: Record<string, CollabTaskCompletionReceipt>;
  lastUpdated: string;
}

/** Record of a successful idempotent completion (lib/task-completion.ts). */
export interface CollabTaskCompletionReceipt {
  channelId: string;
  taskId: string;
  action: 'complete';
  idempotencyKey: string;
  requestHash: string;             // sha256 of the effective request (participant + guards)
  participantId: string;
  recordedAt: string;              // revision the completion produced
  task: CollabTask;                // task as completed by that request
}

export interface CollabTasksResponse {
  tasks: CollabTask[];
  timestamp: string;
  error?: string;
}

export interface CollabTaskActionRequest {
  action: 'create' | 'update' | 'claim' | 'unclaim' | 'complete' | 'delete' | 'reorder' | 'create-sprint' | 'create-phase' | 'update-sprint' | 'delete-sprint';
  channelId: string;
  taskId?: string;                 // Required for update, claim, unclaim, complete, delete, reorder
  participantId: string;           // Who is performing the action
  title?: string;                  // For create/update
  description?: string;            // For create/update
  priority?: CollabTaskPriority;   // For create/update
  status?: CollabTaskStatus;       // For update
  tags?: string[];                 // For create/update
  notes?: string;                  // For update — claimer's progress notes
  resolution?: string;             // For update — final outcome
  assigneeId?: string;             // For update — admin reassignment ('' or null clears)
  sortOrder?: number;              // For reorder - new position
  targetStatus?: CollabTaskStatus; // For reorder - move to different column
  // Sprint/Phase fields
  sprintId?: string;               // For create, create-phase, update-sprint, delete-sprint
  phaseId?: string;                // For create - assign task to a phase
  name?: string;                   // For create-sprint, create-phase
  startDate?: string;              // For create-sprint
  endDate?: string;                // For create-sprint
  color?: string;                  // For create-phase
  updates?: Partial<CollabSprint>; // For update-sprint
  // Optional completion guards and retry key (action 'complete'; see lib/task-completion.ts)
  expectedAssigneeId?: string | null; // null = expect the task to be unassigned
  expectedUpdatedAt?: string;         // the task's updatedAt as read by the caller
  idempotencyKey?: string;            // same key + same request = replay the recorded result
}

export interface CollabTaskActionResponse {
  success: boolean;
  taskId?: string;
  task?: CollabTask;
  /** Stable error code: TASK_COMPLETION_CONFLICT | IDEMPOTENCY_KEY_REUSED | INVALID_COMPLETION_REQUEST */
  code?: string;
  conflicts?: Array<{ field: 'assigneeId' | 'updatedAt'; expected: string | null; current: string | null }>;
  current?: { status: CollabTaskStatus; assigneeId: string | null; updatedAt: string };
  /** Idempotent completion: true when `task` is the recorded historical result, not a new completion. */
  replayed?: boolean;
  receipt?: { idempotencyKey: string; recordedAt: string; participantId: string };
  liveTask?: CollabTask | null;    // current task state on a replay (null if deleted)
  liveStateChanged?: boolean;      // on a replay: the live task differs from the recorded result
  sprint?: CollabSprint;           // For create-sprint, create-phase, update-sprint, delete-sprint
  phase?: CollabPhase;             // For create-phase
  deleted?: boolean;               // For delete-sprint
  error?: string;
}

// ============================================
// Agent API Types (Token Authentication)
// ============================================

/**
 * API Token permission scopes
 * - read: Query all resources, list endpoints only
 * - write: Create, update, delete most resources
 * - admin: Manage tokens, delete channels, full access
 */
export type ApiTokenScope = 'read' | 'write' | 'admin';

/**
 * Individual API token record
 * Note: The actual token is never stored - only its SHA-256 hash
 */
export interface ApiToken {
  id: string;                       // UUID
  name: string;                     // User-friendly name (e.g., "CI/CD Pipeline")
  tokenHash: string;                // SHA-256 hash of full token
  tokenPrefix: string;              // First 8 chars for display (e.g., "dvf_live")
  scope: ApiTokenScope;
  createdAt: string;                // ISO timestamp
  createdBy: string;                // Who created it (for audit)
  expiresAt: string | null;         // ISO timestamp or null for never
  lastUsedAt: string | null;        // ISO timestamp
  lastUsedIp: string | null;        // Last IP that used this token
  revokedAt: string | null;         // ISO timestamp if revoked
  revokedBy: string | null;         // Who revoked it
  usageCount: number;               // Total API calls
  metadata?: {
    description?: string;
    environment?: 'production' | 'development' | 'testing';
    allowedIps?: string[];          // IP allowlist (optional)
    keepAlive?: boolean;            // Exempt from 7-day TTL auto-pruning
  };
}

/**
 * Rate limit tracking per token
 */
export interface ApiTokenRateLimit {
  windowStart: number;              // Unix timestamp
  requestCount: number;
}

/**
 * Failed authentication attempt tracking
 */
export interface ApiTokenFailedAttempt {
  count: number;
  firstAttempt: number;             // Unix timestamp
  lastAttempt: number;              // Unix timestamp
}

/**
 * API tokens configuration
 */
export interface ApiTokensConfig {
  maxTokensPerUser: number;         // Limit tokens (default: 10)
  defaultExpiration: number;        // Days (default: 0 = never)
  requireExpiration: boolean;       // Force expiration (default: false)
  rateLimitWindow: number;          // Seconds (default: 60)
  rateLimitMax: number;             // Requests per window (default: 100)
}

/**
 * API tokens data storage
 */
export interface ApiTokensData {
  tokens: ApiToken[];
  config: ApiTokensConfig;
  rateLimits: Record<string, ApiTokenRateLimit>;
  failedAttempts: Record<string, ApiTokenFailedAttempt>;
  lastUpdated: string;
}

/**
 * Error codes for Agent API responses
 */
export type AgentApiErrorCode =
  // Authentication
  | 'AUTH_MISSING'           // No Authorization header
  | 'AUTH_INVALID'           // Invalid token format or wrong token
  | 'AUTH_EXPIRED'           // Token expired
  | 'AUTH_REVOKED'           // Token revoked
  | 'AUTH_INSUFFICIENT'      // Missing required permission
  | 'TOKEN_STORE_UNREADABLE' // The token file is not valid JSON; a copy was kept and nothing was overwritten
  // Validation
  | 'INVALID_ACTION'         // Unknown action
  | 'MISSING_FIELD'          // Required field missing
  | 'INVALID_FIELD'          // Field validation failed
  // Resource
  | 'NOT_FOUND'              // Resource doesn't exist
  | 'CONFLICT'               // Resource conflict (e.g., duplicate)
  | 'LOCKED'                 // Resource is locked
  | 'RECIPIENTS_OFFLINE'     // Every addressed agent in the target channel is offline
  | 'TASK_COMPLETION_CONFLICT' // Completion guard did not match the live task
  | 'IDEMPOTENCY_KEY_REUSED' // Idempotency key already used with a different request
  | 'INVALID_COMPLETION_REQUEST' // Malformed completion guard or idempotency key
  // Rate Limiting
  | 'RATE_LIMITED'           // Too many requests
  | 'QUOTA_EXCEEDED'         // Usage quota exceeded
  // Server
  | 'INTERNAL_ERROR'         // Unexpected server error
  | 'SERVICE_UNAVAILABLE';   // Dependency unavailable

/**
 * Agent API request base
 */
export interface AgentApiRequest {
  action: string;                   // e.g., "projects.list", "collab.message"
  [key: string]: unknown;           // Action-specific fields
}

/**
 * Agent API response
 */
export interface AgentApiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  code?: AgentApiErrorCode;
  timestamp: string;
  requestId?: string;               // For debugging/tracking
  timing?: number;                  // Request duration in ms
}

/**
 * Token validation result
 */
export interface ApiTokenValidationResult {
  valid: boolean;
  token?: ApiToken;
  error?: string;
  code?: AgentApiErrorCode;
  /** Set with code RATE_LIMITED: seconds until the token (or the blocked address) may try again. */
  retryAfterSeconds?: number;
}

/**
 * Auth context passed to action handlers
 */
export interface AgentAuthContext {
  tokenId: string;
  tokenName: string;
  scope: ApiTokenScope;
  createdBy: string;
  requestId?: string;                // For tracing requests through handler chains
}

/**
 * Action handler function type
 */
export type AgentActionHandler = (
  body: AgentApiRequest,
  auth: AgentAuthContext
) => Promise<unknown>;

/**
 * Action registry entry
 */
export interface AgentActionEntry {
  handler: AgentActionHandler;
  requiredScope: ApiTokenScope;
  description: string;
}

// ============================================
// Persistent Team Types
// ============================================

export interface TeamAgentDefinition {
  id: string;                          // UUID — stable identity across launches
  name: string;                        // Display name ("Vini")
  workingDirectory: string;
  color: string;
  autoResume: boolean;
  useCollabWrapper: boolean;
  dangerouslySkipPermissions: boolean;
  claudeFlags?: string[];
  roleId?: string;                     // Links to AgentRole — injects role .md at spawn
  lastClaudeSessionId?: string;        // Persists across launches for --resume
  lastLaunchedAt?: string;
  launchCount: number;
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  description?: string;
  projectId?: string;                    // Links team to a specific project
  agents: TeamAgentDefinition[];
  createdAt: string;
  updatedAt: string;
  launchCount: number;
  lastLaunchedAt?: string;
}

export interface TeamsData {
  teams: Team[];
  lastUpdated: string;
}

// Token Management API Types

export interface CreateTokenRequest {
  keepAlive?: boolean;             // Explicit service-token retention; does not bypass expiry/revocation
  name: string;
  scope: ApiTokenScope;
  expiresInDays?: number;           // null or 0 = never
  description?: string;
  environment?: 'production' | 'development' | 'testing';
  allowedIps?: string[];
}

export interface CreateTokenResponse {
  success: true;
  token: string;                    // Full token - ONLY returned on creation
  tokenId: string;
  name: string;
  scope: ApiTokenScope;
  expiresAt: string | null;
}

export interface ListTokensResponse {
  success: true;
  tokens: Array<{
    id: string;
    name: string;
    tokenPrefix: string;
    scope: ApiTokenScope;
    createdAt: string;
    createdBy: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    usageCount: number;
    isRevoked: boolean;
    metadata?: ApiToken['metadata'];
  }>;
}

export interface RevokeTokenResponse {
  success: true;
  message: string;
}

// ============================================
// Idea Board Types
// ============================================

export interface IdeaImage {
  id: string;                          // UUID
  filename: string;                    // Stored filename (e.g., "idea-abc123-1.png")
  originalName: string;                // Original upload filename
  mimeType: string;                    // MIME type (image/png, image/jpeg, etc.)
  url: string;                         // Served URL (e.g., "/api/ideas/images/idea-abc123-1.png")
  width?: number;
  height?: number;
  size?: number;                       // File size in bytes
}

export interface Idea {
  id: string;                          // UUID
  title: string;
  description: string;                 // Rich text / markdown content
  images: IdeaImage[];                 // Attached images
  tags: string[];                      // User-defined tags for filtering
  channelId?: string;                  // Linked collab channel (for "Discuss with Agents")
  createdBy: string;                   // "browser-user" or participant ID
  createdAt: string;                   // ISO timestamp
  updatedAt: string;                   // ISO timestamp
  sortOrder: number;                   // Position in board
  archived?: boolean;                  // Soft-delete / archive
}

export interface IdeaBoardData {
  ideas: Idea[];
  lastUpdated: string;
}

export interface IdeaActionRequest {
  action: 'create' | 'update' | 'delete' | 'list' | 'get' | 'reorder' | 'archive' | 'upload_image' | 'link_channel';
  ideaId?: string;                     // Required for update, delete, get, archive, upload_image
  title?: string;                      // For create/update
  description?: string;                // For create/update
  tags?: string[];                     // For create/update
  channelId?: string;                  // For create/update — link to collab channel
  sortOrder?: number;                  // For reorder
  image?: {                            // For upload_image — base64 image data
    data: string;                      // Base64 data URL
    name: string;                      // Original filename
    type: string;                      // MIME type
  };
}

export interface IdeaActionResponse {
  success: boolean;
  idea?: Idea;
  ideas?: Idea[];
  imageUrl?: string;                   // Returned on upload_image
  error?: string;
}

// ============================================
// Feature Docs Types (Sprint Summaries)
// ============================================

export interface FeatureDoc {
  id: string;                          // UUID
  channelId: string;                   // Which channel's sprints were summarized
  title: string;                       // Generated title (e.g., "Sprint 1: Core Features")
  content: string;                     // Markdown summary of implemented features
  sprintIds: string[];                 // Which sprints were included
  sprintNames: string[];               // Sprint names for display
  taskCount: number;                   // Total tasks summarized
  generatedAt: string;                 // ISO timestamp
  exportPath?: string;                 // Filesystem path where .MD was auto-exported (if channel has projectPath)
}

export interface FeatureDocsData {
  docs: FeatureDoc[];
  lastUpdated: string;
}

export interface FeatureDocActionRequest {
  action: 'generate' | 'list' | 'get' | 'delete' | 'backfill';
  channelId?: string;                  // Required for generate/list
  docId?: string;                      // Required for get/delete
  clearSprints?: boolean;              // For generate — archive sprints after summarization
}

export interface FeatureDocActionResponse {
  success: boolean;
  doc?: FeatureDoc;
  docs?: FeatureDoc[];
  error?: string;
}

// ============================================================================
// Terminal Tasks (AI Terminal Sessions)
// ============================================================================

export type TerminalTaskEngine = 'claude' | 'gemini' | 'ollama' | 'grok';
export type TerminalTaskModel = 'haiku' | 'sonnet' | 'opus';
export type TerminalTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface TerminalTask {
  id: string;
  status: TerminalTaskStatus;
  prompt: string;
  model: TerminalTaskModel;
  engine: TerminalTaskEngine;
  systemPrompt?: string;
  // For Ollama: the specific model name (e.g. "qwen3-vl:8b")
  ollamaModel?: string;

  // Runtime
  tmuxSessionName?: string;
  pid?: number;

  // Results
  output: string;
  error?: string;

  // Timing
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  timeout: number; // seconds

  // Metadata
  createdBy: string;
  workingDirectory?: string;
}

export interface TerminalTasksData {
  tasks: TerminalTask[];
  lastUpdated: string;
}

export interface TerminalTaskActionRequest {
  action: 'submit' | 'list' | 'get' | 'cancel' | 'models' | 'launch';
  // submit
  prompt?: string;
  model?: TerminalTaskModel;
  engine?: TerminalTaskEngine;
  ollamaModel?: string;
  systemPrompt?: string;
  timeout?: number;
  workingDirectory?: string;
  // Environment variables exported into the tmux session via `tmux -e`.
  // Used by the computer-use dispatcher to pass CU_BRIDGE_URL, CU_SESSION_ID, CU_TASK_ID.
  env?: Record<string, string>;
  // Override the per-engine idle-output threshold (ms). Useful for long-running
  // tool-use loops (e.g. computer-use) where 8s default would falsely complete.
  idleThresholdMs?: number;
  // get / cancel
  taskId?: string;
  // launch
  provider?: string;
}

// A live terminal session opened for subscription-based auth
export interface TerminalLaunchSession {
  sessionName: string;
  provider: string;
  displayName: string;
  instructions: string;
  attachCommand: string;
  createdAt: string;
}

export interface TerminalTaskActionResponse {
  success: boolean;
  task?: TerminalTask;
  tasks?: TerminalTask[];
  models?: TerminalModelInfo[];
  launchSession?: TerminalLaunchSession;
  error?: string;
}

// Model registry: lists available models across all engines
export interface TerminalModelInfo {
  engine: TerminalTaskEngine;
  model: string;        // Model identifier (e.g. "sonnet", "qwen3-vl:8b")
  displayName: string;  // Human-readable name
  description?: string;
  available: boolean;   // Whether the engine/model is currently accessible
  size?: string;        // For Ollama: model size on disk
}

// ============================================================================
// PowerShell Sessions (Cross-Platform Shell Access)
// ============================================================================

export type PowerShellSessionStatus = 'active' | 'closed' | 'error' | 'timeout';

export interface PowerShellSession {
  id: string;
  status: PowerShellSessionStatus;
  tmuxSessionName: string;
  pid?: number;

  // Command history
  commands: PowerShellCommand[];

  // Timing
  createdAt: string;
  lastActivityAt: string;
  closedAt?: string;
  timeout: number; // seconds, 0 = no timeout

  // Metadata
  createdBy: string;
}

export interface PowerShellCommand {
  id: string;
  command: string;
  output: string;
  sentAt: string;
  completedAt?: string;
}

export interface PowerShellSessionsData {
  sessions: PowerShellSession[];
  lastUpdated: string;
}

export interface PowerShellActionRequest {
  action: 'create' | 'list' | 'get' | 'send' | 'output' | 'close';
  // create
  timeout?: number;
  // send
  sessionId?: string;
  command?: string;
  // output - get output since last read
  since?: string; // ISO timestamp
}

export interface PowerShellActionResponse {
  success: boolean;
  session?: PowerShellSession;
  sessions?: PowerShellSession[];
  output?: string;
  error?: string;
}

// ============================================================================
// Cron Jobs (Scheduled Tasks)
// ============================================================================

/**
 * Job execution types:
 * - shell: Run a shell command directly
 * - tmux-send: Send text to a running tmux session (e.g., trigger Jack to write logs)
 * - api-call: Make an HTTP request to an API endpoint
 * - agent-reminder: Queue an exact channel/participant reminder via the durable delivery ledger
 */
export type CronJobType = 'shell' | 'tmux-send' | 'api-call' | 'agent-reminder';

export type CronJobStatus = 'active' | 'paused' | 'error';

export interface CronJob {
  id: string;                          // UUID
  name: string;                        // Human-readable name (e.g., "Jack Nightly Log")
  schedule: string;                    // Cron expression (e.g., "0 4 * * *")
  jobType: CronJobType;
  enabled: boolean;                    // Whether the job is scheduled to run

  // Job-type-specific config
  command?: string;                    // For 'shell': the shell command to execute
  tmuxTarget?: string;                 // For 'tmux-send': static tmux session:window.pane target (stale-prone if agent respawns)
  agentName?: string;                  // For 'tmux-send': preferred — resolves to the agent's live tmuxSessionName via roster at execution time
  tmuxText?: string;                   // For 'tmux-send': text to send (Enter appended automatically)
  apiUrl?: string;                     // For 'api-call': full URL
  apiMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  apiHeaders?: Record<string, string>; // For 'api-call': custom headers
  apiBody?: string;                    // For 'api-call': request body (JSON string)
  reminderChannelId?: string;          // For 'agent-reminder': exact channel UUID
  reminderParticipantId?: string;      // For 'agent-reminder': exact roster participant ID
  reminderText?: string;               // For 'agent-reminder': text delivered by DevFlow Scheduled Jobs

  // Runtime state (not persisted separately — updated on each run)
  status: CronJobStatus;
  lastRun?: string;                    // ISO timestamp of last execution
  lastRunDurationMs?: number;          // Duration of last execution
  lastRunExitCode?: number;            // Exit code of last execution (shell only)
  lastRunError?: string;               // Error message if last run failed
  nextRun?: string;                    // ISO timestamp of next scheduled execution

  // Metadata
  createdAt: string;
  updatedAt: string;
  createdBy: string;                   // Who created this job (participant ID or "system")
  tags?: string[];                     // Optional tags for categorization
  description?: string;                // Optional human-readable description
  timeoutMs?: number;                  // Max execution time (default: 60000 = 1 min)
  timezone?: string;                   // IANA TZ name for schedule evaluation (e.g. "Europe/London"). Default: process.env.TZ or system local. Older jobs without this field used to be evaluated in Australia/Brisbane (hard-coded) — fixed 2026-05-18, see cron-scheduler.ts:scheduleJob.
}

/**
 * Individual execution record (stored in per-job log files)
 */
export interface CronExecution {
  id: string;                          // UUID
  jobId: string;                       // Parent CronJob ID
  jobName: string;                     // Snapshot of job name at execution time
  startedAt: string;                   // ISO timestamp
  completedAt?: string;                // ISO timestamp (null if still running)
  durationMs?: number;
  exitCode?: number;                   // Shell exit code (0 = success)
  output?: string;                     // Stdout/stderr (truncated to ~10KB)
  error?: string;                      // Error message if failed
  status: 'running' | 'success' | 'failed' | 'timeout';
  trigger: 'scheduled' | 'manual';    // How this execution was triggered
}

/**
 * Cron jobs data storage (data/cron-jobs.json)
 */
export interface CronJobsData {
  jobs: CronJob[];
  lastUpdated: string;
}

/**
 * Per-job execution log (data/cron-logs/{jobId}.json)
 */
export interface CronJobLogData {
  jobId: string;
  executions: CronExecution[];
  lastUpdated: string;
}

/**
 * Cron API action request
 */
export interface CronActionRequest {
  action: 'list' | 'create' | 'update' | 'delete' | 'toggle' | 'trigger' | 'history';
  jobId?: string;                      // Required for update, delete, toggle, trigger, history
  // For create/update
  name?: string;
  schedule?: string;
  jobType?: CronJobType;
  enabled?: boolean;
  command?: string;
  tmuxTarget?: string;
  agentName?: string;                  // For 'tmux-send': live-resolve tmuxTarget from roster at execution time
  tmuxText?: string;
  apiUrl?: string;
  apiMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  apiHeaders?: Record<string, string>;
  apiBody?: string;
  reminderChannelId?: string;
  reminderParticipantId?: string;
  reminderText?: string;
  description?: string;
  tags?: string[];
  timeoutMs?: number;
  timezone?: string;                   // IANA TZ name (e.g. "UTC", "Europe/London")
  // For history
  limit?: number;                      // Max executions to return (default: 50)
}

/**
 * Cron API action response
 */
export interface CronActionResponse {
  success: boolean;
  job?: CronJob;
  jobs?: CronJob[];
  executions?: CronExecution[];
  error?: string;
}

// ============================================================================
// Service Watchdog Types
// ============================================================================

export type WatchdogEventType = 'restart_attempt' | 'restart_success' | 'restart_failed' | 'cooldown_started' | 'cooldown_ended' | 'port_conflict' | 'circuit_broken';

export interface WatchdogEvent {
  id: string;
  projectId: string;
  projectName: string;
  eventType: WatchdogEventType;
  message: string;
  timestamp: string;
  restartCount?: number;        // Current restart count in window
  maxRestarts?: number;         // Configured max
  port?: number;                // Port that had conflict (for port_conflict events)
  error?: string;               // Error details if restart failed
}

export interface WatchdogState {
  projectId: string;
  enabled: boolean;
  restartCount: number;         // Restarts in current window
  failedCycles: number;         // Full restart→cooldown cycles with no recovery
  lastRestartAt?: string;       // ISO timestamp
  cooldownUntil?: string;       // ISO timestamp - in cooldown if set and in future
  lastCheckStatus?: 'online' | 'offline';
  circuitBroken?: boolean;      // True = permanently stopped until manual reset or service recovers
}

export interface WatchdogLogData {
  events: WatchdogEvent[];
  lastUpdated: string;
}

export interface WatchdogStatusResponse {
  services: WatchdogState[];
  events: WatchdogEvent[];      // Recent events (last 50)
  timestamp: string;
}

// ============================================================================
// Gateway Services (WebGate)
// ============================================================================

export type SessionDuration = '24h' | '336h' | '720h';

export interface GatewayService {
  name: string;
  port: number;
  subdomain: string;
  url: string;
  locked: boolean;
  accessAppId?: string | null;
  accessPolicyId?: string | null;
  allowedEmails?: string[];
  allowedIps?: string[];           // Trusted IPs/CIDRs — bypass Zero Trust auth
  sessionDuration?: SessionDuration | null; // Cloudflare Access session lifetime
  createdAt: string;
  status: 'active' | 'inactive' | 'error';
}

export interface GatewayServicesData {
  services: GatewayService[];
  lastUpdated: string;
}

export type GatewayAction = 'list' | 'expose' | 'remove' | 'lock' | 'unlock' | 'status' | 'set-emails' | 'set-ips' | 'sync-emails' | 'set-duration';

export interface GatewayActionRequest {
  action: GatewayAction;
  name?: string;
  port?: number;
  locked?: boolean;
  emails?: string[];
  ips?: string[];                  // IP/CIDR list for set-ips action
  sessionDuration?: SessionDuration;
}

export interface GatewayActionResponse {
  success: boolean;
  data?: GatewayServicesData | GatewayService | { output: string };
  error?: string;
}

// ─── Computer Use ─────────────────────────────────────────────────────────────

export type ComputerUseActionType =
  | 'screenshot'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'move'
  | 'drag'
  | 'scroll'
  | 'type'
  | 'key'
  | 'sequence'
  | 'windows.list'
  | 'windows.focus'
  | 'launch'
  | 'scroll.smart'
  | 'dom.snapshot'
  | 'dom.click'
  | 'dom.type'
  | 'dom.select'
  | 'uia.snapshot'
  | 'uia.click'
  | 'uia.type'
  | 'context.detect'
  | 'grounding.snapshot'
  | 'grounding.click'
  | 'grounding.type'
  | 'chat.send';

export interface WindowInfo {
  handle: number;    // Windows HWND
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rect: { left: number; top: number; right: number; bottom: number };
  // Process metadata — null if the bridge cannot resolve it (e.g. elevated
  // processes, or pywin32/psutil lookup failure)
  pid?: number | null;
  process?: string | null;
}

export interface ComputerUseAction {
  id: string;                          // UUID
  type: ComputerUseActionType;
  params: Record<string, unknown>;     // What was requested
  result: {
    success: boolean;
    imageBase64?: string;              // For screenshot actions
    imageFormat?: string;
    imageWidth?: number;
    imageHeight?: number;
    error?: string;
    durationMs: number;
    method?: string;                   // For UIA/DOM click/type — which method was used
    // sequence-specific
    stepsExecuted?: number;
    failedAtStep?: number;
    stepResults?: Array<{ success: boolean; durationMs?: number; error?: string }>;
    // scroll.smart-specific
    reachedEnd?: boolean;
    // launch-specific
    pid?: number | null;
    handle?: number | null;
    // screenshot-specific: id plus the image<->click coordinate mapping
    screenshotId?: string;
    mapping?: Record<string, unknown>;
    // click-type actions given screenshot-space coordinates: what was converted
    resolved?: Record<string, unknown>;
    // chat.send-specific
    sent?: boolean;
    verified?: boolean;
    status?: string;
    observedText?: string | null;
    timings?: Record<string, number>;
  };
  timestamp: string;                   // ISO 8601
}

// Phase A: headless backend — additive, bridge sessions keep 'desktop'/undefined mode.
export type ComputerUseSessionMode = 'desktop' | 'headless';

export interface HeadlessSessionConfig {
  engine: 'chromium';                  // Phase A — chromium only
  viewport: { width: number; height: number };
  userAgent?: string;
  startUrl?: string;
}

export interface ComputerUseSession {
  id: string;                          // "cu-" + 8 random hex chars
  status: 'active' | 'closed' | 'error';
  bridgeUrl: string;                   // e.g., "http://172.28.0.1:2150" — empty for headless
  bridgeReachable: boolean;            // Last health check result — always false for headless
  target: 'desktop' | 'browser';       // widened — bridge sessions still set 'desktop'
  mode?: ComputerUseSessionMode;       // absent ⇒ 'desktop' for back-compat
  headless?: HeadlessSessionConfig;    // present iff mode === 'headless'

  // Audit log
  actions: ComputerUseAction[];

  // Timing
  createdAt: string;                   // ISO 8601
  lastActionAt?: string;
  closedAt?: string;

  // Identity
  createdBy: string;                   // Token name or participant ID
}

export interface MonitorDetail {
  index: number;
  width: number;
  height: number;
  left: number;
  top: number;
  orientation: 'landscape' | 'portrait';
}

export interface ComputerUseBridgeStatus {
  reachable: boolean;
  url: string;
  screen?: { width: number; height: number };
  monitorCount?: number;
  monitors?: MonitorDetail[];
  writablePaths?: Record<string, string>;  // e.g. { Desktop: "C:\\Users\\<windows-user>\\Desktop", Temp: "C:\\..." }
  lastCheckedAt: string;
  startupError?: string;       // Last bridge startup failure message (cleared on success)
}

export interface ComputerUseTask {
  id: string;                          // "cu-task-" + 8 hex chars
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
  prompt: string;
  contextNote?: string;

  // Runtime
  tmuxSession: string;                 // "computer-use-task-{id}" (legacy `api` path)
                                       // empty string for `max` dispatcher path — terminal-tasks owns the session
  sessionId?: string;                  // Linked ComputerUseSession ID
  backend: 'api' | 'max';             // Which execution backend was used
  // Cross-reference to the underlying terminal-tasks record (present on `max` backend only)
  terminalTaskId?: string;
  // Optional caller webhook — POSTed once when the task hits a terminal state
  callbackUrl?: string;

  // Output
  result?: string;                     // Final text from sampling loop
  error?: string;
  actionsCount?: number;

  // Timing
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  timeoutMs: number;

  createdBy: string;
}

// Links a computer-use task to the underlying terminal-tasks record that owns
// its tmux session. Persisted in ComputerUseSessionsData.xrefs so stopTask()
// and taskStatus() can resolve the backing terminal-task without reading it.
export interface CuTerminalXref {
  cuTaskId: string;                    // "cu-task-xxxxxxxx"
  terminalTaskId: string;              // terminal-tasks record id
  sessionId?: string;                  // owning ComputerUseSession id (if any)
  callbackUrl?: string;                // from the original task.run call
  createdAt: string;                   // ISO 8601
}

export interface ComputerUseSessionsData {
  sessions: ComputerUseSession[];
  tasks: ComputerUseTask[];
  bridgeStatus: ComputerUseBridgeStatus | null;
  // Added with the Phase 2 AI Task Runner rewire. Optional for back-compat.
  xrefs?: CuTerminalXref[];
}

export interface DevFlowSettings {
  computerUse: {
    enabled: boolean;
    enabledAt: string | null;
    enabledBy: string | null;
    backend?: 'api' | 'max';          // 'api' = Anthropic API key, 'max' = Claude CLI MAX subscription
    apiKeyConfigured?: boolean;       // Cached hint: was API key verified by wizard?
    wizardPassedAt?: string | null;   // ISO timestamp when setup wizard last passed all checks
  };
}

// WhatsApp Bridge (Baileys linked-device approach)
export interface WhatsAppBridgeConfig {
  type: 'baileys';
  enabled: boolean;
  port: number;
  allowedNumbers: string[];   // E.164 format, e.g. "+447700900000"
  commanderName: string;      // Agent name in collab channel
  channelName: string;        // DevFlow collab channel name
  updatedAt: string;
}

export interface WhatsAppBridgeHealth {
  status: 'connected' | 'connecting' | 'pairing' | 'disconnected';
  phone?: string;
  phoneName?: string;
  channelId?: string;
  commanderAlive?: boolean;
  dedupCacheSize?: number;
  reconnectAttempt?: number;
  sessionExists?: boolean;
}

export interface WhatsAppBridgeStatus {
  config: WhatsAppBridgeConfig;
  pm2Status: string;          // 'online' | 'stopped' | 'errored' | 'not found'
  bridge: WhatsAppBridgeHealth | null;
  reachable: boolean;
}

// ─── Connections Panel Types ─────────────────────────────────────────────────

export type ConnectionStatus = 'active' | 'configured' | 'configured_not_active' | 'pending';

export type ConnectionCategory =
  | 'ai' | 'infrastructure' | 'database' | 'google' | 'seo'
  | 'media' | 'payments' | 'ecommerce' | 'automation' | 'design'
  | 'creative' | 'email' | 'security' | 'productivity' | 'backup';

export type ConnectionType =
  | 'api_key' | 'api_token' | 'oauth' | 'oauth_service_account'
  | 'service_account' | 'pat_and_ssh' | 'url_and_keys' | 'local_http'
  | 'credentials' | 'api_key_local' | 'personal_access_token'
  | 'access_token' | 'api_key_and_webhook' | 'local_credentials'
  | 'encryption_key' | 'stdio' | 'websocket' | 'local';

export interface Connection {
  id: string;
  name: string;
  category: ConnectionCategory;
  connection_type: ConnectionType;
  env_vars?: string[];
  endpoint?: string;
  purpose: string;
  status: ConnectionStatus;
  docs?: string;
  used_in?: string[];
  notes?: string;
  mcp_server?: boolean;
  service_account?: string;
  project_id?: string;
}

export interface McpServerEntry {
  id: string;
  name: string;
  connection_type: string;
  env_vars?: string[];
  endpoint?: string;
  purpose: string;
  status: ConnectionStatus;
  pm2_process?: string;
}

export interface ConnectionsData {
  connections: Connection[];
  mcp_servers: McpServerEntry[];
  meta: { generated: string; description: string };
}

export interface ConnectionHealthResult {
  id: string;
  status: 'ok' | 'error' | 'unknown';
  latencyMs?: number;
  message?: string;
}

export interface ConnectionEnvCheckResult {
  id: string;
  envVars: Record<string, boolean>;
}

// ============================================================================
// Directory Sync Types
// ============================================================================

export type SyncMode = 'watch' | 'periodic';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'dry-run';

export interface DirectorySyncStats {
  filesCopied: number;
  filesDeleted: number;
  bytesTransferred: number;
  durationMs: number;
}

export interface DirectorySyncPair {
  id: string;
  name: string;
  sourcePath: string;
  destPath: string;
  mode: SyncMode;
  intervalMinutes: number;
  enabled: boolean;
  exclusions: string[];
  status: SyncStatus;
  lastSync: string | null;
  lastError: string | null;
  stats: DirectorySyncStats;
  createdAt: string;
  updatedAt: string;
}

export interface DirectorySyncData {
  pairs: DirectorySyncPair[];
  lastUpdated: string;
}

/** Structured event emitted by the watcher, polled by the UI */
export interface DirectorySyncEvent {
  type: 'sync-start' | 'sync-complete' | 'sync-error' | 'sync-progress' | 'dry-run-complete' | 'watcher-error';
  syncId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

/** In-memory event log entry (ring buffer in the watcher process) */
export interface DirectorySyncEventEntry extends DirectorySyncEvent {
  sequence: number;
}

export type DirectorySyncAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'toggle'
  | 'run-now'
  | 'dry-run'
  | 'events';

export interface DirectorySyncActionRequest {
  action: DirectorySyncAction;
  // For create/update
  id?: string;
  name?: string;
  sourcePath?: string;
  destPath?: string;
  mode?: SyncMode;
  intervalMinutes?: number;
  enabled?: boolean;
  exclusions?: string[];
  // For events polling
  since?: string;
}

export interface DirectorySyncActionResponse {
  success: boolean;
  pair?: DirectorySyncPair;
  pairs?: DirectorySyncPair[];
  events?: DirectorySyncEventEntry[];
  dryRunResult?: DirectorySyncStats & { files: string[] };
  error?: string;
}

// ─── Android Studio ───────────────────────────────────────────────

export type AndroidCommand =
  | 'build-web'
  | 'cap-sync'
  | 'build-apk'
  | 'start-emulator'
  | 'start-live-reload'
  | 'stop-live-reload';

export interface AndroidProject {
  id: string;
  name: string;
  projectPath: string;           // WSL path to web project root
  androidProjectPath: string;    // WSL path to android/ directory
  emulatorName: string;
  enabled: boolean;
  liveReloadActive: boolean;
  liveReloadPid: number | null;
  devServerPid: number | null;
  lastBuild: string | null;
  lastSync: string | null;
  lastOutput: string | null;
  lastCommand: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AndroidStudioData {
  projects: AndroidProject[];
  lastUpdated: string;
}

export interface AndroidStudioActionRequest {
  action: 'create' | 'update' | 'delete' | 'execute' | 'stop-live-reload';
  id?: string;
  name?: string;
  projectPath?: string;
  androidProjectPath?: string;
  emulatorName?: string;
  enabled?: boolean;
  command?: AndroidCommand;
}

export interface AndroidStudioActionResponse {
  success: boolean;
  project?: AndroidProject;
  projects?: AndroidProject[];
  output?: string;
  error?: string;
}
