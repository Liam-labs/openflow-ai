/**
 * Computer Use Session API
 *
 * GET  /api/computer-use                    — List sessions, tasks, and bridge status
 * GET  /api/computer-use?id=cu-xxx          — Get single session
 * POST /api/computer-use { action: 'bridge.start' | 'session.stop' | 'bridge.health' | 'deps.check' | 'deps.install' }
 *
 * Used by the dashboard UI and internal tooling.
 * Agent-facing actions go through POST /api/agent with computer-use.* action namespace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { checkBridgeHealth, getBridgeUrl, startBridge, scheduleBridgeShutdown, getBridgeRecoveryStats } from '@/lib/computer-use-bridge';
import { stripClosedSessionImages, getRecentSessions, compactArchiveSessions } from '@/lib/computer-use';
import { isComputerUseEnabled } from '@/lib/computer-use-settings';
import { requireAuthOrLocal } from '@/lib/api-auth';
import type { ComputerUseSessionsData, ComputerUseBridgeStatus } from '@/lib/types';
import { tracked } from '@/lib/api-tracking';
import { countActiveDesktopSessions, stopTask, taskStatus } from '@/app/api/agent/actions/computer-use';
import { disposeHeadlessRegistryEntry } from '@/lib/computer-use-headless';
import { DEPS_INSTALL_DIR_WIN, loadDepsInstallStatus } from '@/app/api/computer-use/deps-install';
import { fail, ERROR_CODE_HTTP_STATUS } from '@/app/api/computer-use/error-codes';

const execAsync = promisify(exec);

// Packages required on Windows Python for the computer-use bridge
const WINDOWS_DEPS: Array<{ pkg: string; importName: string }> = [
  { pkg: 'fastapi',    importName: 'fastapi' },
  { pkg: 'uvicorn',   importName: 'uvicorn' },
  { pkg: 'mss',       importName: 'mss' },
  { pkg: 'Pillow',    importName: 'PIL' },
  { pkg: 'pyautogui', importName: 'pyautogui' },
];

export const dynamic = 'force-dynamic';

const DEFAULT_DATA: ComputerUseSessionsData = {
  sessions: [],
  tasks: [],
  bridgeStatus: null,
};


async function loadData(): Promise<ComputerUseSessionsData> {
  return readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, DEFAULT_DATA);
}

/** Active sessions with no action for this long are no longer counted as running. */
const ACTIVE_SESSION_IDLE_MS = 30 * 60 * 1000;

export const GET = tracked('/api/computer-use', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('id');
    const summary = searchParams.get('summary'); // ?summary=true returns only counts (lightweight)

    if (sessionId) {
      // Single-session lookup: must search full file (session could be any age).
      const data = await loadData();
      const session = data.sessions.find((s) => s.id === sessionId);
      if (!session) {
        return NextResponse.json(
          fail('COMPUTER_USE_SESSION_NOT_FOUND', 'Session not found', {
            sessionId, action: 'computer-use.sessions.get',
          }),
          { status: ERROR_CODE_HTTP_STATUS.COMPUTER_USE_SESSION_NOT_FOUND },
        );
      }
      return NextResponse.json({ success: true, session });
    }

    // Lightweight summary for status polling — needs full data for accurate task count.
    if (summary === 'true') {
      const data = await loadData();
      // A session nobody has touched for a while is abandoned, not running (a Setup Wizard
      // session left open overnight kept the "Stop Computer Use" button on screen).
      const now = Date.now();
      const activeSessions = data.sessions.filter((s) => {
        if (s.status !== 'active') return false;
        const last = Date.parse(s.lastActionAt || s.createdAt || '');
        return !Number.isFinite(last) || now - last < ACTIVE_SESSION_IDLE_MS;
      }).length;
      const activeTasks = data.tasks.filter((t) => t.status === 'running').length;
      return NextResponse.json({
        success: true,
        activeSessions,
        activeTasks,
        bridge: data.bridgeStatus,
      });
    }

    // T4: dashboard list — bounded to last 50 sessions (newest-first) to cap response
    // size. Full file still read for tasks/bridge (negligible after base64 strip).
    const data = await loadData();
    const recentSessions = await getRecentSessions(50);
    const sessionsLight = recentSessions.map(({ actions, ...rest }) => ({
      ...rest,
      actionsCount: actions?.length ?? 0,
    }));

    return NextResponse.json({
      success: true,
      sessions: sessionsLight,
      tasks: data.tasks,
      bridge: data.bridgeStatus,
    });
  } catch (error) {
    const logId = randomBytes(4).toString('hex');
    console.error(`[computer-use] GET error logId=${logId}:`, error);
    return NextResponse.json(
      fail('COMPUTER_USE_INTERNAL', 'Internal error', { logId, action: 'computer-use.GET' }),
      { status: ERROR_CODE_HTTP_STATUS.COMPUTER_USE_INTERNAL },
    );
  }
});

export const POST = tracked('/api/computer-use', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json();
    const { action } = body;

    // Safety gate: bridge.start requires computer-use to be enabled.
    // session.stop is ungated — must work even when CU is disabled so orphaned sessions can be cleaned up.
    // deps.check, deps.install, and bridge.health are ungated (setup/diagnostic actions).
    if (action === 'bridge.start') {
      if (!await isComputerUseEnabled()) {
        return NextResponse.json(
          fail('COMPUTER_USE_DISABLED', 'Computer Use is disabled. Enable it in Settings first.', {
            action: 'computer-use.bridge.start',
          }),
          { status: ERROR_CODE_HTTP_STATUS.COMPUTER_USE_DISABLED },
        );
      }
    }

    if (action === 'bridge.start') {
      let bridgeInfo: { url: string; alreadyRunning: boolean };
      try {
        bridgeInfo = await startBridge();
      } catch (err) {
        const errorMsg = (err as Error).message;
        // Persist the startup error to bridge status so the UI can surface it durably
        await withFileLock(DataPaths.computerUseSessions, async () => {
          const data = await loadData();
          data.bridgeStatus = {
            reachable: false,
            url: getBridgeUrl(),
            lastCheckedAt: new Date().toISOString(),
            startupError: errorMsg,
          };
          await writeJsonFile(DataPaths.computerUseSessions, data);
        });
        return NextResponse.json(
          fail('COMPUTER_USE_BRIDGE_UNAVAILABLE', errorMsg, {
            action: 'computer-use.bridge.start',
            bridgeUrl: getBridgeUrl(),
          }),
          { status: ERROR_CODE_HTTP_STATUS.COMPUTER_USE_BRIDGE_UNAVAILABLE },
        );
      }

      const bridgeStatus: ComputerUseBridgeStatus = {
        reachable: true,
        url: bridgeInfo.url,
        lastCheckedAt: new Date().toISOString(),
      };

      await withFileLock(DataPaths.computerUseSessions, async () => {
        const data = await loadData();
        data.bridgeStatus = bridgeStatus;
        await writeJsonFile(DataPaths.computerUseSessions, data);
      });

      return NextResponse.json({ success: true, bridge: bridgeStatus, alreadyRunning: bridgeInfo.alreadyRunning });
    }

    if (action === 'session.stop') {
      const { sessionId } = body as { sessionId?: string };
      if (!sessionId) {
        return NextResponse.json(
          fail('COMPUTER_USE_VALIDATION_REQUIRED_FIELD_MISSING', 'sessionId required', {
            field: 'sessionId', action: 'computer-use.session.stop',
          }),
          { status: ERROR_CODE_HTTP_STATUS.COMPUTER_USE_VALIDATION_REQUIRED_FIELD_MISSING },
        );
      }

      const closedAt = new Date().toISOString();
      let activeDesktop = 0;
      let wasHeadless = false;

      await withFileLock(DataPaths.computerUseSessions, async () => {
        const data = await loadData();
        const session = data.sessions.find((s) => s.id === sessionId);
        if (session) {
          wasHeadless = session.mode === 'headless';
          session.status = 'closed';
          session.closedAt = closedAt;
        }
        stripClosedSessionImages(data);
        // Bridge is desktop-only — count only active desktop sessions to decide
        // whether to schedule its idle shutdown. Audit task 80f61091.
        activeDesktop = countActiveDesktopSessions(data.sessions);
        await writeJsonFile(DataPaths.computerUseSessions, data);
      });

      // Headless sessions own a Playwright context that must be disposed,
      // and they never use the bridge — skip scheduleBridgeShutdown for them.
      if (wasHeadless) {
        disposeHeadlessRegistryEntry(sessionId).catch(() => { /* non-fatal */ });
      } else if (activeDesktop === 0) {
        scheduleBridgeShutdown();
      }

      return NextResponse.json({ success: true, closedAt });
    }

    if (action === 'bridge.health') {
      const health = await checkBridgeHealth();
      // startupError intentionally omitted — health check clears any prior startup error
      const bridgeStatus: ComputerUseBridgeStatus = {
        reachable: health.ok,
        url: health.url,
        screen: health.screen,
        lastCheckedAt: health.checkedAt,
      };

      await withFileLock(DataPaths.computerUseSessions, async () => {
        const data = await loadData();
        data.bridgeStatus = bridgeStatus;
        await writeJsonFile(DataPaths.computerUseSessions, data);
      });

      // Recovery snapshot (additive — an agent's d7890b68 hookup, ObiWan §9.3).
      const recovery = getBridgeRecoveryStats();

      return NextResponse.json({ success: true, bridge: bridgeStatus, recovery });
    }

    if (action === 'deps.check') {
      // All checks run via powershell.exe so they target Windows Python, not WSL's python.
      // Calling python.exe directly from the WSL Node.js process hits WSL's Python via interop,
      // which will always show packages installed even when Windows Python lacks them.

      function psEncoded(cmd: string): string {
        return Buffer.from(cmd, 'utf16le').toString('base64');
      }

      // First verify Windows Python is genuine — the Windows Store stub returns exit 0 silently
      // without valid version output, which would cause all import checks to false-pass.
      let pythonOk = false;
      try {
        const { stdout, stderr } = await execAsync(
          `powershell.exe -EncodedCommand ${psEncoded('python --version')}`,
          { timeout: 10_000 }
        );
        const raw = (stdout || stderr).trim();
        pythonOk = /Python \d+\.\d+/.test(raw);
      } catch {
        pythonOk = false;
      }

      // If Windows Python isn't available, report all packages as missing immediately
      if (!pythonOk) {
        return NextResponse.json({
          success: true,
          allInstalled: false,
          missing: WINDOWS_DEPS.map(d => d.pkg),
          pythonMissing: true,
        });
      }

      // Check each package individually via PowerShell so missing[] is accurate
      const results = await Promise.all(
        WINDOWS_DEPS.map(async ({ pkg, importName }) => {
          try {
            await execAsync(
              `powershell.exe -EncodedCommand ${psEncoded(`python -c "import ${importName}"`)}`,
              { timeout: 10_000 }
            );
            return null; // installed
          } catch {
            return pkg; // missing
          }
        })
      );
      const missing = results.filter((p): p is string => p !== null);
      return NextResponse.json({ success: true, allInstalled: missing.length === 0, missing });
    }

    if (action === 'deps.install') {
      // Run pip install in a detached PowerShell session that ALSO captures
      // stdout/stderr to a log file and writes a JSON status sidecar before
      // and after pip exits. Agents can poll deps.install.status to observe
      // the result instead of relying on the fire-and-forget success:true.
      // Audit task 85fa35d9.
      const depsInstallId = randomBytes(4).toString('hex');
      const statusFileWin = `${DEPS_INSTALL_DIR_WIN}\\devflow-deps-install-${depsInstallId}.json`;
      const logFileWin = `${DEPS_INSTALL_DIR_WIN}\\devflow-deps-install-${depsInstallId}.log`;
      // Inner script: writes 'running' sidecar, runs pip with combined stream
      // tee'd to the log file, captures the exit code, and writes the final
      // 'completed'/'failed' sidecar atomically (write-then-rename).
      const psInner =
        `if (!(Test-Path '${DEPS_INSTALL_DIR_WIN}')) { New-Item -ItemType Directory -Path '${DEPS_INSTALL_DIR_WIN}' | Out-Null }; ` +
        `$startedAt = (Get-Date).ToUniversalTime().ToString('o'); ` +
        `@{ id='${depsInstallId}'; status='running'; startedAt=$startedAt } | ConvertTo-Json -Compress | Set-Content -Path '${statusFileWin}' -Encoding utf8; ` +
        `$ErrorActionPreference = 'Continue'; ` +
        `& python -m pip install fastapi uvicorn mss Pillow pyautogui 2>&1 | Tee-Object -FilePath '${logFileWin}'; ` +
        `$exit = $LASTEXITCODE; ` +
        `$endedAt = (Get-Date).ToUniversalTime().ToString('o'); ` +
        `$status = if ($exit -eq 0) { 'completed' } else { 'failed' }; ` +
        `$tmp = '${statusFileWin}.tmp'; ` +
        `@{ id='${depsInstallId}'; status=$status; startedAt=$startedAt; endedAt=$endedAt; exitCode=$exit } | ConvertTo-Json -Compress | Set-Content -Path $tmp -Encoding utf8; ` +
        `Move-Item -Path $tmp -Destination '${statusFileWin}' -Force`;
      const encoded = Buffer.from(psInner, 'utf16le').toString('base64');
      const child = spawn('powershell.exe', ['-EncodedCommand', encoded], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return NextResponse.json({ success: true, depsInstallId });
    }

    if (action === 'deps.install.status') {
      const { depsInstallId } = body as { depsInstallId?: string };
      if (!depsInstallId || typeof depsInstallId !== 'string') {
        return NextResponse.json(
          fail('COMPUTER_USE_VALIDATION_REQUIRED_FIELD_MISSING', 'depsInstallId required', {
            field: 'depsInstallId', action: 'computer-use.deps.install.status',
          }),
          { status: ERROR_CODE_HTTP_STATUS.COMPUTER_USE_VALIDATION_REQUIRED_FIELD_MISSING },
        );
      }
      // Reject anything that isn't pure hex — the id flows into a file path,
      // and we must not allow traversal or wildcards.
      if (!/^[a-f0-9]{4,64}$/i.test(depsInstallId)) {
        return NextResponse.json(
          fail('COMPUTER_USE_VALIDATION_FIELD_TYPE', 'invalid depsInstallId', {
            field: 'depsInstallId', action: 'computer-use.deps.install.status',
          }),
          { status: ERROR_CODE_HTTP_STATUS.COMPUTER_USE_VALIDATION_FIELD_TYPE },
        );
      }
      const status = await loadDepsInstallStatus(depsInstallId);
      if (!status) {
        return NextResponse.json(
          fail('COMPUTER_USE_TASK_NOT_FOUND', 'install record not found', {
            action: 'computer-use.deps.install.status',
          }),
          { status: ERROR_CODE_HTTP_STATUS.COMPUTER_USE_TASK_NOT_FOUND },
        );
      }
      return NextResponse.json({ success: true, install: status });
    }

    // task.stop / task.status — exposed on the dashboard route so the local UI
    // (Sheppard's progress + stop button) can call without bearer auth.
    // requireAuthOrLocal at the top of POST already handles localhost bypass +
    // bearer for non-local callers; we just forward to the same handlers the
    // /api/agent route uses, so behaviour is identical. Audit task 5119f8a2.
    if (action === 'task.stop' || action === 'task.status') {
      const dashboardAuthCtx = {
        tokenId: 'dashboard',
        tokenName: 'computer-use-dashboard',
        scope: 'write' as const,
        createdBy: 'dashboard',
      };
      const handler = action === 'task.stop' ? stopTask : taskStatus;
      const result = await handler(body, dashboardAuthCtx);
      // Pick HTTP status: handlers return either { success:true, ... } or a
      // structured failure with optional `code`. Map known error codes through
      // our HTTP table; default to 200 for success and 500 otherwise.
      const r = result as { success?: boolean; code?: keyof typeof ERROR_CODE_HTTP_STATUS };
      const httpStatus = r.success
        ? 200
        : (r.code && ERROR_CODE_HTTP_STATUS[r.code]) || 500;
      return NextResponse.json(result, { status: httpStatus });
    }

    // T4: daily compaction — archive closed sessions older than 7 days.
    if (action === 'compact') {
      const { archived, remaining } = await compactArchiveSessions(7);
      return NextResponse.json({ success: true, compacted: archived, remaining });
    }

    return NextResponse.json(
      fail('COMPUTER_USE_UNKNOWN_ACTION', `Unknown action: ${action}`, { action: String(action) }),
      { status: ERROR_CODE_HTTP_STATUS.COMPUTER_USE_UNKNOWN_ACTION },
    );
  } catch (error) {
    const logId = randomBytes(4).toString('hex');
    console.error(`[computer-use] POST error logId=${logId}:`, error);
    return NextResponse.json(
      fail('COMPUTER_USE_INTERNAL', 'Internal error', { logId, action: 'computer-use.POST' }),
      { status: ERROR_CODE_HTTP_STATUS.COMPUTER_USE_INTERNAL },
    );
  }
});
