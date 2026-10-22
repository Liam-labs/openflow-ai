/**
 * Computer Use Shared Utilities
 *
 * Provides proxyAction() — the core bridge proxy used by both the API routes
 * and the Agent API action handlers. Translates ComputerUseActionType calls
 * into HTTP requests to the Windows bridge, records them on the session, and
 * returns a ComputerUseAction audit record.
 */

import { randomUUID } from 'crypto';
import { DataPaths } from './data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from './data-io';
import { checkBridgeHealth, bridgeFetch } from './computer-use-bridge';
import {
  CoordinateError,
  findScreenshotInActions,
  hasCoordinateFields,
  lookupScreenshot,
  newScreenshotId,
  parseMapping,
  rememberScreenshot,
  resolveCoordinateParams,
  wantsScreenshotSpace,
} from './computer-use-coords';
import type {
  ComputerUseAction,
  ComputerUseActionType,
  ComputerUseSession,
  ComputerUseSessionsData,
} from './types';

const DEFAULT_DATA: ComputerUseSessionsData = {
  sessions: [],
  tasks: [],
  bridgeStatus: null,
};

const MAX_ACTIONS_PER_SESSION = 500;
const BRIDGE_ACTION_TIMEOUT_MS = 15000;

// ─── Write batching ───────────────────────────────────────────────────────────
// Coalesces rapid appendAction calls into a single file write (50ms window).
// Reduces O(N-sessions) I/O during high-frequency task.run loops.

/**
 * T4 event-loop fix: strip base64 image payloads from closed-session actions.
 * Returns the number of images stripped. Call on every write path — flush
 * batching, session.close, and scheduled compaction — to keep the primary
 * sessions file under ~10 MB instead of >100 MB.
 */
export function stripClosedSessionImages(data: ComputerUseSessionsData): number {
  let stripped = 0;
  for (const session of data.sessions) {
    if (session.status === 'active') continue;
    for (const action of session.actions) {
      if (action.result?.imageBase64) {
        delete action.result.imageBase64;
        stripped++;
      }
    }
  }
  return stripped;
}
const _pendingActions: Map<string, ComputerUseAction[]> = new Map();
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
const WRITE_BATCH_DELAY_MS = 50;

async function _flushPendingActions(): Promise<void> {
  _flushTimer = null;
  if (_pendingActions.size === 0) return;
  const batch = new Map(_pendingActions);
  _pendingActions.clear();

  await withFileLock(DataPaths.computerUseSessions, async () => {
    const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, DEFAULT_DATA);
    for (const [sessionId, actions] of batch) {
      const session = data.sessions.find((s) => s.id === sessionId);
      if (!session) continue;
      for (const action of actions) {
        session.actions.push(action);
        session.lastActionAt = action.timestamp;
      }
      if (session.actions.length > MAX_ACTIONS_PER_SESSION) {
        session.actions = session.actions.slice(-MAX_ACTIONS_PER_SESSION);
      }
    }
    stripClosedSessionImages(data);
    await writeJsonFile(DataPaths.computerUseSessions, data);
  });
}

// ─── Compaction ───────────────────────────────────────────────────────────────

/**
 * T4 daily compaction: archive sessions older than `maxAgeDays` into
 * computer-use-sessions-archive-YYYY-MM-DD.json and remove from primary store.
 * Returns { archived, remaining } counts. Called by the 4am cron.
 */
export async function compactArchiveSessions(maxAgeDays: number = 7): Promise<{ archived: number; remaining: number }> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return withFileLock(DataPaths.computerUseSessions, async () => {
    const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, DEFAULT_DATA);
    const remaining: ComputerUseSession[] = [];
    const archive: ComputerUseSession[] = [];

    for (const session of data.sessions) {
      const created = new Date(session.createdAt).getTime();
      if (created < cutoff && session.status !== 'active') {
        archive.push(session);
      } else {
        remaining.push(session);
      }
    }

    if (archive.length > 0) {
      const dateTag = new Date().toISOString().slice(0, 10);
      const archivePath = DataPaths.computerUseSessions.replace(
        '.json',
        `-archive-${dateTag}.json`
      );
      await writeJsonFile(archivePath, { sessions: archive, archivedAt: new Date().toISOString() });
    }

    data.sessions = remaining;
    await writeJsonFile(DataPaths.computerUseSessions, data);
    return { archived: archive.length, remaining: remaining.length };
  });
}

// ─── Bridge Endpoint Translation ─────────────────────────────────────────────

interface BridgeRequest {
  endpoint: string;
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
}

function buildBridgeRequest(
  actionType: ComputerUseActionType,
  params: Record<string, unknown>
): BridgeRequest {
  switch (actionType) {
    case 'screenshot':
      // Default monitor=0 (all screens) when caller omits it. the owner's setup is
      // dual-monitor; the bridge's prior default (1 = primary only) silently
      // hid windows on the secondary display. Geordi covered the agent-API
      // layer; this catches direct `proxyAction(_, 'screenshot', {})` calls.
      return {
        endpoint: `/screenshot${buildQuery({
          monitor: params.monitor ?? 0,
          format: params.format,
          quality: params.quality,
          scale: params.scale,
          preset: params.preset,
          // `region` is already "x,y,w,h" in physical pixels (resolveCoordinateParams).
          region: params.region,
          max_edge: params.max_edge ?? params.maxEdge,
        })}`,
        method: 'GET',
      };
    case 'chat.send':
      // The handler builds the snake_case body; coordinates are already physical.
      return { endpoint: '/chat/send', method: 'POST', body: params };
    case 'click':
      return {
        endpoint: '/mouse/click',
        method: 'POST',
        body: { x: params.x, y: params.y, button: params.button ?? 'left' },
      };
    case 'double_click':
      return {
        endpoint: '/mouse/double_click',
        method: 'POST',
        body: { x: params.x, y: params.y },
      };
    case 'right_click':
      return {
        endpoint: '/mouse/right_click',
        method: 'POST',
        body: { x: params.x, y: params.y },
      };
    case 'move':
      return {
        endpoint: '/mouse/move',
        method: 'POST',
        body: { x: params.x, y: params.y, duration: params.duration ?? 0.1 },
      };
    case 'drag':
      return {
        endpoint: '/mouse/drag',
        method: 'POST',
        body: {
          x1: params.x1, y1: params.y1,
          x2: params.x2, y2: params.y2,
          duration: params.duration ?? 0.5,
          button: params.button ?? 'left',
        },
      };
    case 'scroll':
      return {
        endpoint: '/mouse/scroll',
        method: 'POST',
        body: {
          x: params.x, y: params.y,
          direction: params.direction,
          amount: params.amount ?? 3,
        },
      };
    case 'type':
      return {
        endpoint: '/keyboard/type',
        method: 'POST',
        body: { text: params.text, interval: params.interval ?? 0.01, ...(params.window_title ? { window_title: params.window_title } : {}) },
      };
    case 'key':
      return {
        endpoint: '/keyboard/key',
        method: 'POST',
        body: { keys: params.keys, ...(params.window_title ? { window_title: params.window_title } : {}) },
      };
    default:
      throw new ComputerUseError(
        `Unknown action type: ${actionType}`,
        'COMPUTER_USE_UNKNOWN_ACTION',
        400,
        { action: String(actionType) },
      );
  }
}

function buildQuery(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

// ─── Session Helpers ──────────────────────────────────────────────────────────

/**
 * Read the last N sessions (sorted newest-first by createdAt).
 * Bounded-read guard for dashboard poll hot paths — prevents in-memory
 * inflation as the session count grows over time.  T4 event-loop fix.
 */
export async function getRecentSessions(n: number = 50): Promise<ComputerUseSession[]> {
  const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, DEFAULT_DATA);
  const sorted = [...data.sessions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return sorted.slice(0, n);
}

export async function getSession(sessionId: string): Promise<ComputerUseSession | null> {
  const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, DEFAULT_DATA);
  return data.sessions.find((s) => s.id === sessionId) ?? null;
}

export async function appendAction(sessionId: string, action: ComputerUseAction): Promise<void> {
  // Queue action into batch buffer
  const pending = _pendingActions.get(sessionId) ?? [];
  pending.push(action);
  _pendingActions.set(sessionId, pending);

  // Schedule a flush if not already pending
  if (_flushTimer === null) {
    _flushTimer = setTimeout(() => { _flushPendingActions().catch(console.error); }, WRITE_BATCH_DELAY_MS);
  }
}

// ─── proxyAction ─────────────────────────────────────────────────────────────

/**
 * Structured error context — taxonomy §4.1. Optional fields are populated by
 * throwers whenever the relevant data is knowable. Mandatory-context rules
 * (e.g. SESSION_* codes must set sessionId, VALIDATION_* must set field) are
 * enforced by the contract test in `app/api/computer-use/error-codes.ts`
 * (`missingRequiredContext`).
 */
export interface ComputerUseErrorContext {
  sessionId?: string;
  /** Headless session id when the failure originates inside the headless
   *  Playwright path. Folded in from the deleted `HeadlessRuntimeError` class
   *  so callers can still distinguish headless vs bridge sessions. */
  headlessSessionId?: string;
  action?: string;
  bridgeUrl?: string;
  taskId?: string;
  terminalTaskId?: string;
  ref?: string;
  elementId?: string;
  field?: string;
  durationMs?: number;
  bridgeDetail?: string;
  logId?: string;
  /** Free-form hint surfaced to operators (e.g. netstat command for port
   *  collision). Always operator-safe — never includes user PII. */
  hint?: string;
  /** Specific port number when the failure is port-binding related. */
  port?: number;
  /** ISO timestamp surfaced for time-bounded errors (cooldown expiry). */
  cooldownExpiresAt?: string;
}

/**
 * The error response shape every Computer Use surface returns. Mirrors the
 * type in `app/api/computer-use/error-codes.ts`; that file will re-export
 * from here once the lib portion of the sweep lands (taxonomy §4).
 */
export interface ComputerUseErrorResponse {
  success: false;
  code: string;
  error: string;
  context?: ComputerUseErrorContext;
}

export class ComputerUseError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly context?: ComputerUseErrorContext,
  ) {
    super(message);
    this.name = 'ComputerUseError';
  }

  /**
   * Serialise this error as the canonical `{ success: false, code, error, context }`
   * shape that every Computer Use API surface returns. Handlers that catch a
   * `ComputerUseError` should call `toResponse()` rather than constructing the
   * shape inline — keeps the contract uniform and lets the test guards verify it.
   */
  toResponse(): ComputerUseErrorResponse {
    if (this.context && Object.keys(this.context).length > 0) {
      return { success: false, code: this.code, error: this.message, context: this.context };
    }
    return { success: false, code: this.code, error: this.message };
  }
}

/**
 * Execute a computer use action by proxying it to the Windows bridge.
 * Records the action on the session audit log.
 *
 * @throws ComputerUseError on session/bridge errors
 */
export interface ProxyActionOptions {
  /** Override the 15s bridge timeout (chat.send does several steps). */
  timeoutMs?: number;
  /** Return the action instead of throwing when the bridge reports success:false
   *  (chat.send uses this so a verification mismatch still returns what was seen). */
  tolerateFailure?: boolean;
}

export async function proxyAction(
  sessionId: string,
  actionType: ComputerUseActionType,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  return (await proxyActionRaw(sessionId, actionType, params)).action;
}

/** Like proxyAction, but also returns the full bridge payload (not persisted). */
export async function proxyActionRaw(
  sessionId: string,
  actionType: ComputerUseActionType,
  params: Record<string, unknown>,
  opts: ProxyActionOptions = {},
): Promise<{ action: ComputerUseAction; bridgeData: Record<string, unknown> }> {
  // 1. Load and validate session
  const session = await getSession(sessionId);
  if (!session) {
    throw new ComputerUseError('Session not found', 'COMPUTER_USE_SESSION_NOT_FOUND', 404);
  }
  if (session.status !== 'active') {
    throw new ComputerUseError(
      'Session is not active',
      'COMPUTER_USE_SESSION_CLOSED',
      400
    );
  }

  // 2. Health check bridge
  const health = await checkBridgeHealth();
  if (!health.ok) {
    throw new ComputerUseError(
      'computer-use bridge not reachable. Is the bridge running on Windows?',
      'COMPUTER_USE_BRIDGE_UNAVAILABLE',
      503
    );
  }

  // 2b. Screenshot-space coordinates -> physical pixels (the bridge only knows physical).
  let resolvedCoords: Record<string, unknown> | undefined;
  const originalParams = params;
  if (hasCoordinateFields(actionType)) {
    try {
      const shot = wantsScreenshotSpace(params)
        ? (lookupScreenshot(sessionId, typeof params.screenshotId === 'string' ? params.screenshotId : undefined)
            ?? findScreenshotInActions(session.actions, typeof params.screenshotId === 'string' ? params.screenshotId : undefined))
        : null;
      const r = resolveCoordinateParams(actionType, params, shot);
      params = r.params;
      resolvedCoords = r.resolved ? { ...r.resolved } : undefined;
    } catch (err) {
      if (err instanceof CoordinateError) {
        throw new ComputerUseError(err.message, 'COMPUTER_USE_INVALID_PARAMS', 400, { sessionId, action: `computer-use.${actionType}` });
      }
      throw err;
    }
  }

  // 3. Build bridge request
  const { endpoint, method, body } = buildBridgeRequest(actionType, params);

  // 4. Call bridge
  const start = Date.now();
  let bridgeData: Record<string, unknown>;

  try {
    const res = await bridgeFetch(`${session.bridgeUrl}${endpoint}`, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' && body ? JSON.stringify(body) : undefined,
      timeoutMs: opts.timeoutMs ?? BRIDGE_ACTION_TIMEOUT_MS,
    });

    bridgeData = await res.json() as Record<string, unknown>;

    if (!res.ok || (!bridgeData.success && !opts.tolerateFailure)) {
      throw new ComputerUseError(
        `Bridge error: ${typeof bridgeData.detail === 'string' ? bridgeData.detail : JSON.stringify(bridgeData.detail) ?? res.statusText}`,
        'COMPUTER_USE_BRIDGE_ERROR',
        500
      );
    }
  } catch (err) {
    if (err instanceof ComputerUseError) throw err;

    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('TimeoutError') || msg.includes('timeout')) {
      throw new ComputerUseError(
        `Bridge request timed out (${Math.round((opts.timeoutMs ?? BRIDGE_ACTION_TIMEOUT_MS) / 1000)}s)`,
        'COMPUTER_USE_TIMEOUT',
        504
      );
    }
    throw new ComputerUseError(
      `Bridge unreachable: ${msg}`,
      'COMPUTER_USE_BRIDGE_UNAVAILABLE',
      503
    );
  }

  const durationMs = Date.now() - start;

  // 5. Build action record
  const { action: _action, sessionId: _sessionId, ...auditParams } = originalParams as Record<string, unknown> & { action?: unknown; sessionId?: unknown };
  const mapping = actionType === 'screenshot' ? parseMapping(bridgeData.mapping) : null;
  const screenshotId = mapping ? newScreenshotId() : undefined;
  if (mapping && screenshotId) rememberScreenshot(sessionId, mapping, screenshotId);

  // chat.send: persist the confirmation image (dashboard live view) and the outcome,
  // not the bulky crops; the caller gets the full payload from `bridgeData`.
  const confirmation = actionType === 'chat.send'
    ? (bridgeData.confirmation as { image?: string; format?: string; width?: number; height?: number } | undefined)
    : undefined;
  const action: ComputerUseAction = {
    id: randomUUID(),
    type: actionType,
    // chat.send text is the user's message: keep length, not content, in the audit log.
    params: actionType === 'chat.send' && typeof auditParams.text === 'string'
      ? { ...auditParams, text: `[${(auditParams.text as string).length} chars]` }
      : auditParams,
    result: {
      success: (bridgeData.success as boolean) ?? false,
      imageBase64: (bridgeData.image as string | undefined) ?? confirmation?.image,
      imageFormat: (bridgeData.format as string | undefined) ?? confirmation?.format,
      imageWidth: (bridgeData.width as number | undefined) ?? confirmation?.width,
      imageHeight: (bridgeData.height as number | undefined) ?? confirmation?.height,
      error: bridgeData.success ? undefined : ((bridgeData.error as string) ?? (bridgeData.detail as string) ?? 'Unknown error'),
      durationMs,
      ...(screenshotId ? { screenshotId, mapping: mapping as unknown as Record<string, unknown> } : {}),
      ...(resolvedCoords ? { resolved: resolvedCoords } : {}),
      ...(actionType === 'chat.send' ? {
        sent: bridgeData.sent as boolean | undefined,
        verified: bridgeData.verified as boolean | undefined,
        status: bridgeData.status as string | undefined,
        timings: bridgeData.timings as Record<string, number> | undefined,
      } : {}),
    },
    timestamp: new Date().toISOString(),
  };

  // 6. Persist to session audit log
  await appendAction(sessionId, action);

  return { action, bridgeData };
}
