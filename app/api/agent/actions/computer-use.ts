/**
 * Computer Use — Agent API Actions
 *
 * Exposes all computer-use capabilities through the unified Agent API.
 * Every action checks the safety gate (isComputerUseEnabled) before executing.
 *
 * Approach B (task execution): computer-use.task.* — handled by Ferretti's task runner
 * Approach A (raw primitives): computer-use.session.* and computer-use.screenshot/click/etc.
 */

import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import type { AgentApiRequest, AgentAuthContext, ComputerUseActionType, ComputerUseSession, ComputerUseSessionsData, ComputerUseBridgeStatus, ComputerUseTask, ComputerUseSessionMode, HeadlessSessionConfig } from '@/lib/types';
import { isComputerUseEnabled, readSettings } from '@/lib/computer-use-settings';
import { proxyAction, proxyActionRaw, getSession, ComputerUseError, stripClosedSessionImages } from '@/lib/computer-use';
import { checkBridgeHealth, startBridge, scheduleBridgeShutdown, getBridgeUrl, bridgeFetch, getBridgeRecoveryStats } from '@/lib/computer-use-bridge';
import * as headless from '@/lib/computer-use-headless';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { logEvent, trackToolFailure } from '@/lib/log-writer';
import { fail, type ComputerUseErrorCode, type ComputerUseErrorContext } from '@/app/api/computer-use/error-codes';
import { getDevflowHome } from '@/lib/home-dir';
import { PRODUCT_NAME } from '@/lib/brand';
import { selfOrigin } from '@/lib/self-origin';

const execFileAsync = promisify(execFile);

const DEFAULT_DATA: ComputerUseSessionsData = {
  sessions: [],
  tasks: [],
  bridgeStatus: null,
};

const MAX_SESSIONS = 50;
// Sessions active longer than this with no actions are closed automatically (zombie cleanup)
const SESSION_ZOMBIE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// ─── Bridge shutdown criterion ────────────────────────────────────────────────
//
// The Windows bridge is a desktop-only resource (screenshots, mouse, keyboard).
// Headless (Playwright) sessions never use the bridge and must NOT block its
// idle shutdown. When the last active *desktop* session closes, the bridge is
// scheduled for shutdown — even if headless sessions remain.
//
// Both API routes that close sessions (this file + app/api/computer-use/route.ts)
// share this counter to prevent the race documented in audit task 80f61091.
export function countActiveDesktopSessions(sessions: ComputerUseSession[]): number {
  return sessions.filter((s) => s.status === 'active' && s.mode !== 'headless').length;
}

// ─── Safety gate ─────────────────────────────────────────────────────────────

async function assertEnabled(): Promise<void> {
  if (!await isComputerUseEnabled()) {
    throw Object.assign(
      new Error(`Computer Use is disabled. Enable it in ${PRODUCT_NAME} Settings > Security.`),
      { statusCode: 403, code: 'COMPUTER_USE_DISABLED' }
    );
  }
}

// ─── Session helpers ──────────────────────────────────────────────────────────

async function loadData(): Promise<ComputerUseSessionsData> {
  const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, DEFAULT_DATA);
  // Expire zombie sessions: active sessions with no actions older than SESSION_ZOMBIE_TTL_MS
  const now = Date.now();
  let cleaned = false;
  const expiredHeadless: string[] = [];
  for (const s of data.sessions) {
    if (s.status === 'active' && s.actions.length === 0) {
      const age = now - new Date(s.createdAt).getTime();
      if (age > SESSION_ZOMBIE_TTL_MS) {
        s.status = 'closed';
        s.closedAt = new Date().toISOString();
        cleaned = true;
        if (s.mode === 'headless') expiredHeadless.push(s.id);
      }
    }
  }
  if (cleaned) {
    stripClosedSessionImages(data);
    await writeJsonFile(DataPaths.computerUseSessions, data).catch(() => {/* non-fatal */});
    // Best-effort: dispose headless browser contexts for expired sessions.
    for (const id of expiredHeadless) {
      headless.disposeHeadlessRegistryEntry(id).catch(() => {/* swallow */});
    }
  }
  return data;
}

// ─── Scheduled zombie cleanup ─────────────────────────────────────────────────
// Runs every 30 minutes independently of API calls, closing stale active sessions
// with 0 actions that are older than SESSION_ZOMBIE_TTL_MS.
if (typeof globalThis !== 'undefined' && !(globalThis as Record<string, unknown>).__cuZombieCleanupStarted) {
  (globalThis as Record<string, unknown>).__cuZombieCleanupStarted = true;
  setInterval(async () => {
    try {
      await loadData(); // loadData() already applies and writes the TTL cleanup
    } catch {/* non-fatal */}
  }, 30 * 60 * 1000); // every 30 minutes
}

// ─── Session actions ──────────────────────────────────────────────────────────

export async function startSession(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  // Headless (Playwright) backend — additive branch. Existing desktop/bridge
  // code below this block is unchanged.
  const requestedMode = body.mode as ComputerUseSessionMode | undefined;
  if (requestedMode === 'headless') {
    return startHeadlessSession(body, auth);
  }

  let bridgeInfo: { url: string; alreadyRunning: boolean };
  try {
    bridgeInfo = await startBridge();
  } catch (err) {
    return { success: false, error: (err as Error).message, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }

  const sessionId = 'cu-' + randomBytes(4).toString('hex');
  const session: ComputerUseSession = {
    id: sessionId,
    status: 'active',
    bridgeUrl: bridgeInfo.url,
    bridgeReachable: true,
    target: 'desktop',
    actions: [],
    createdAt: new Date().toISOString(),
    createdBy: auth.tokenName,
  };

  await withFileLock(DataPaths.computerUseSessions, async () => {
    const data = await loadData();
    data.sessions.unshift(session);
    const active = data.sessions.filter((s) => s.status === 'active');
    const closed = data.sessions.filter((s) => s.status !== 'active');
    data.sessions = [...active, ...closed.slice(0, MAX_SESSIONS)];
    data.bridgeStatus = {
      reachable: true,
      url: bridgeInfo.url,
      lastCheckedAt: new Date().toISOString(),
    };
    await writeJsonFile(DataPaths.computerUseSessions, data);
  });

  return { success: true, session };
}

export async function stopSession(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }

  // Headless — tear down the browser context, never touch the bridge shutdown scheduler.
  if (session.mode === 'headless') {
    await headless.stopHeadlessSession(sessionId);
    const closedAt = new Date().toISOString();
    await withFileLock(DataPaths.computerUseSessions, async () => {
      const data = await loadData();
      const s = data.sessions.find((s) => s.id === sessionId);
      if (s) {
        s.status = 'closed';
        s.closedAt = closedAt;
      }
      stripClosedSessionImages(data);
      await writeJsonFile(DataPaths.computerUseSessions, data);
    });
    return { success: true, closedAt };
  }

  const closedAt = new Date().toISOString();
  let activeDesktop = 0;

  await withFileLock(DataPaths.computerUseSessions, async () => {
    const data = await loadData();
    const s = data.sessions.find((s) => s.id === sessionId);
    if (s) {
      s.status = 'closed';
      s.closedAt = closedAt;
    }
    stripClosedSessionImages(data);
    activeDesktop = countActiveDesktopSessions(data.sessions);
    await writeJsonFile(DataPaths.computerUseSessions, data);
  });

  if (activeDesktop === 0) {
    scheduleBridgeShutdown();
  }

  return { success: true, closedAt };
}

// ─── Headless backend helpers (Phase A — additive) ──────────────────────────

async function startHeadlessSession(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  const sessionId = 'cu-' + randomBytes(4).toString('hex');
  const viewport = body.viewport as { width: number; height: number } | undefined;
  const userAgent = body.userAgent as string | undefined;
  const startUrl = body.startUrl as string | undefined;
  const maxConcurrent = body.maxConcurrent as number | undefined;

  let config: HeadlessSessionConfig;
  try {
    const started = await headless.startHeadlessSession({
      sessionId, viewport, userAgent, startUrl, maxConcurrent,
    });
    config = started.config;
  } catch (err) {
    if (err instanceof ComputerUseError) {
      return { success: false, error: err.message, code: err.code };
    }
    return { success: false, error: (err as Error).message ?? 'Headless launch failed', code: 'COMPUTER_USE_HEADLESS_LAUNCH_FAILED' };
  }

  const session: ComputerUseSession = {
    id: sessionId,
    status: 'active',
    bridgeUrl: '',
    bridgeReachable: false,
    target: 'browser',
    mode: 'headless',
    headless: config,
    actions: [],
    createdAt: new Date().toISOString(),
    createdBy: auth.tokenName,
  };

  await withFileLock(DataPaths.computerUseSessions, async () => {
    const data = await loadData();
    data.sessions.unshift(session);
    const active = data.sessions.filter((s) => s.status === 'active');
    const closed = data.sessions.filter((s) => s.status !== 'active');
    data.sessions = [...active, ...closed.slice(0, MAX_SESSIONS)];
    await writeJsonFile(DataPaths.computerUseSessions, data);
  });

  return { success: true, session };
}

function headlessUnsupported(action: string) {
  return {
    success: false,
    error: `${action} is not supported in headless mode (Phase A)`,
    code: 'COMPUTER_USE_HEADLESS_UNSUPPORTED',
  };
}

// Returns the rejection response if the session is headless, else null.
async function rejectIfHeadless(sessionId: string | undefined, action: string): Promise<unknown | null> {
  if (!sessionId) return null;
  const s = await getSession(sessionId);
  if (s?.mode === 'headless') return headlessUnsupported(action);
  return null;
}

function headlessErrorToResponse(err: unknown): unknown {
  if (err instanceof ComputerUseError) {
    return { success: false, error: err.message, code: err.code };
  }
  return { success: false, error: (err as Error).message ?? 'Headless action failed', code: 'COMPUTER_USE_HEADLESS_ERROR' };
}

export async function listSessions(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const data = await loadData();
  const statusFilter = body.status as string | undefined;

  const sessions = statusFilter
    ? data.sessions.filter((s) => s.status === statusFilter)
    : data.sessions;

  return { success: true, sessions, total: sessions.length };
}

export async function getSessionAction(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }

  return { success: true, session };
}

// ─── Bridge status ────────────────────────────────────────────────────────────

export async function bridgeStatus(_body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const health = await checkBridgeHealth();
  const status: ComputerUseBridgeStatus = {
    reachable: health.ok,
    url: health.url,
    screen: health.screen,
    monitorCount: health.monitorCount,
    monitors: health.monitors,
    writablePaths: health.writablePaths,
    lastCheckedAt: health.checkedAt,
  };

  // Persist latest bridge status
  await withFileLock(DataPaths.computerUseSessions, async () => {
    const data = await loadData();
    data.bridgeStatus = status;
    await writeJsonFile(DataPaths.computerUseSessions, data);
  });

  // Recovery snapshot (additive — an agent's d7890b68 hookup, ObiWan §9.3).
  const recovery = getBridgeRecoveryStats();

  return { success: true, bridge: status, recovery };
}

// ─── Raw primitive actions ────────────────────────────────────────────────────

async function runPrimitive(
  body: AgentApiRequest,
  actionType: Parameters<typeof proxyAction>[1],
  requiredParams: string[]
): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  // Validate required params
  for (const param of requiredParams) {
    if (body[param] === undefined || body[param] === null) {
      return {
        success: false,
        error: `Missing required parameter: ${param}`,
        code: 'COMPUTER_USE_INVALID_PARAMS',
      };
    }
  }

  // Headless backend dispatch (additive — bridge path below is unchanged).
  const session = await getSession(sessionId);
  if (session?.mode === 'headless') {
    try {
      const action = await runHeadlessPrimitive(sessionId, actionType, body as Record<string, unknown>);
      return {
        success: true,
        actionId: action.id,
        result: action.result,
        durationMs: action.result.durationMs,
        ...(actionType === 'screenshot' ? {
          image: action.result.imageBase64,
          format: action.result.imageFormat,
          width: action.result.imageWidth,
          height: action.result.imageHeight,
        } : {}),
      };
    } catch (err) {
      return headlessErrorToResponse(err);
    }
  }

  try {
    const action = await proxyAction(sessionId, actionType, body as Record<string, unknown>);
    return {
      success: true,
      actionId: action.id,
      result: action.result,
      durationMs: action.result.durationMs,
      ...(actionType === 'screenshot' ? {
        image: action.result.imageBase64,
        format: action.result.imageFormat,
        width: action.result.imageWidth,
        height: action.result.imageHeight,
        // Coordinate mapping: use these instead of guessing a scale. To click
        // image pixel (x,y): { x, y, space: 'screenshot', screenshotId }.
        screenshotId: action.result.screenshotId,
        mapping: action.result.mapping,
        howToClick: action.result.screenshotId
          ? `Click/scroll/drag with {x,y,space:"screenshot",screenshotId:"${action.result.screenshotId}"} using pixel positions in this ${action.result.imageWidth}x${action.result.imageHeight} image. Raw x,y without space are physical desktop pixels.`
          : undefined,
      } : {}),
    };
  } catch (err) {
    if (err instanceof ComputerUseError) {
      return fail(
        err.code as ComputerUseErrorCode,
        err.message,
        { sessionId, action: `computer-use.${actionType}` },
      );
    }
    const logId = randomBytes(4).toString('hex');
    console.error(`[computer-use] runPrimitive(${actionType}) unexpected error logId=${logId}:`, err);
    return fail(
      'COMPUTER_USE_INTERNAL',
      (err as Error).message ?? 'Unknown error',
      { logId, sessionId, action: `computer-use.${actionType}` },
    );
  }
}

// Default screenshot monitor=0 (all screens) so dual-monitor setups don't
// silently hide apps on the secondary display. Explicit monitor values are
// passed through unchanged. Audit task 6931d9a6.
export function applyScreenshotDefaults(
  body: Record<string, unknown>,
): Record<string, unknown> & { monitor: unknown } {
  const monitor = body.monitor;
  if (monitor === undefined || monitor === null) {
    return { ...body, monitor: 0 };
  }
  return { ...body, monitor };
}

/**
 * Screenshot options (all optional; default is the full stitched desktop, as before):
 *   monitor: 0 (all, default) | 'primary' (the owner's main screen) | N
 *   region:  {x,y,width,height} | [x,y,w,h] | "x,y,w,h" — a crop, physical pixels
 *            (or screenshot pixels with space:'screenshot'[, screenshotId])
 *   maxEdge: downscale so the longest edge is at most this (e.g. 1600)
 *   format:  'png' | 'jpeg' | 'webp'   quality: 1-100
 * The response always includes `screenshotId` and `mapping`.
 */
export async function screenshot(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  return runPrimitive(applyScreenshotDefaults(body) as unknown as AgentApiRequest, 'screenshot', ['sessionId']);
}

// ─── chat.send ────────────────────────────────────────────────────────────────

const CHAT_SEND_TIMEOUT_MS = 30_000;

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Build the bridge body for computer-use.chat.send from the caller's (camelCase,
 * nested) request. Coordinates stay as given; proxyActionRaw converts them from
 * screenshot space when `space:'screenshot'` / `screenshotId` is present.
 * Exported for unit tests.
 */
export function buildChatSendBody(body: Record<string, unknown>): { ok: true; bridge: Record<string, unknown> } | { ok: false; error: string } {
  const text = body.text;
  if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'text (non-empty string) is required' };
  if (text.length > 20000) return { ok: false, error: 'text is longer than 20000 characters' };

  const target = (body.target && typeof body.target === 'object' ? body.target : {}) as Record<string, unknown>;
  const x = numOrUndef(target.x) ?? numOrUndef(body.x);
  const y = numOrUndef(target.y) ?? numOrUndef(body.y);
  const locator = (target.locator ?? body.locator) as Record<string, unknown> | undefined;
  const useFocus = target.focused === true || body.useFocus === true;
  if (!useFocus && !locator && (x === undefined || y === undefined)) {
    return { ok: false, error: 'target needs {x,y} (screenshot or physical pixels), a locator {name}, or {focused:true}' };
  }

  // send: 'enter' | 'none' | { method: 'enter'|'click'|'none', x, y }
  const sendIn = body.send;
  const sendObj = (sendIn && typeof sendIn === 'object' ? sendIn : {}) as Record<string, unknown>;
  const sendMethod = (typeof sendIn === 'string' ? sendIn : (sendObj.method as string | undefined)) ?? 'enter';
  if (!['enter', 'click', 'none'].includes(sendMethod)) return { ok: false, error: 'send must be "enter", "none" or {method:"click",x,y}' };
  const sendX = numOrUndef(sendObj.x);
  const sendY = numOrUndef(sendObj.y);
  if (sendMethod === 'click' && (sendX === undefined || sendY === undefined)) {
    return { ok: false, error: 'send {method:"click"} needs x and y' };
  }

  const bridge: Record<string, unknown> = {
    text,
    use_focus: useFocus,
    clear: body.clear !== false,
    send_method: sendMethod,
    verify: body.verify !== false,
    dry_run: body.dryRun === true,
    restore_clipboard: body.restoreClipboard !== false,
  };
  if (!useFocus && x !== undefined && y !== undefined && !locator) { bridge.x = x; bridge.y = y; }
  if (locator) {
    bridge.locator = {
      name: locator.name,
      control_type: locator.controlType ?? locator.control_type ?? 'Edit',
      ...(locator.windowTitle ? { window_title: locator.windowTitle } : {}),
    };
  }
  if (sendX !== undefined && sendY !== undefined) { bridge.send_x = sendX; bridge.send_y = sendY; }
  if (typeof body.windowTitle === 'string') bridge.window_title = body.windowTitle;
  if (body.confirmRegion !== undefined) bridge.confirm_region = body.confirmRegion;
  if (numOrUndef(body.confirmDelayMs) !== undefined) bridge.confirm_delay_ms = body.confirmDelayMs;
  if (numOrUndef(body.maxEdge) !== undefined) bridge.max_edge = body.maxEdge;
  if (typeof body.format === 'string') bridge.format = body.format;
  if (numOrUndef(body.quality) !== undefined) bridge.quality = body.quality;
  // Conversion hints, consumed by resolveCoordinateParams (never sent to the bridge).
  for (const k of ['space', 'screenshotId', 'viewWidth', 'viewHeight']) {
    if (body[k] !== undefined) bridge[k] = body[k];
  }
  return { ok: true, bridge };
}

/**
 * computer-use.chat.send — paste exact UTF-8 text into a chat box, verify, send,
 * return one cropped confirmation. One call replaces focus + paste + screenshot +
 * Enter + screenshot. Never sends unless the box content was verified (or
 * verify:false). dryRun pastes and verifies but does not send.
 */
export async function chatSend(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };

  const built = buildChatSendBody(body as unknown as Record<string, unknown>);
  if (!built.ok) return { success: false, error: built.error, code: 'COMPUTER_USE_INVALID_PARAMS' };

  const session = await getSession(sessionId);
  if (session?.mode === 'headless') {
    return fail('COMPUTER_USE_HEADLESS_UNSUPPORTED', 'chat.send is desktop-only; use dom.type / dom.click for headless sessions', { sessionId, action: 'computer-use.chat.send' });
  }

  try {
    const { action, bridgeData } = await proxyActionRaw(sessionId, 'chat.send', built.bridge, {
      timeoutMs: CHAT_SEND_TIMEOUT_MS,
      tolerateFailure: true,
    });
    const sent = bridgeData.sent === true;
    const ok = bridgeData.success === true;
    return {
      success: ok,
      actionId: action.id,
      sent,
      verified: bridgeData.verified === true,
      dryRun: bridgeData.dry_run === true,
      status: bridgeData.status,
      ...(ok ? {} : { code: 'COMPUTER_USE_CHAT_NOT_SENT', error: bridgeData.error ?? 'Chat message was not sent' }),
      verifyMethod: bridgeData.verify_method,
      observedText: bridgeData.observed_text ?? null,
      located: bridgeData.located,
      // Cropped images: boxCrop = the box after pasting (before sending);
      // confirmation = one crop after sending. Each carries its own `mapping`.
      boxCrop: bridgeData.box_crop,
      confirmation: bridgeData.confirmation,
      resolved: action.result.resolved,
      timings: bridgeData.timings,
      bridgeDurationMs: bridgeData.duration_ms,
      durationMs: action.result.durationMs,
    };
  } catch (err) {
    if (err instanceof ComputerUseError) {
      return fail(err.code as ComputerUseErrorCode, err.message, { sessionId, action: 'computer-use.chat.send' });
    }
    const logId = randomBytes(4).toString('hex');
    console.error(`[computer-use] chatSend unexpected error logId=${logId}:`, err);
    return fail('COMPUTER_USE_INTERNAL', (err as Error).message ?? 'Unknown error', { logId, sessionId, action: 'computer-use.chat.send' });
  }
}

export async function click(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  return runPrimitive(body, 'click', ['sessionId', 'x', 'y']);
}

export async function doubleClick(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  return runPrimitive(body, 'double_click', ['sessionId', 'x', 'y']);
}

export async function rightClick(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  return runPrimitive(body, 'right_click', ['sessionId', 'x', 'y']);
}

export async function moveMouse(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  return runPrimitive(body, 'move', ['sessionId', 'x', 'y']);
}

export async function drag(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  return runPrimitive(body, 'drag', ['sessionId', 'x1', 'y1', 'x2', 'y2']);
}

export async function scroll(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  return runPrimitive(body, 'scroll', ['sessionId', 'x', 'y', 'direction']);
}

export async function typeText(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  return runPrimitive(body, 'type', ['sessionId', 'text']);
}

export async function sendKey(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  return runPrimitive(body, 'key', ['sessionId', 'keys']);
}

async function runHeadlessPrimitive(
  sessionId: string,
  actionType: ComputerUseActionType,
  params: Record<string, unknown>
): Promise<import('@/lib/types').ComputerUseAction> {
  switch (actionType) {
    case 'screenshot':    return headless.headlessScreenshot(sessionId, params);
    case 'click':         return headless.headlessClick(sessionId, params);
    case 'double_click':  return headless.headlessDoubleClick(sessionId, params);
    case 'right_click':   return headless.headlessRightClick(sessionId, params);
    case 'move':          return headless.headlessMove(sessionId, params);
    case 'drag':          return headless.headlessDrag(sessionId, params);
    case 'scroll':        return headless.headlessScroll(sessionId, params);
    case 'type':          return headless.headlessType(sessionId, params);
    case 'key':           return headless.headlessKey(sessionId, params);
    default:
      throw new ComputerUseError(
        `${actionType} is not supported in headless mode (Phase A)`,
        'COMPUTER_USE_HEADLESS_UNSUPPORTED',
        501,
        { headlessSessionId: sessionId, action: actionType },
      );
  }
}

// ─── Action sequences ────────────────────────────────────────────────────────

const MAX_SEQUENCE_STEPS = 50;
const SEQUENCE_TIMEOUT_MS = 30000;

// Valid action types inside a sequence step (bridge-supported only)
// Note: 'focus' / 'windows.focus' are NOT valid sequence steps — call windows.focus separately before/after a sequence.
const VALID_SEQUENCE_STEP_TYPES = new Set(['key', 'type', 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'screenshot', 'delay']);

export async function sequence(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const headlessReject = await rejectIfHeadless(sessionId, 'sequence');
  if (headlessReject) return headlessReject;

  const actions = body.actions as Array<Record<string, unknown>> | undefined;
  if (!actions || !Array.isArray(actions) || actions.length === 0) {
    return { success: false, error: 'actions array required (non-empty)', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }
  if (actions.length > MAX_SEQUENCE_STEPS) {
    return { success: false, error: `Maximum ${MAX_SEQUENCE_STEPS} steps per sequence`, code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  for (let i = 0; i < actions.length; i++) {
    const stepType = actions[i].action as string | undefined;
    if (stepType !== undefined && !VALID_SEQUENCE_STEP_TYPES.has(stepType)) {
      const hint = stepType === 'focus' || stepType === 'windows.focus'
        ? ' Tip: call computer-use.windows.focus as a separate action before or after the sequence.'
        : '';
      return {
        success: false,
        error: `Step ${i}: unsupported action type "${stepType}". Valid types: ${[...VALID_SEQUENCE_STEP_TYPES].join(', ')}.${hint}`,
        code: 'COMPUTER_USE_INVALID_PARAMS',
      };
    }
  }

  // Validate session exists and is active
  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }

  // Proxy to bridge's /actions/sequence endpoint
  const bridgeUrl = session.bridgeUrl;
  try {
    const res = await bridgeFetch(`${bridgeUrl}/actions/sequence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions }),
      timeoutMs: SEQUENCE_TIMEOUT_MS,
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    const stepResults = data.results as Array<Record<string, unknown>> | undefined;
    const succeeded = (data.success as boolean) ?? false;

    const auditSteps = actions.slice(0, 20).map((a, i) => ({
      type: a.type as string,
      params: Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'type')),
    }));
    const auditResults = stepResults?.slice(0, 20).map((r) => ({
      success: (r.success as boolean),
      durationMs: (r.durationMs as number | undefined),
      ...(r.error ? { error: (r.error as string).substring(0, 200) } : {}),
    }));

    // Record audit entry with step granularity
    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'sequence',
      params: { stepCount: actions.length, steps: auditSteps },
      result: {
        success: succeeded,
        durationMs: (data.totalDurationMs as number) ?? 0,
        stepsExecuted: data.stepsExecuted as number | undefined,
        failedAtStep: data.failedAtStep as number | undefined,
        error: succeeded ? undefined : ((data.error ?? data.detail) as string | undefined),
        stepResults: auditResults,
      },
      timestamp: new Date().toISOString(),
    });

    return {
      success: succeeded,
      results: data.results,
      totalDurationMs: data.totalDurationMs,
      stepsExecuted: data.stepsExecuted,
      ...(data.failedAtStep !== undefined ? { failedAtStep: data.failedAtStep } : {}),
      ...(data.error ? { error: data.error } : {}),
    };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'Sequence timed out (30s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

// ─── Window management ───────────────────────────────────────────────────────

const WINDOWS_TIMEOUT_MS = 10000;

/**
 * computer-use.windows.list
 * Returns all visible windows with title, handle, position, and size.
 * Read-only — not recorded in the session audit log.
 */
export async function windowsList(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.mode === 'headless') return headlessUnsupported('windows.list');
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }

  try {
    const res = await bridgeFetch(`${session.bridgeUrl}/windows`, {
      timeoutMs: WINDOWS_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;

    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    return { success: true, windows: data.windows, count: data.count };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'Request timed out (10s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

/**
 * computer-use.windows.focus
 * Bring a window to the foreground by handle or partial title match.
 * Recorded in the session audit log.
 */
export async function windowsFocus(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const handle = body.handle as number | undefined;
  const title = body.title as string | undefined;
  if (handle === undefined && !title) {
    return { success: false, error: "'handle' or 'title' required", code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }
  if (session.mode === 'headless') return headlessUnsupported('windows.focus');

  const start = Date.now();
  try {
    const res = await bridgeFetch(`${session.bridgeUrl}/windows/focus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: handle ?? null, title: title ?? null }),
      timeoutMs: WINDOWS_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;
    const durationMs = Date.now() - start;

    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    // Append to session audit log
    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'windows.focus',
      params: { handle: handle ?? null, title: title ?? null },
      result: { success: true, durationMs },
      timestamp: new Date().toISOString(),
    });

    return { success: true, handle: data.handle, title: data.title, durationMs };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'Request timed out (10s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

// ─── App launch ───────────────────────────────────────────────────────────────

// 10s wait-for-window cap + bridge overhead. Keep above the bridge-side cap.
const LAUNCH_TIMEOUT_MS = 15000;

// ─── Launch resolver mapping (audit task 7f854785) ──────────────────────────
//
// Daniel's research at .DevData/docs/ComputerUse/research-app-paths.md drives
// the Python-side resolver in scripts/computer_use_bridge.py (HKCU → HKLM
// App Paths in both 64/32-bit views → PATH → UWP fallback). The bridge
// returns structured codes on failure — we map them into the typed taxonomy
// so callers see consistent error shapes.

export interface LaunchBridgePayload {
  success: boolean;
  code?: string;
  detail?: string;
  error?: string;
  tried?: Array<unknown>;
  // Resolution metadata on success — surfaced as-is in the action response.
  resolvedPath?: string;
  source?: string;
  uwp?: boolean;
}

interface MappedLaunchError {
  code: ComputerUseErrorCode;
  message: string;
  context: ComputerUseErrorContext;
}

const LAUNCH_BRIDGE_CODE_MAP: Record<string, ComputerUseErrorCode> = {
  LAUNCH_NOT_FOUND: 'COMPUTER_USE_LAUNCH_NOT_FOUND',
  LAUNCH_UWP_NO_ARGS: 'COMPUTER_USE_LAUNCH_UWP_NO_ARGS',
};

export function mapLaunchBridgeError(data: LaunchBridgePayload): MappedLaunchError {
  const bridgeCode = typeof data.code === 'string' ? data.code : '';
  const code = LAUNCH_BRIDGE_CODE_MAP[bridgeCode] ?? 'COMPUTER_USE_BRIDGE_ERROR';
  const message =
    (typeof data.detail === 'string' && data.detail) ||
    (typeof data.error === 'string' && data.error) ||
    'launch failed';
  const context: ComputerUseErrorContext = { action: 'computer-use.launch' };
  // Compactly serialise tried[] + detail so both end up in error logs.
  const triedSummary = Array.isArray(data.tried) && data.tried.length > 0
    ? JSON.stringify(data.tried)
    : null;
  const detailParts: string[] = [];
  if (data.detail) detailParts.push(data.detail);
  if (triedSummary) detailParts.push(`tried=${triedSummary}`);
  if (detailParts.length > 0) context.bridgeDetail = detailParts.join(' | ');
  return { code, message, context };
}

/**
 * computer-use.launch
 * Launch an executable directly (bypasses Win+R → type → Enter dance).
 * Params: path (required), args?, cwd?, waitWindowTimeout? (seconds, 0-10).
 * Returns: pid, handle? (if window surfaced), title?, resolvedPath?, source?.
 */
export async function launch(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const launchPath = body.path as string | undefined;
  if (!launchPath || typeof launchPath !== 'string') {
    return { success: false, error: "'path' required (string)", code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }
  if (session.mode === 'headless') return headlessUnsupported('launch');

  const bridgeBody: Record<string, unknown> = { path: launchPath };
  if (body.args !== undefined) bridgeBody.args = body.args;
  if (body.cwd !== undefined) bridgeBody.cwd = body.cwd;
  if (body.waitWindowTimeout !== undefined) bridgeBody.wait_window_timeout = body.waitWindowTimeout;

  const start = Date.now();
  try {
    const res = await bridgeFetch(`${session.bridgeUrl}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bridgeBody),
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    const data = await res.json() as LaunchBridgePayload & Record<string, unknown>;
    const durationMs = Date.now() - start;

    if (!res.ok || data.success === false) {
      // Map structured bridge resolver codes (LAUNCH_NOT_FOUND, LAUNCH_UWP_NO_ARGS)
      // into the typed taxonomy. Audit task 7f854785.
      const mapped = mapLaunchBridgeError(data);
      return fail(mapped.code, mapped.message, {
        ...mapped.context,
        sessionId,
      });
    }

    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'launch',
      params: { path: launchPath, args: body.args ?? null, cwd: body.cwd ?? null },
      result: {
        success: true,
        pid: typeof data.pid === 'number' ? data.pid : null,
        handle: typeof data.handle === 'number' ? data.handle : null,
        durationMs,
      },
      timestamp: new Date().toISOString(),
    });

    return {
      success: true,
      pid: data.pid,
      handle: data.handle ?? null,
      title: data.title ?? null,
      command: data.command,
      // Resolution metadata from Daniel's resolver — surfaced so callers can log
      // which lookup branch matched (AppPaths/HKCU/64, PATH, UWP, …) and the
      // resolved absolute path even when the request was a bare exe name.
      resolvedPath: data.resolvedPath ?? null,
      source: data.source ?? null,
      uwp: data.uwp ?? false,
      durationMs,
    };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'Request timed out (15s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

// ─── Smart scroll ─────────────────────────────────────────────────────────────

const SMART_SCROLL_TIMEOUT_MS = 60000; // max 20 steps × ~3s each

/**
 * computer-use.scroll.smart
 * Scrolls incrementally until content stops moving (hash unchanged between steps).
 * Returns stepsExecuted, reachedEnd, and a final screenshot.
 */
export async function scrollSmart(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const x = body.x as number | undefined;
  const y = body.y as number | undefined;
  const direction = body.direction as string | undefined;
  if (x === undefined || y === undefined || !direction) {
    return { success: false, error: "'x', 'y', and 'direction' required", code: 'COMPUTER_USE_INVALID_PARAMS' };
  }
  if (!['up', 'down'].includes(direction)) {
    return { success: false, error: "'direction' must be 'up' or 'down'", code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.mode === 'headless') return headlessUnsupported('scroll.smart');
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }

  const bridgeBody = {
    x,
    y,
    direction,
    stepAmount: (body.stepAmount as number | undefined) ?? 5,
    maxSteps: (body.maxSteps as number | undefined) ?? 20,
    monitor: (body.monitor as number | undefined) ?? 0,
    preset: (body.preset as string | undefined) ?? 'quick',
  };

  const start = Date.now();
  try {
    const res = await bridgeFetch(`${session.bridgeUrl}/scroll/smart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bridgeBody),
      timeoutMs: SMART_SCROLL_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;
    const durationMs = Date.now() - start;

    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    // Append to session audit log
    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'scroll.smart',
      params: bridgeBody,
      result: {
        success: true,
        stepsExecuted: data.stepsExecuted as number | undefined,
        reachedEnd: data.reachedEnd as boolean | undefined,
        imageBase64: data.image as string | undefined,
        imageFormat: data.format as string | undefined,
        imageWidth: data.width as number | undefined,
        imageHeight: data.height as number | undefined,
        durationMs,
      },
      timestamp: new Date().toISOString(),
    });

    return {
      success: true,
      stepsExecuted: data.stepsExecuted,
      reachedEnd: data.reachedEnd,
      image: data.image,
      format: data.format,
      width: data.width,
      height: data.height,
      durationMs,
    };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'Smart scroll timed out (60s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

// ─── DOM actions (browser accessibility via Playwright CDP) ──────────────────

const DOM_TIMEOUT_MS = 15000;

/**
 * computer-use.dom.snapshot
 * Get the browser accessibility tree as YAML-like text with ref IDs.
 * Read-only — recorded in session audit as type 'dom.snapshot'.
 */
export async function domSnapshot(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }

  if (session.mode === 'headless') {
    try {
      const out = await headless.headlessDomSnapshot(sessionId, body as Record<string, unknown>);
      return { success: true, tree: out.tree, refs: out.refs, url: out.url, title: out.title, durationMs: out.action.result.durationMs };
    } catch (err) {
      return headlessErrorToResponse(err);
    }
  }

  try {
    const cdpUrl = body.cdpUrl as string | undefined;
    const url = `${session.bridgeUrl}/dom/snapshot${cdpUrl ? `?cdp_url=${encodeURIComponent(cdpUrl)}` : ''}`;
    const start = Date.now();
    const res = await bridgeFetch(url, { timeoutMs: DOM_TIMEOUT_MS });
    const data = await res.json() as Record<string, unknown>;
    const durationMs = Date.now() - start;

    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    // Record in session audit
    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'dom.snapshot' as ComputerUseActionType,
      params: { cdpUrl },
      result: { success: true, durationMs },
      timestamp: new Date().toISOString(),
    });

    return {
      success: true,
      tree: data.tree,
      refs: data.refs,
      url: data.url,
      title: data.title,
      durationMs,
    };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'DOM snapshot timed out (15s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

/**
 * computer-use.dom.click
 * Click a browser element by accessibility ref ID.
 */
export async function domClick(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  const ref = body.ref as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }
  if (!ref) {
    return { success: false, error: 'ref required (element reference ID from dom.snapshot)', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }

  if (session.mode === 'headless') {
    try {
      const action = await headless.headlessDomClick(sessionId, body as Record<string, unknown>);
      return { success: true, ref, action: 'click', durationMs: action.result.durationMs };
    } catch (err) {
      return headlessErrorToResponse(err);
    }
  }

  try {
    const cdpUrl = body.cdpUrl as string | undefined;
    const url = `${session.bridgeUrl}/dom/click${cdpUrl ? `?cdp_url=${encodeURIComponent(cdpUrl)}` : ''}`;
    const start = Date.now();
    const res = await bridgeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
      timeoutMs: DOM_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;
    const durationMs = Date.now() - start;

    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'dom.click' as ComputerUseActionType,
      params: { ref },
      result: { success: true, durationMs },
      timestamp: new Date().toISOString(),
    });

    return { success: true, ref, action: 'click', durationMs };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'DOM click timed out (15s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

/**
 * computer-use.dom.type
 * Type text into a browser element by accessibility ref ID.
 */
export async function domType(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  const ref = body.ref as string | undefined;
  const text = body.text as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }
  if (!ref) {
    return { success: false, error: 'ref required (element reference ID from dom.snapshot)', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }
  if (text === undefined) {
    return { success: false, error: 'text required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }

  if (session.mode === 'headless') {
    try {
      const action = await headless.headlessDomType(sessionId, body as Record<string, unknown>);
      return { success: true, ref, action: 'type', text, durationMs: action.result.durationMs };
    } catch (err) {
      return headlessErrorToResponse(err);
    }
  }

  try {
    const cdpUrl = body.cdpUrl as string | undefined;
    const clear = body.clear as boolean | undefined;
    const url = `${session.bridgeUrl}/dom/type${cdpUrl ? `?cdp_url=${encodeURIComponent(cdpUrl)}` : ''}`;
    const start = Date.now();
    const res = await bridgeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, text, clear: clear ?? false }),
      timeoutMs: DOM_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;
    const durationMs = Date.now() - start;

    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'dom.type' as ComputerUseActionType,
      params: { ref, text, clear },
      result: { success: true, durationMs },
      timestamp: new Date().toISOString(),
    });

    return { success: true, ref, action: 'type', text, durationMs };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'DOM type timed out (15s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

/**
 * computer-use.dom.select
 * Select an option in a browser select element by accessibility ref ID.
 */
export async function domSelect(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  const ref = body.ref as string | undefined;
  const value = body.value as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }
  if (!ref) {
    return { success: false, error: 'ref required (element reference ID from dom.snapshot)', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }
  if (!value) {
    return { success: false, error: 'value required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }

  if (session.mode === 'headless') {
    try {
      const action = await headless.headlessDomSelect(sessionId, body as Record<string, unknown>);
      return { success: true, ref, action: 'select', value, durationMs: action.result.durationMs };
    } catch (err) {
      return headlessErrorToResponse(err);
    }
  }

  try {
    const cdpUrl = body.cdpUrl as string | undefined;
    const url = `${session.bridgeUrl}/dom/select${cdpUrl ? `?cdp_url=${encodeURIComponent(cdpUrl)}` : ''}`;
    const start = Date.now();
    const res = await bridgeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, value }),
      timeoutMs: DOM_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;
    const durationMs = Date.now() - start;

    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'dom.select' as ComputerUseActionType,
      params: { ref, value },
      result: { success: true, durationMs },
      timestamp: new Date().toISOString(),
    });

    return { success: true, ref, action: 'select', value, durationMs };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'DOM select timed out (15s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

// ─── Context detection ───────────────────────────────────────────────────────

const CONTEXT_DETECT_TIMEOUT_MS = 10000;

/**
 * computer-use.context.detect
 * Detect the foreground window context (browser/desktop/unknown).
 * Read-only — not recorded in session audit.
 */
export async function contextDetect(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }

  if (session.mode === 'headless') {
    try {
      const info = await headless.headlessContextDetect(sessionId);
      return { success: true, type: info.type, process: info.process, app: info.process, title: info.title, url: info.url, pid: null, handle: null };
    } catch (err) {
      return headlessErrorToResponse(err);
    }
  }

  try {
    const res = await bridgeFetch(`${session.bridgeUrl}/context/detect`, {
      timeoutMs: CONTEXT_DETECT_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;

    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    return {
      success: true,
      type: data.type,
      process: data.process,
      app: data.process,  // BUG-C: alias for 'process' — callers may use either field
      title: data.title,
      pid: data.pid,
      handle: data.handle,
    };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'Context detection timed out (10s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

// ─── UIA endpoints (Windows Desktop Accessibility via pywinauto) ─────────────

const UIA_TIMEOUT_MS = 15000;

// ─── UIA preflight (audit task 3a0a980a) ────────────────────────────────────
//
// UWP apps (Notepad UWP, Calculator, Settings, etc.) host their content
// inside ApplicationFrameHost.exe and only populate the AX tree once the
// window has keyboard focus. Cold-launching one and immediately calling
// uia.snapshot returns ~1-2 elements (the frame chrome). Sending any
// no-op keyboard event then re-snapshotting returns the full tree.
//
// shouldRetryUiaSnapshot decides whether a fresh snapshot warrants a
// retry: low elementCount + a UWP signature in either the process name
// or the rendered tree text. Pure function for testability — wrapper
// owns the actual retry call.

export const UWP_PROCESS_SIGNATURES: RegExp[] = [
  /ApplicationFrameHost\.exe$/i,
  /SystemSettings\.exe$/i,
];

export const UWP_CLASS_NAMES: string[] = [
  'ApplicationFrameWindow',
  'Windows.UI.Core.CoreWindow',
];

const UIA_LOW_ELEMENT_THRESHOLD = 5;

interface UiaSnapshotProbe {
  elementCount?: number;
  elements?: unknown[];
  process?: string | null;
  title?: string | null;
  tree?: string;
}

export function shouldRetryUiaSnapshot(snapshot: UiaSnapshotProbe): boolean {
  const count = typeof snapshot.elementCount === 'number'
    ? snapshot.elementCount
    : (snapshot.elements?.length ?? 0);
  if (count >= UIA_LOW_ELEMENT_THRESHOLD) return false;

  if (snapshot.process && UWP_PROCESS_SIGNATURES.some((rx) => rx.test(snapshot.process!))) {
    return true;
  }
  if (snapshot.tree && UWP_CLASS_NAMES.some((c) => snapshot.tree!.includes(c))) {
    return true;
  }
  return false;
}

/**
 * computer-use.uia.snapshot
 * Get the Windows desktop accessibility tree for a target window.
 * Read-only — recorded in session audit as type 'uia.snapshot'.
 *
 * Includes a UWP preflight (audit task 3a0a980a): if the first snapshot
 * returns a near-empty tree from a UWP-hosted window, send a no-op shift
 * keypress to focus the window's content surface and re-snapshot once.
 */
export async function uiaSnapshot(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }

  if (session.mode === 'headless') return headlessUnsupported('uia.snapshot');

  try {
    const handle = body.handle as number | undefined;
    const title = body.title as string | undefined;
    const depth = body.depth as number | undefined;
    const params = new URLSearchParams();
    if (handle !== undefined) params.set('handle', String(handle));
    if (title) params.set('title', title);
    if (depth !== undefined) params.set('depth', String(depth));
    const qs = params.toString();
    const url = `${session.bridgeUrl}/uia/snapshot${qs ? `?${qs}` : ''}`;
    const start = Date.now();
    let res = await bridgeFetch(url, { timeoutMs: UIA_TIMEOUT_MS });
    let data = await res.json() as Record<string, unknown>;

    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    // UWP preflight: if the first snapshot is empty AND the focused window
    // looks like a UWP host, send a no-op shift keypress and re-snapshot once.
    // The keypress focuses the UWP content surface so pywinauto picks up the
    // populated AX tree on the second call. Audit task 3a0a980a.
    let preflightFired = false;
    if (shouldRetryUiaSnapshot(data as UiaSnapshotProbe)) {
      preflightFired = true;
      try {
        await proxyAction(sessionId, 'key', { keys: 'shift' });
      } catch {
        // Best-effort — if the keypress fails, still return what we have.
      }
      const retryRes = await bridgeFetch(url, { timeoutMs: UIA_TIMEOUT_MS });
      const retryData = await retryRes.json() as Record<string, unknown>;
      if (retryRes.ok && retryData.success !== false) {
        res = retryRes;
        data = retryData;
      }
    }

    const durationMs = Date.now() - start;

    // Record in session audit
    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'uia.snapshot' as ComputerUseActionType,
      params: { handle, title, depth, preflightFired },
      result: { success: true, durationMs },
      timestamp: new Date().toISOString(),
    });

    return {
      success: true,
      tree: data.tree,
      elements: data.elements,
      process: data.process,
      title: data.title,
      elementCount: data.elementCount,
      preflightFired,
      durationMs,
    };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'UIA snapshot timed out (15s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

/**
 * computer-use.uia.click
 * Click a desktop element by ref ID from the most recent uia.snapshot.
 */
export async function uiaClick(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  const ref = body.ref as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }
  if (!ref) {
    return { success: false, error: 'ref required (element reference ID from uia.snapshot)', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }

  if (session.mode === 'headless') return headlessUnsupported('uia.click');

  try {
    const method = body.method as string | undefined;
    const res = await bridgeFetch(`${session.bridgeUrl}/uia/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, method: method ?? 'auto' }),
      timeoutMs: UIA_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;

    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    // Record in session audit
    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'uia.click' as ComputerUseActionType,
      params: { ref, method },
      result: { success: true, durationMs: 0, method: data.method as string },
      timestamp: new Date().toISOString(),
    });

    return { success: true, ref, method: data.method, name: data.name };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'UIA click timed out (15s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

/**
 * computer-use.uia.type
 * Type text into a desktop element by ref ID from the most recent uia.snapshot.
 */
export async function uiaType(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const sessionId = body.sessionId as string | undefined;
  const ref = body.ref as string | undefined;
  const text = body.text as string | undefined;
  if (!sessionId) {
    return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }
  if (!ref) {
    return { success: false, error: 'ref required (element reference ID from uia.snapshot)', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }
  if (!text) {
    return { success: false, error: 'text required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }
  if (session.status !== 'active') {
    return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  }

  if (session.mode === 'headless') return headlessUnsupported('uia.type');

  try {
    const res = await bridgeFetch(`${session.bridgeUrl}/uia/type`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, text }),
      timeoutMs: UIA_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;

    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }

    // Record in session audit
    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'uia.type' as ComputerUseActionType,
      params: { ref, text: text.substring(0, 100) },
      result: { success: true, durationMs: 0, method: data.method as string },
      timestamp: new Date().toISOString(),
    });

    return { success: true, ref, method: data.method, text };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) {
      return { success: false, error: 'UIA type timed out (15s)', code: 'COMPUTER_USE_TIMEOUT' };
    }
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

// ─── Grounding Layer (context-aware element extraction) ─────────────────────
// Proxy actions for the GroundingRouter cascade in computer_use_bridge.py.
// /grounding/snapshot → CDP → UIA → OllamaVision → fallback_needed flag.
// /grounding/click + /grounding/type → resolve element ID → screen action.
// /grounding/status → which providers are live.

const GROUNDING_TIMEOUT_MS = 90000; // Ollama vision can take up to ~30s

/**
 * computer-use.grounding.snapshot
 * Run the GroundingRouter cascade and return a structured element map.
 * Populates the bridge ElementRegistry for the session.
 * If fallback_needed=true, caller should fall back to screenshot.
 * Params: sessionId, region (optional {x,y,w,h})
 */
export async function groundingSnapshot(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  const session = await getSession(sessionId);
  if (!session) return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  if (session.status !== 'active') return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  if (session.mode === 'headless') return headlessUnsupported('grounding.snapshot');

  const region = body.region as Record<string, number> | undefined;
  const start = Date.now();
  try {
    const res = await bridgeFetch(`${session.bridgeUrl}/grounding/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, region: region ?? null }),
      timeoutMs: GROUNDING_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;
    const durationMs = Date.now() - start;
    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }
    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'grounding.snapshot' as ComputerUseActionType,
      params: { region: region ?? null },
      result: { success: true, durationMs },
      timestamp: new Date().toISOString(),
    });
    return { success: true, elements: data.elements, provider: data.provider, elementCount: data.element_count, fallbackNeeded: data.fallback_needed, parseTimeMs: data.parse_time_ms, durationMs };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) return { success: false, error: 'Grounding snapshot timed out (90s)', code: 'COMPUTER_USE_TIMEOUT' };
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

/**
 * computer-use.grounding.click
 * Click a UI element by its grounding registry ID (from grounding.snapshot).
 * Claude never handles pixel coordinates — bridge resolves ID → centre.
 * Params: sessionId, elementId, button (optional: left|right|middle)
 */
export async function groundingClick(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();
  const sessionId = body.sessionId as string | undefined;
  const elementId = body.elementId as string | undefined;
  if (!sessionId) return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  if (!elementId) return { success: false, error: 'elementId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  const session = await getSession(sessionId);
  if (!session) return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  if (session.status !== 'active') return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  if (session.mode === 'headless') return headlessUnsupported('grounding.click');

  const button = (body.button as string | undefined) ?? 'left';
  const start = Date.now();
  try {
    const res = await bridgeFetch(`${session.bridgeUrl}/grounding/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, element_id: elementId, button }),
      timeoutMs: UIA_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;
    const durationMs = Date.now() - start;
    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }
    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'grounding.click' as ComputerUseActionType,
      params: { elementId, button },
      result: { success: true, durationMs },
      timestamp: new Date().toISOString(),
    });
    return { success: true, elementId, resolvedCenter: data.resolved_center, label: data.label, durationMs };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) return { success: false, error: 'Grounding click timed out', code: 'COMPUTER_USE_TIMEOUT' };
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

/**
 * computer-use.grounding.type
 * Type text into a UI element by its grounding registry ID.
 * Params: sessionId, elementId, text, interval (optional, seconds between keystrokes)
 */
export async function groundingType(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();
  const sessionId = body.sessionId as string | undefined;
  const elementId = body.elementId as string | undefined;
  const text = body.text as string | undefined;
  if (!sessionId) return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  if (!elementId) return { success: false, error: 'elementId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  if (text === undefined) return { success: false, error: 'text required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  const session = await getSession(sessionId);
  if (!session) return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  if (session.status !== 'active') return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  if (session.mode === 'headless') return headlessUnsupported('grounding.type');

  const interval = (body.interval as number | undefined) ?? 0.01;
  const start = Date.now();
  try {
    const res = await bridgeFetch(`${session.bridgeUrl}/grounding/type`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, element_id: elementId, text, interval }),
      timeoutMs: UIA_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;
    const durationMs = Date.now() - start;
    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }
    const { appendAction } = await import('@/lib/computer-use');
    const { randomUUID } = await import('crypto');
    await appendAction(sessionId, {
      id: randomUUID(),
      type: 'grounding.type' as ComputerUseActionType,
      params: { elementId, text: text.substring(0, 100) },
      result: { success: true, durationMs },
      timestamp: new Date().toISOString(),
    });
    return { success: true, elementId, text, label: data.label, durationMs };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    if (msg.includes('timeout') || msg.includes('TimeoutError')) return { success: false, error: 'Grounding type timed out', code: 'COMPUTER_USE_TIMEOUT' };
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

/**
 * computer-use.grounding.status
 * Get availability status of each GroundingProvider in the bridge cascade.
 * Params: sessionId
 */
export async function groundingStatus(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return { success: false, error: 'sessionId required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  const session = await getSession(sessionId);
  if (!session) return { success: false, error: 'Session not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  if (session.status !== 'active') return { success: false, error: 'Session is not active', code: 'COMPUTER_USE_SESSION_CLOSED' };
  if (session.mode === 'headless') return headlessUnsupported('grounding.status');

  try {
    const res = await bridgeFetch(`${session.bridgeUrl}/grounding/status`, {
      timeoutMs: CONTEXT_DETECT_TIMEOUT_MS,
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || data.success === false) {
      return { success: false, error: ((data.detail ?? data.error) as string) ?? res.statusText, code: 'COMPUTER_USE_BRIDGE_ERROR' };
    }
    return { success: true, providers: data.providers, registrySessions: data.registry_sessions };
  } catch (err) {
    const msg = (err as Error).message ?? 'Bridge request failed';
    return { success: false, error: `Bridge unreachable: ${msg}`, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }
}

// ─── Task execution (Approach B) ─────────────────────────────────────────────

const TASK_TMUX_PREFIX = 'computer-use-task-';
const TASK_OUTPUT_DIR = '/tmp/computer-use-tasks';
const MAX_TASKS_STORED = 50;
// task.run timeouts (audit task ae690a4e):
// - DEFAULT bumped 5min → 15min: previous 5min timed out real flows
//   (Outlook profile-dialog runs hit 4m44s, leaving zero margin).
// - RECOMMENDED_MIN is the threshold below which we surface a warning so
//   AI-loop callers know they've under-spec'd the timeout for the task type.
// - MAX is the hard ceiling — terminal-tasks would otherwise hold tmux for
//   too long.
export const DEFAULT_TIMEOUT_MS = 900_000;
export const RECOMMENDED_MIN_TIMEOUT_MS = 600_000;
export const MAX_TIMEOUT_MS = 1_800_000;
const MIN_TIMEOUT_FLOOR_MS = 10_000;
const MAX_PROMPT_SIZE = 100_000; // 100KB — generous but prevents unbounded input

/**
 * Resolve the effective timeout for a task.run request:
 *   1. Default when caller didn't specify (or specified 0).
 *   2. Clamp into [MIN_FLOOR, MAX].
 *   3. Surface a warning string when the *original* requested value is below
 *      RECOMMENDED_MIN — so callers learn about under-spec'd configs even if
 *      we honour the value.
 */
export function resolveTaskTimeout(
  requestedMs: number | undefined,
): { timeoutMs: number; warning?: string } {
  // Treat 0/null/undefined uniformly as 'no value provided'.
  const hasExplicit = typeof requestedMs === 'number' && requestedMs > 0;
  const raw = hasExplicit ? (requestedMs as number) : DEFAULT_TIMEOUT_MS;
  const clamped = Math.min(Math.max(raw, MIN_TIMEOUT_FLOOR_MS), MAX_TIMEOUT_MS);
  if (hasExplicit && (requestedMs as number) < RECOMMENDED_MIN_TIMEOUT_MS) {
    return {
      timeoutMs: clamped,
      warning: `timeoutMs=${requestedMs} is below the recommended minimum of ${RECOMMENDED_MIN_TIMEOUT_MS}ms for AI-loop tasks; long-running flows (auth dialogs, multi-step wizards) may not complete in time.`,
    };
  }
  return { timeoutMs: clamped };
}

// Idle threshold override for CU loops — claude's reasoning + curl round-trip
// can exceed the 8s default. 30s eliminates false completion on tool loops.
const CU_IDLE_THRESHOLD_MS = 30_000;

const AGENT_SCRIPT_API = `${getDevflowHome()}/scripts/computer_use_agent.py`;

// System prompt for the MAX dispatcher — ported from scripts/computer_use_agent_max.py.
// The terminal-tasks session injects {bridge_url} via CU_BRIDGE_URL env; we also
// expand it into the prompt so claude has the URL literal for curl commands.
const CU_SYSTEM_PROMPT_TEMPLATE = `You are a computer use agent controlling a Windows desktop on behalf of a user.
You interact with the desktop by calling a local HTTP bridge via bash commands.

Bridge URL: {bridge_url}

Available bridge commands:

  Take a screenshot and save it:
    curl -s "{bridge_url}/screenshot?format=jpeg&scale=0.7" | python3 -c "import json,sys,base64; d=json.load(sys.stdin); open('/tmp/cu_screen.jpg','wb').write(base64.b64decode(d['image'])); print('Screenshot saved')"
    Then view it: Read /tmp/cu_screen.jpg

  Left-click at coordinates (x, y):
    curl -s -X POST {bridge_url}/mouse/click -H 'Content-Type: application/json' -d '{"x":<X>,"y":<Y>,"button":"left"}'

  Right-click:
    curl -s -X POST {bridge_url}/mouse/click -H 'Content-Type: application/json' -d '{"x":<X>,"y":<Y>,"button":"right"}'

  Double-click:
    curl -s -X POST {bridge_url}/mouse/double_click -H 'Content-Type: application/json' -d '{"x":<X>,"y":<Y>}'

  Type text:
    curl -s -X POST {bridge_url}/keyboard/type -H 'Content-Type: application/json' -d '{"text":"<YOUR TEXT>"}'

  Send key combo (ctrl+c, alt+tab, Return, Escape, etc.):
    curl -s -X POST {bridge_url}/keyboard/key -H 'Content-Type: application/json' -d '{"keys":"ctrl+c"}'

  Scroll:
    curl -s -X POST {bridge_url}/mouse/scroll -H 'Content-Type: application/json' -d '{"x":<X>,"y":<Y>,"direction":"down","amount":3}'

  Launch application directly (bypasses Win+R dance):
    curl -s -X POST {bridge_url}/launch -H 'Content-Type: application/json' -d '{"path":"notepad.exe"}'

Instructions:
- Start by taking a screenshot to see the current state of the desktop.
- Complete the task described below using bash commands to call the bridge.
- After each significant action, take another screenshot to verify the result.
- When you have completed the task, write your final summary as:
    TASK_COMPLETE: <your summary of what you found or accomplished>
- Do NOT delete files, send emails, make purchases, or take other irreversible
  actions unless the task prompt explicitly instructs you to do so.
- If you cannot complete the task, write:
    TASK_COMPLETE: Unable to complete — <reason>
`;

/**
 * Resolve the bridge URL a WSL-side process (claude in tmux) should use.
 * DevFlow itself sets COMPUTER_USE_BRIDGE_HOST=localhost in ecosystem.config
 * (because it proxies via curl.exe in Windows network context) — ignore that
 * for WSL consumers and always derive the real Windows host IP from the
 * default gateway in /proc/net/route.
 */
function resolveBridgeUrlForWsl(): string {
  const { BRIDGE_PORT } = require('@/lib/computer-use-bridge') as { BRIDGE_PORT: number };
  let host = 'localhost';
  try {
    const route = require('fs').readFileSync('/proc/net/route', 'utf-8') as string;
    for (const line of route.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 8 && parts[1] === '00000000' && parts[7] === '00000000') {
        const hex = parts[2].padStart(8, '0');
        const ip = [
          parseInt(hex.slice(6, 8), 16),
          parseInt(hex.slice(4, 6), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(0, 2), 16),
        ].join('.');
        if (ip !== '0.0.0.0') { host = ip; break; }
      }
    }
  } catch {
    // Fall back to localhost — WSL2 mirrored mode may still work
  }
  return `http://${host}:${BRIDGE_PORT}`;
}

async function loadTask(taskId: string): Promise<ComputerUseTask | null> {
  const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, {
    sessions: [], tasks: [], bridgeStatus: null,
  });
  return data.tasks.find((t) => t.id === taskId) ?? null;
}

// ─── Max-backend watchdog helpers (audit task c13b9b8c) ──────────────────────
//
// The max backend dispatches CU tasks through /api/terminal-tasks. If the
// dispatcher becomes unreachable mid-flight, the watchdog must still:
//   1. Attempt to cancel the underlying terminal-task with bounded retries.
//   2. Fall back to killing the tmux session directly so we don't orphan it.
//   3. Mark the CU task as 'timeout' locally regardless of either outcome.
// Helpers are exported (not just internal) so the unit tests can inject
// fetch / token / sleep without spinning up a real server.

const WATCHDOG_CANCEL_MAX_ATTEMPTS = 3;
const WATCHDOG_CANCEL_BASE_DELAY_MS = 200;

interface CancelDeps {
  fetchFn?: typeof fetch;
  getToken?: () => Promise<string | null>;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

async function resolveToken(deps: CancelDeps): Promise<string | null> {
  if (deps.getToken) return deps.getToken();
  try {
    const { getDevFlowApiToken } = await import('@/lib/api-auth');
    return await getDevFlowApiToken();
  } catch {
    return null;
  }
}

export async function cancelTerminalTaskWithRetries(
  terminalTaskId: string,
  deps: CancelDeps = {},
): Promise<{ ok: boolean; attempts: number }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = deps.baseUrl ?? (process.env.DEVFLOW_BASE_URL || selfOrigin());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = deps.maxAttempts ?? WATCHDOG_CANCEL_MAX_ATTEMPTS;
  const token = await resolveToken(deps);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetchFn(`${baseUrl}/api/terminal-tasks`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'cancel', taskId: terminalTaskId }),
      });
      if (res.ok) return { ok: true, attempts: attempt };
    } catch {
      // network error — retry
    }
    if (attempt < maxAttempts) {
      await sleep(WATCHDOG_CANCEL_BASE_DELAY_MS * Math.pow(2, attempt - 1));
    }
  }
  return { ok: false, attempts: maxAttempts };
}

export async function getTerminalTaskTmuxName(
  terminalTaskId: string,
  deps: Omit<CancelDeps, 'sleep' | 'maxAttempts'> = {},
): Promise<string | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = deps.baseUrl ?? (process.env.DEVFLOW_BASE_URL || selfOrigin());
  const token = await resolveToken(deps);

  try {
    const res = await fetchFn(
      `${baseUrl}/api/terminal-tasks?action=get&taskId=${encodeURIComponent(terminalTaskId)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { task?: { tmuxSessionName?: string } };
    return data.task?.tmuxSessionName ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the .out file written by computer_use_agent.py and merge into stored task record.
 */
async function syncTaskFromOutput(task: ComputerUseTask): Promise<ComputerUseTask> {
  if (task.status !== 'running') return task;

  try {
    const outPath = path.join(TASK_OUTPUT_DIR, `${task.id}.out`);
    const raw = await fs.readFile(outPath, 'utf-8');
    const out = JSON.parse(raw) as {
      status?: string;
      result?: string;
      error?: string;
      actionsCount?: number;
    };

    const terminalStatuses = ['completed', 'failed', 'timeout', 'killed'];
    if (out.status && terminalStatuses.includes(out.status)) {
      const completedAt = new Date().toISOString();
      const updated: ComputerUseTask = {
        ...task,
        status: out.status as ComputerUseTask['status'],
        result: out.result,
        error: out.error,
        actionsCount: out.actionsCount,
        completedAt,
        durationMs: Date.now() - new Date(task.startedAt).getTime(),
      };

      // Persist the terminal status
      await withFileLock(DataPaths.computerUseSessions, async () => {
        const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, {
          sessions: [], tasks: [], bridgeStatus: null,
        });
        const idx = data.tasks.findIndex((t) => t.id === task.id);
        if (idx !== -1) data.tasks[idx] = updated;
        await writeJsonFile(DataPaths.computerUseSessions, data);
      });

      return updated;
    }

    if (out.actionsCount !== undefined) {
      return { ...task, actionsCount: out.actionsCount };
    }
  } catch {
    // Output file not written yet — task just started
  }

  return task;
}

/**
 * MAX-backend dispatcher — routes a CU task through /api/terminal-tasks rather
 * than spawning a Windows claude CLI. The terminal-task runs claude in a WSL
 * tmux session using the owner's Max subscription; env vars (CU_BRIDGE_URL,
 * CU_SESSION_ID, CU_TASK_ID) flow through claude into its bash tool calls and
 * drive the bridge over HTTP.
 *
 * Returns the ComputerUseTask record with terminalTaskId populated. Caller
 * polls computer-use.task.status which resolves via the xref.
 */
async function runTaskViaMaxDispatcher(args: {
  prompt: string;
  contextNote?: string;
  taskId: string;
  sessionId?: string;
  callbackUrl?: string;
  timeoutMs: number;
  auth: AgentAuthContext;
}): Promise<{ success: true; task: ComputerUseTask } | { success: false; error: string; code?: string }> {
  const { prompt, contextNote, taskId, sessionId, callbackUrl, timeoutMs, auth } = args;
  const now = new Date().toISOString();
  const bridgeUrl = resolveBridgeUrlForWsl();

  // Compose the full user prompt — task body only. System prompt holds
  // the bridge cheatsheet so claude's tool preamble stays separate.
  const fullPrompt = contextNote ? `${prompt}\n\nAdditional context: ${contextNote}` : prompt;
  const systemPrompt = CU_SYSTEM_PROMPT_TEMPLATE.replace(/\{bridge_url\}/g, bridgeUrl);

  // POST to /api/terminal-tasks?action=submit via an internal call.
  // We use getDevFlowApiToken() resolution already present in lib/api-auth.
  const { getDevFlowApiToken } = await import('@/lib/api-auth');
  const token = await getDevFlowApiToken();
  if (!token) {
    return fail(
      'COMPUTER_USE_TOKEN_MISSING',
      'DEVFLOW_API_TOKEN not configured — cannot dispatch to terminal-tasks',
      { action: 'computer-use.task.run', taskId },
    );
  }

  const base = process.env.DEVFLOW_BASE_URL || selfOrigin();
  const timeoutSeconds = Math.max(10, Math.floor(timeoutMs / 1000));
  const env: Record<string, string> = {
    CU_BRIDGE_URL: bridgeUrl,
    CU_TASK_ID: taskId,
  };
  if (sessionId) env.CU_SESSION_ID = sessionId;

  let terminalTaskId: string;
  try {
    const res = await fetch(`${base}/api/terminal-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        action: 'submit',
        prompt: fullPrompt,
        systemPrompt,
        engine: 'claude',
        model: 'sonnet',
        timeout: timeoutSeconds,
        env,
        idleThresholdMs: CU_IDLE_THRESHOLD_MS,
      }),
    });
    const data = await res.json() as { success?: boolean; task?: { id?: string }; error?: string };
    if (!res.ok || !data.success || !data.task?.id) {
      return fail(
        'COMPUTER_USE_TASK_DISPATCH_FAILED',
        `terminal-tasks submit failed: ${data.error ?? res.statusText}`,
        { action: 'computer-use.task.run', taskId, bridgeDetail: data.error },
      );
    }
    terminalTaskId = data.task.id;
  } catch (err) {
    return fail(
      'COMPUTER_USE_TASK_DISPATCHER_UNAVAILABLE',
      `terminal-tasks unreachable: ${(err as Error).message}`,
      { action: 'computer-use.task.run', taskId },
    );
  }

  const task: ComputerUseTask = {
    id: taskId,
    status: 'running',
    prompt,
    contextNote,
    tmuxSession: '', // owned by terminal-tasks, not us
    sessionId,
    backend: 'max',
    terminalTaskId,
    callbackUrl,
    startedAt: now,
    timeoutMs,
    createdBy: auth.tokenName,
  };

  // Persist task record + xref atomically
  await withFileLock(DataPaths.computerUseSessions, async () => {
    const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, {
      sessions: [], tasks: [], bridgeStatus: null,
    });
    data.tasks.unshift(task);
    const running = data.tasks.filter((t) => t.status === 'running');
    const done = data.tasks.filter((t) => t.status !== 'running');
    data.tasks = [...running, ...done.slice(0, MAX_TASKS_STORED)];

    const xrefs = data.xrefs ?? [];
    xrefs.push({
      cuTaskId: taskId,
      terminalTaskId,
      sessionId,
      callbackUrl,
      createdAt: now,
    });
    // Cap xref history roughly in line with tasks
    data.xrefs = xrefs.slice(-MAX_TASKS_STORED * 2);

    await writeJsonFile(DataPaths.computerUseSessions, data);
  });

  logEvent('tools', 'info', `computer-use task dispatched via max backend by ${auth.tokenName || 'agent'}`, {
    tool: 'computer-use',
    event: 'dispatched',
    taskId,
    terminalTaskId,
    requestedBy: auth.tokenName,
  }).catch(() => {});

  // Max-backend watchdog (audit task c13b9b8c). The api backend has its own
  // watchdog further down — for the max path we own the cancel propagation
  // because terminal-tasks may be unreachable when the deadline hits.
  setTimeout(() => {
    fireMaxBackendWatchdog(taskId, terminalTaskId).catch(() => { /* swallow */ });
  }, timeoutMs + 5000);

  return { success: true, task };
}

/**
 * Watchdog fired at timeoutMs+grace for max-backend tasks.
 * Bounded-retry cancel → tmux fallback → mark CU task as 'timeout'.
 * Idempotent: returns immediately if the task already left the running state
 * (cu-task-listener may have completed it normally before the deadline).
 */
async function fireMaxBackendWatchdog(taskId: string, terminalTaskId: string): Promise<void> {
  const current = await loadTask(taskId);
  if (current?.status !== 'running') return;

  const cancelResult = await cancelTerminalTaskWithRetries(terminalTaskId);

  let fallbackTmuxKilled = false;
  if (!cancelResult.ok) {
    const tmuxName = await getTerminalTaskTmuxName(terminalTaskId);
    if (tmuxName) {
      await execFileAsync('tmux', ['kill-session', '-t', tmuxName]).catch(() => {});
      fallbackTmuxKilled = true;
    }
  }

  // Mark CU task as 'timeout' locally regardless of cancel outcome — the
  // contract is that watchdog firing always reaches a terminal state.
  await withFileLock(DataPaths.computerUseSessions, async () => {
    const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, {
      sessions: [], tasks: [], bridgeStatus: null,
    });
    const t = data.tasks.find((t) => t.id === taskId);
    if (t && t.status === 'running') {
      t.status = 'timeout';
      t.completedAt = new Date().toISOString();
      t.durationMs = Date.now() - new Date(t.startedAt).getTime();
    }
    await writeJsonFile(DataPaths.computerUseSessions, data);
  });

  const severity = trackToolFailure('computer-use', true);
  logEvent('tools', severity, `computer-use max-backend watchdog fired for ${taskId}`, {
    tool: 'computer-use',
    event: 'watchdog-timeout',
    taskId,
    terminalTaskId,
    cancelOk: cancelResult.ok,
    cancelAttempts: cancelResult.attempts,
    fallbackTmuxKilled,
  }).catch(() => {});
}

/**
 * computer-use.task.run
 * Thin dispatcher. `max` backend routes through /api/terminal-tasks (preferred).
 * `api` backend spawns computer_use_agent.py in WSL tmux (escape hatch).
 * Returns immediately with a task ID — poll with task.status for completion.
 */
export async function runTask(body: AgentApiRequest, auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const prompt = body.prompt as string | undefined;
  if (!prompt?.trim()) {
    return { success: false, error: 'prompt is required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }
  if (prompt.length > MAX_PROMPT_SIZE) {
    return fail(
      'COMPUTER_USE_TASK_PROMPT_TOO_LARGE',
      `Prompt exceeds maximum size (${MAX_PROMPT_SIZE} chars)`,
      { field: 'prompt', action: 'computer-use.task.run' },
    );
  }

  const { timeoutMs, warning: timeoutWarning } = resolveTaskTimeout(
    body.timeoutMs as number | undefined,
  );
  if (timeoutWarning) {
    logEvent('tools', 'medium', timeoutWarning, {
      tool: 'computer-use',
      event: 'timeout-too-low',
      requestedTimeoutMs: body.timeoutMs,
      effectiveTimeoutMs: timeoutMs,
      recommendedMinMs: RECOMMENDED_MIN_TIMEOUT_MS,
    }).catch(() => {});
  }
  const contextNote = body.contextNote as string | undefined;
  const sessionId = body.sessionId as string | undefined;
  const callbackUrl = body.callbackUrl as string | undefined;

  // Headless sessions cannot host task.run in Phase A (the AI loop is bridge-shaped).
  if (sessionId) {
    const headlessReject = await rejectIfHeadless(sessionId, 'task.run');
    if (headlessReject) return headlessReject;
  }

  // Ensure bridge is running before dispatching
  try {
    await startBridge();
  } catch (err) {
    return { success: false, error: (err as Error).message, code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE' };
  }

  // Determine backend: request override > settings > default 'max'
  const settings = await readSettings();
  const backend: 'api' | 'max' =
    ((body.backend as string | undefined) === 'max' ? 'max' :
     (body.backend as string | undefined) === 'api' ? 'api' :
     settings.computerUse?.backend ?? 'max');

  // Generate task ID shared across both backends
  const taskId = 'cu-task-' + randomBytes(4).toString('hex');

  if (backend === 'max') {
    return await runTaskViaMaxDispatcher({
      prompt, contextNote, taskId, sessionId, callbackUrl, timeoutMs, auth,
    });
  }

  // ─── Legacy API backend (escape hatch) ─────────────────────────────────────
  const tmuxSession = `${TASK_TMUX_PREFIX}${taskId}`;
  const promptFile = `/tmp/cu-${taskId}.txt`;
  const timeoutSeconds = Math.floor(timeoutMs / 1000);
  const now = new Date().toISOString();

  // Write prompt to temp file (shell-safe, no escaping needed)
  const fullPrompt = contextNote
    ? `${prompt}\n\nAdditional context: ${contextNote}`
    : prompt;
  await fs.mkdir(TASK_OUTPUT_DIR, { recursive: true });
  await fs.writeFile(promptFile, fullPrompt);

  // API path — require ANTHROPIC_API_KEY. Bridge URL is the Windows-context
  // localhost for the old computer_use_agent.py (which runs via Windows python).
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await fs.unlink(promptFile).catch(() => {});
    return {
      success: false,
      error: 'ANTHROPIC_API_KEY not set. Switch backend to \'max\' or set ANTHROPIC_API_KEY.',
      code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE',
    };
  }
  const bridgeUrl = getBridgeUrl();
  const agentScript = AGENT_SCRIPT_API;
  const envVars: string[] = [`CU_BRIDGE_URL=${bridgeUrl}`, `ANTHROPIC_API_KEY=${apiKey}`];

  // Spawn agent in tmux — env vars passed via -e flags (not in command string)
  const sessionCmd = [
    'python3', agentScript,
    '--task-id', taskId,
    '--prompt-file', promptFile,
    '--timeout-seconds', String(timeoutSeconds),
  ].join(' ');

  const tmuxArgs = ['new-session', '-d', '-s', tmuxSession];
  for (const env of envVars) {
    tmuxArgs.push('-e', env);
  }
  tmuxArgs.push(sessionCmd);

  try {
    await execFileAsync('tmux', tmuxArgs);
  } catch (err) {
    await fs.unlink(promptFile).catch(() => {});
    return fail(
      'COMPUTER_USE_TASK_SPAWN_FAILED',
      `Failed to spawn agent: ${(err as Error).message}`,
      { action: 'computer-use.task.run', taskId },
    );
  }

  const task: ComputerUseTask = {
    id: taskId,
    status: 'running',
    prompt,
    contextNote,
    tmuxSession,
    backend: 'api',
    startedAt: now,
    timeoutMs,
    createdBy: auth.tokenName,
  };

  // Persist task record
  await withFileLock(DataPaths.computerUseSessions, async () => {
    const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, {
      sessions: [], tasks: [], bridgeStatus: null,
    });
    data.tasks.unshift(task);

    // Trim oldest terminal-state tasks, keep all running ones
    const running = data.tasks.filter((t) => t.status === 'running');
    const done = data.tasks.filter((t) => t.status !== 'running');
    data.tasks = [...running, ...done.slice(0, MAX_TASKS_STORED)];

    await writeJsonFile(DataPaths.computerUseSessions, data);
  });

  // Set hard timeout watchdog (kills tmux session after timeoutMs)
  setTimeout(async () => {
    const current = await loadTask(taskId);
    if (current?.status === 'running') {
      await execFileAsync('tmux', ['kill-session', '-t', tmuxSession]).catch(() => {});
      await withFileLock(DataPaths.computerUseSessions, async () => {
        const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, {
          sessions: [], tasks: [], bridgeStatus: null,
        });
        const t = data.tasks.find((t) => t.id === taskId);
        if (t && t.status === 'running') {
          t.status = 'timeout';
          t.completedAt = new Date().toISOString();
          t.durationMs = Date.now() - new Date(t.startedAt).getTime();
        }
        await writeJsonFile(DataPaths.computerUseSessions, data);
      });
    }
  }, timeoutMs + 5000); // 5s grace after agent's own timeout

  // Emit tool activity log
  logEvent('tools', 'info', `computer-use task submitted by ${auth.tokenName || 'agent'}`, {
    tool: 'computer-use',
    event: 'submitted',
    taskId,
    requestedBy: auth.tokenName,
    durationMs: undefined,
  }).catch(() => {});

  // Emit timeout event via watchdog (already fires after timeoutMs)
  setTimeout(async () => {
    const current = await loadTask(taskId);
    if (current?.status === 'timeout') {
      const severity = trackToolFailure('computer-use', true);
      logEvent('tools', severity, `computer-use task timed out (${taskId})`, {
        tool: 'computer-use',
        event: 'timeout',
        taskId,
        durationMs: timeoutMs,
      }).catch(() => {});
    }
  }, timeoutMs + 6000);

  return { success: true, task };
}

/**
 * computer-use.task.stop
 * Cancels the underlying runner:
 *   - max backend: POSTs cancel to /api/terminal-tasks via the xref
 *   - api backend: kills the tmux session directly
 * Marks the CU task as 'killed' either way.
 */
export async function stopTask(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const taskId = body.taskId as string | undefined;
  if (!taskId) {
    return { success: false, error: 'taskId is required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const task = await loadTask(taskId);
  if (!task) {
    return { success: false, error: 'Task not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }

  if (task.status !== 'running') {
    return fail(
      'COMPUTER_USE_TASK_ALREADY_DONE',
      `Task is already ${task.status}`,
      { action: 'computer-use.task.stop', taskId },
    );
  }

  // Cancel the underlying runner
  if (task.backend === 'max' && task.terminalTaskId) {
    try {
      const { getDevFlowApiToken } = await import('@/lib/api-auth');
      const token = await getDevFlowApiToken();
      const base = process.env.DEVFLOW_BASE_URL || selfOrigin();
      await fetch(`${base}/api/terminal-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action: 'cancel', taskId: task.terminalTaskId }),
      }).catch(() => {});
    } catch {
      // Best-effort — fall through to marking killed locally regardless
    }
  } else if (task.tmuxSession) {
    // Legacy api path — kill the tmux session directly
    await execFileAsync('tmux', ['kill-session', '-t', task.tmuxSession]).catch(() => {});
  }

  const completedAt = new Date().toISOString();

  await withFileLock(DataPaths.computerUseSessions, async () => {
    const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, {
      sessions: [], tasks: [], bridgeStatus: null,
    });
    const t = data.tasks.find((t) => t.id === taskId);
    if (t) {
      t.status = 'killed';
      t.completedAt = completedAt;
      t.durationMs = Date.now() - new Date(t.startedAt).getTime();
    }
    await writeJsonFile(DataPaths.computerUseSessions, data);
  });

  return { success: true, taskId, killedAt: completedAt };
}

/**
 * Fetch the backing terminal-task record for a max-backend CU task and merge
 * relevant fields (status, output, duration) onto the CU task before returning.
 * Caller persists the updated state only on terminal status transitions (the
 * cu-task-listener handles that via eventBus).
 */
async function syncTaskFromTerminal(task: ComputerUseTask): Promise<ComputerUseTask> {
  if (task.status !== 'running' || !task.terminalTaskId) return task;
  try {
    const { getDevFlowApiToken } = await import('@/lib/api-auth');
    const token = await getDevFlowApiToken();
    const base = process.env.DEVFLOW_BASE_URL || selfOrigin();
    const res = await fetch(`${base}/api/terminal-tasks?action=get&taskId=${encodeURIComponent(task.terminalTaskId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) return task;
    const data = await res.json() as { success?: boolean; task?: { status?: string; output?: string; completedAt?: string; durationMs?: number; error?: string } };
    if (!data.success || !data.task) return task;
    const terminal = data.task;
    // Map terminal-task status → CU task status
    const statusMap: Record<string, ComputerUseTask['status']> = {
      completed: 'completed',
      failed: 'failed',
      timeout: 'timeout',
      cancelled: 'killed',
    };
    const mapped = terminal.status ? statusMap[terminal.status] : undefined;
    const updated: ComputerUseTask = {
      ...task,
      result: terminal.output ?? task.result,
      error: terminal.error ?? task.error,
    };
    if (mapped) {
      updated.status = mapped;
      updated.completedAt = terminal.completedAt ?? new Date().toISOString();
      updated.durationMs = terminal.durationMs ?? (Date.now() - new Date(task.startedAt).getTime());
    }
    return updated;
  } catch {
    return task;
  }
}

/**
 * Structured task progress (audit task 04aa4c48).
 * Pollers use these fields to render progress UI without re-deriving from raw task data.
 *   - actionsCount: bridge actions performed during this task's lifetime
 *   - lastAction:   most recent action's type + timestamp (null if none yet) — drives 'stuck' detection
 *   - elapsedMs:    wall-clock since startedAt for running tasks, recorded durationMs for terminal
 *   - terminalState: true when status is one of completed/failed/timeout/killed — caller stops polling
 */
export interface TaskProgress {
  actionsCount: number;
  lastAction: { type: string; timestamp: string } | null;
  elapsedMs: number;
  terminalState: boolean;
}

const TERMINAL_TASK_STATUSES = new Set<ComputerUseTask['status']>(['completed', 'failed', 'timeout', 'killed']);

/**
 * Derive progress fields from a CU task and its (optional) session. The
 * session, when present, contains the per-action audit log used to compute
 * actionsCount and lastAction. When absent, falls back to the cached
 * `task.actionsCount` (set by the api-backend output-file syncer).
 */
export function computeTaskProgress(
  task: ComputerUseTask,
  session: ComputerUseSession | null,
): TaskProgress {
  const terminalState = TERMINAL_TASK_STATUSES.has(task.status);
  const elapsedMs = terminalState && task.durationMs !== undefined
    ? task.durationMs
    : Date.now() - new Date(task.startedAt).getTime();

  let actionsCount = task.actionsCount ?? 0;
  let lastAction: { type: string; timestamp: string } | null = null;

  if (session?.actions?.length) {
    const taskStartMs = new Date(task.startedAt).getTime();
    const taskActions = session.actions.filter(
      (a) => new Date(a.timestamp).getTime() >= taskStartMs,
    );
    if (taskActions.length > actionsCount) actionsCount = taskActions.length;
    if (taskActions.length > 0) {
      // Pick the temporally-last action, not array-order last (defensive against race-appends).
      const last = taskActions.reduce((a, b) =>
        new Date(a.timestamp).getTime() >= new Date(b.timestamp).getTime() ? a : b,
      );
      lastAction = { type: last.type, timestamp: last.timestamp };
    }
  }

  return { actionsCount, lastAction, elapsedMs, terminalState };
}

/**
 * computer-use.task.status
 * Returns current task status. Resolves via terminal-tasks for max backend,
 * via the legacy output file for api backend. Includes structured progress
 * (audit task 04aa4c48) so pollers can render UI and detect stuck tasks.
 */
export async function taskStatus(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const taskId = body.taskId as string | undefined;
  if (!taskId) {
    return { success: false, error: 'taskId is required', code: 'COMPUTER_USE_INVALID_PARAMS' };
  }

  const task = await loadTask(taskId);
  if (!task) {
    return { success: false, error: 'Task not found', code: 'COMPUTER_USE_SESSION_NOT_FOUND' };
  }

  const synced = task.backend === 'max'
    ? await syncTaskFromTerminal(task)
    : await syncTaskFromOutput(task);

  const session = synced.sessionId ? await getSession(synced.sessionId) : null;
  const progress = computeTaskProgress(synced, session);

  return { success: true, task: synced, progress };
}

/**
 * computer-use.task.list
 * Returns all tasks, optionally filtered by status.
 */
export async function listTasks(body: AgentApiRequest, _auth: AgentAuthContext): Promise<unknown> {
  await assertEnabled();

  const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, {
    sessions: [], tasks: [], bridgeStatus: null,
  });

  const statusFilter = body.status as string | undefined;
  let tasks = data.tasks;

  if (statusFilter) {
    tasks = tasks.filter((t) => t.status === statusFilter);
  }

  // Sync running tasks from output files
  const synced = await Promise.all(tasks.map(syncTaskFromOutput));

  return { success: true, tasks: synced, total: synced.length };
}
