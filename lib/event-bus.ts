/**
 * SSE Event Bus - Singleton EventEmitter for push-based events
 *
 * Central event bus that backend code emits events to, and SSE clients
 * subscribe to via /api/events. Replaces frontend polling with server push.
 *
 * Usage (emitting from API routes or backend code):
 *   import { eventBus } from '@/lib/event-bus';
 *   eventBus.emit('pm2:status', { processes: [...] });
 *   eventBus.emit('collab:message', { channelId, message });
 *
 * The SSE endpoint (/api/events) subscribes to these events and pushes
 * them to connected clients in real-time.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { appRoot } from '@/lib/app-paths';

// ============================================
// Event Type Definitions
// ============================================

/**
 * All supported SSE event types.
 * Format: "domain:verb" for clear categorization.
 */
export type SSEEventType =
  // PM2 process management
  | 'pm2:status'           // Full PM2 process list update
  // Health checks
  | 'health:status'        // Health check results changed
  // Collaboration
  | 'collab:message'       // New message in a channel
  | 'collab:participant'   // Participant joined/left/status changed
  | 'collab:typing'        // Typing/working indicator update
  | 'collab:task'          // Task board change (created/claimed/completed)
  | 'collab:delivery_failure' // Message delivery failure event
  // Ralph loops
  | 'loops:status'         // Loop status change
  // Port monitoring
  | 'ports:change'         // Listening ports changed
  // Claude sessions
  | 'sessions:change'      // Session connect/disconnect/heartbeat
  // Terminal tasks
  | 'terminal:status'      // Terminal task status change
  | 'terminal:done'        // Terminal task reached a terminal state (completed/failed/timeout/cancelled) — subscribers fire callbacks
  // Cron jobs
  | 'cron:status'          // Cron job list/status change
  // Service watchdog
  | 'watchdog:event'       // Watchdog action (restart, cooldown, etc.)
  // Network
  | 'network:wsl-status'  // WSL2 localhost bridge health change
  // Computer Use
  | 'computer-use:bridge-recovery' // Bridge auto-recovery state transition (HEALTHY/DEGRADED/DOWN)
  // Error monitoring
  | 'error:api'            // API route error (catch block, 5xx)
  | 'error:collab'         // Collab system error (message post, inbox write, PTY)
  | 'error:agent'          // Agent process / session error
  // Logs dashboard (live tail)
  | 'logs:entry'           // New unified log entry written (any source)
  // System
  | 'system:restarting'    // Server about to restart (graceful SSE shutdown)
  | 'heartbeat';           // Keepalive ping (sent by SSE endpoint)

// ============================================
// Error Event Payload
// ============================================

export type ErrorSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ErrorEventPayload {
  severity: ErrorSeverity;
  source: string;          // File/module path (e.g. 'api/agent', 'lib/collab-pty')
  message: string;         // Error message
  stack?: string;          // First 3 lines of stack trace
  requestId?: string;      // Trace ID from API request (if available)
  context?: Record<string, unknown>; // Additional context (action, channelId, etc.)
  timestamp: string;       // ISO timestamp
}

/**
 * Emit an error:api event. Call from API route catch blocks.
 */
export function emitApiError(
  error: unknown,
  source: string,
  opts: { severity?: ErrorSeverity; requestId?: string; context?: Record<string, unknown> } = {}
): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error
    ? error.stack?.split('\n').slice(0, 3).join(' ')
    : undefined;
  // Log stack server-side but don't broadcast to SSE subscribers (internal detail)
  if (stack) {
    console.error(`[event-bus] ${source}: ${message}\n${stack}`);
  }
  const payload: ErrorEventPayload = {
    severity: opts.severity ?? 'high',
    source,
    message,
    // stack intentionally omitted — internal paths shouldn't go to SSE clients
    requestId: opts.requestId,
    context: opts.context,
    timestamp: new Date().toISOString(),
  };
  eventBus.emitEvent('error:api', payload);
}

/**
 * Emit an error:collab event. Call from collab route / collab lib catch blocks.
 */
export function emitCollabError(
  error: unknown,
  source: string,
  opts: { severity?: ErrorSeverity; context?: Record<string, unknown> } = {}
): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error
    ? error.stack?.split('\n').slice(0, 3).join(' ')
    : undefined;
  const payload: ErrorEventPayload = {
    severity: opts.severity ?? 'high',
    source,
    message,
    stack,
    context: opts.context,
    timestamp: new Date().toISOString(),
  };
  eventBus.emitEvent('error:collab', payload);
}

/**
 * Emit an error:agent event. Call from agent session / PTY error paths.
 */
export function emitAgentError(
  error: unknown,
  source: string,
  opts: { severity?: ErrorSeverity; context?: Record<string, unknown> } = {}
): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error
    ? error.stack?.split('\n').slice(0, 3).join(' ')
    : undefined;
  const payload: ErrorEventPayload = {
    severity: opts.severity ?? 'high',
    source,
    message,
    stack,
    context: opts.context,
    timestamp: new Date().toISOString(),
  };
  eventBus.emitEvent('error:agent', payload);
}

/**
 * Base SSE event payload wrapper.
 * Every event pushed to clients has this shape.
 */
export interface SSEEvent {
  id: string;              // Auto-incrementing event ID (for Last-Event-ID reconnection)
  type: SSEEventType;      // Event type
  data: unknown;           // Domain-specific payload
  timestamp: string;       // ISO timestamp
}

/**
 * Domain groupings for event type filtering.
 * Clients can subscribe to one or more domains.
 */
export const EVENT_DOMAINS: Record<string, SSEEventType[]> = {
  pm2: ['pm2:status'],
  health: ['health:status'],
  collab: ['collab:message', 'collab:participant', 'collab:typing', 'collab:task', 'collab:delivery_failure'],
  loops: ['loops:status'],
  ports: ['ports:change'],
  sessions: ['sessions:change'],
  terminal: ['terminal:status'],
  cron: ['cron:status'],
  watchdog: ['watchdog:event'],
  network: ['network:wsl-status'],
  errors: ['error:api', 'error:collab', 'error:agent'],
  logs: ['logs:entry'],
  system: ['system:restarting'],
};

// ============================================
// Event Bus Singleton
// ============================================

// Path for persisting the event buffer across restarts
const EVENT_BUFFER_PATH = path.join(
  appRoot(),
  process.env.DEVFLOW_APP_DATA_DIR || process.env.DEVFLOW_DATA_DIR || '.AppData',
  'event-buffer.json'
);

class SSEEventBus extends EventEmitter {
  private lastEventId = 0; // Timestamp-based: survives restarts (new IDs always > old)
  private clientCount = 0;
  private recentEvents: SSEEvent[] = [];
  private readonly maxRecentEvents = 100; // Buffer for reconnection replay

  constructor() {
    super();
    // Allow many listeners (one per SSE client)
    this.setMaxListeners(200);
    // Reload buffered events from last run so reconnecting clients don't miss events
    this.loadFromDisk();
    // Flush buffer on graceful shutdown signals
    process.on('SIGTERM', () => this.flushToDisk());
    process.on('SIGINT', () => this.flushToDisk());
  }

  /** Write event buffer to disk (synchronous — safe at shutdown / pre-restart). */
  flushToDisk(): void {
    try {
      const dir = path.dirname(EVENT_BUFFER_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${EVENT_BUFFER_PATH}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.recentEvents), 'utf8');
      fs.renameSync(tmp, EVENT_BUFFER_PATH);
    } catch {
      // Non-fatal — buffer persistence is best-effort
    }
  }

  /** Load event buffer from disk on startup (synchronous — constructor only). */
  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(EVENT_BUFFER_PATH)) return;
      const raw = fs.readFileSync(EVENT_BUFFER_PATH, 'utf8');
      const events: SSEEvent[] = JSON.parse(raw);
      if (!Array.isArray(events)) return;
      // Restore buffer — cap to maxRecentEvents
      this.recentEvents = events.slice(-this.maxRecentEvents);
      // Restore lastEventId so new IDs don't collide with restored ones
      if (this.recentEvents.length > 0) {
        const lastId = parseInt(this.recentEvents[this.recentEvents.length - 1].id, 10);
        if (!isNaN(lastId)) this.lastEventId = lastId;
      }
    } catch {
      // Non-fatal — bad/missing buffer file, start fresh
    }
  }

  /**
   * Emit a typed event to all connected SSE clients.
   * This is the primary method backend code should call.
   */
  emitEvent(type: SSEEventType, data: unknown): SSEEvent {
    // Use epoch ms as ID base — guarantees IDs always increase across restarts.
    // If multiple events fire in the same ms, increment by 1 for strict ordering.
    const now = Date.now();
    this.lastEventId = now > this.lastEventId ? now : this.lastEventId + 1;

    const event: SSEEvent = {
      id: String(this.lastEventId),
      type,
      data,
      timestamp: new Date().toISOString(),
    };

    // Buffer for reconnection replay
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents = this.recentEvents.slice(-this.maxRecentEvents);
    }

    // Persist buffer before graceful restart so reconnecting clients get replay
    if (type === 'system:restarting') {
      this.flushToDisk();
    }

    // Emit to all SSE client listeners
    this.emit('sse-event', event);

    return event;
  }

  /**
   * Get events after a given event ID (for Last-Event-ID reconnection).
   * Returns buffered events that the client missed during disconnection.
   */
  getEventsSince(lastEventId: string): SSEEvent[] {
    const id = parseInt(lastEventId, 10);
    if (isNaN(id)) return [];
    return this.recentEvents.filter(e => parseInt(e.id, 10) > id);
  }

  /**
   * Track connected client count for monitoring.
   */
  addClient(): void {
    this.clientCount++;
  }

  removeClient(): void {
    this.clientCount = Math.max(0, this.clientCount - 1);
  }

  getClientCount(): number {
    return this.clientCount;
  }

  getEventCounter(): number {
    return this.lastEventId;
  }

  getBufferSize(): number {
    return this.recentEvents.length;
  }

  getMaxBufferSize(): number {
    return this.maxRecentEvents;
  }
}

// Singleton instance - survives hot reloads AND ensures the same instance
// is shared across all module contexts (instrumentation.ts, API routes, etc.)
// MUST always assign to globalThis — in production, Next.js webpack can create
// separate module instances for instrumentation vs route handlers.
const globalForEventBus = globalThis as typeof globalThis & {
  __sseEventBus?: SSEEventBus;
};

export const eventBus: SSEEventBus =
  globalForEventBus.__sseEventBus ?? new SSEEventBus();

globalForEventBus.__sseEventBus = eventBus;
