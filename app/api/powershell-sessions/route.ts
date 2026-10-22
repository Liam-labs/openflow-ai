/**
 * PowerShell Sessions API - Cross-Platform Shell Access
 *
 * Provides persistent PowerShell sessions accessible from WSL.
 * Sessions stay open until explicitly closed (unlike terminal tasks which auto-close).
 *
 * This is SEPARATE from AI Terminal Tasks - it's a raw shell session system
 * that agents can use to execute PowerShell commands on Windows.
 *
 * Flow:
 *   1. Create session: spawns powershell.exe in tmux
 *   2. Send commands: via tmux send-keys
 *   3. Read output: via tmux capture-pane (full scrollback)
 *   4. Close session: graceful exit + tmux kill
 *
 * Actions:
 *   - create: Spawn a new PowerShell session
 *   - list: List all sessions
 *   - get: Get a specific session with output
 *   - send: Send a command to a session
 *   - output: Get current session output (optionally since timestamp)
 *   - close: Close a session
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import type {
  PowerShellSession,
  PowerShellCommand,
  PowerShellSessionsData,
  PowerShellActionRequest,
  PowerShellActionResponse,
} from '@/lib/types';

const execAsync = promisify(exec);

const DATA_PATH = DataPaths.powershellSessions;
const TMUX_PREFIX = 'ps-session-';
const OUTPUT_DIR = '/tmp/powershell-sessions';
const SCROLLBACK_LINES = 5000;
const DEFAULT_TIMEOUT = 1800; // 30 minutes
const MAX_TIMEOUT = 7200;     // 2 hours
const MAX_SESSIONS = 20;

const DEFAULT_DATA: PowerShellSessionsData = {
  sessions: [],
  lastUpdated: new Date().toISOString(),
};

// Track timeout timers for sessions
const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Strip ANSI escape codes from terminal output
 */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\[\?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/\x1B\[[<>=?!]*[0-9;]*[a-zA-Z@`]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t ${sessionName} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

async function getTmuxOutput(sessionName: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`tmux capture-pane -t ${sessionName} -p -S -${SCROLLBACK_LINES}`);
    return stripAnsi(stdout).trim();
  } catch {
    return '';
  }
}

function getOutputPath(sessionId: string): string {
  return `${OUTPUT_DIR}/${sessionId}.out`;
}

async function ensureOutputDir(): Promise<void> {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
  } catch { /* ignore */ }
}

async function killTmuxSession(sessionName: string): Promise<void> {
  try {
    await execAsync(`tmux kill-session -t ${sessionName} 2>/dev/null`);
  } catch { /* already gone */ }
}

/**
 * Reset the inactivity timeout for a session
 */
function resetSessionTimeout(sessionId: string, tmuxSessionName: string, timeout: number): void {
  // Clear existing timer
  const existing = sessionTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  if (timeout <= 0) return; // No timeout

  const timer = setTimeout(async () => {
    await closeSession(sessionId);
  }, timeout * 1000);
  sessionTimers.set(sessionId, timer);
}

/**
 * Close a PowerShell session
 */
async function closeSession(sessionId: string): Promise<void> {
  // Clear timer
  const timer = sessionTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    sessionTimers.delete(sessionId);
  }

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<PowerShellSessionsData>(DATA_PATH, DEFAULT_DATA);
    const session = data.sessions.find(s => s.id === sessionId);
    if (!session) return;

    // Capture final output
    if (await tmuxSessionExists(session.tmuxSessionName)) {
      const output = await getTmuxOutput(session.tmuxSessionName);
      try {
        await fs.writeFile(getOutputPath(sessionId), output);
      } catch { /* ignore */ }

      // Graceful exit
      try {
        await execAsync(`tmux send-keys -t ${session.tmuxSessionName} "exit" Enter`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch { /* ignore */ }

      await killTmuxSession(session.tmuxSessionName);
    }

    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    data.lastUpdated = new Date().toISOString();
    await writeJsonFile(DATA_PATH, data);
  });
}

/**
 * GET /api/powershell-sessions - List sessions
 */
export const GET = tracked('/api/powershell-sessions', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');

    const data = await readJsonFile<PowerShellSessionsData>(DATA_PATH, DEFAULT_DATA);
    let sessions = data.sessions;

    if (status) {
      sessions = sessions.filter(s => s.status === status);
    }

    // Sort by newest first
    sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Check if active sessions are still alive
    for (const session of sessions) {
      if (session.status === 'active') {
        const exists = await tmuxSessionExists(session.tmuxSessionName);
        if (!exists) {
          session.status = 'closed';
          session.closedAt = new Date().toISOString();
        }
      }
    }

    return NextResponse.json<PowerShellActionResponse>({
      success: true,
      sessions,
    });
  } catch (error) {
    console.error('[PowerShell] GET error:', error);
    return NextResponse.json<PowerShellActionResponse>(
      { success: false, error: 'Failed to load sessions' },
      { status: 500 }
    );
  }
});

/**
 * POST /api/powershell-sessions - Actions: create, get, send, output, close
 */
export const POST = tracked('/api/powershell-sessions', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body: PowerShellActionRequest = await request.json();
    const { action } = body;

    switch (action) {
      case 'create': {
        // Check powershell.exe is accessible
        try {
          await execAsync('which powershell.exe 2>/dev/null');
        } catch {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'powershell.exe not found. This feature requires WSL with Windows PowerShell accessible.' },
            { status: 400 }
          );
        }

        const timeout = Math.min(Math.max(body.timeout || DEFAULT_TIMEOUT, 0), MAX_TIMEOUT);
        const sessionId = randomUUID();
        const tmuxSessionName = `${TMUX_PREFIX}${sessionId.slice(0, 8)}`;
        const now = new Date().toISOString();

        await ensureOutputDir();

        // Spawn PowerShell in tmux
        const tmuxCmd = `tmux new-session -d -s ${tmuxSessionName} 'powershell.exe -NoLogo'`;
        await execAsync(tmuxCmd);

        // Wait for PS to initialize
        await new Promise(resolve => setTimeout(resolve, 2000));
        const exists = await tmuxSessionExists(tmuxSessionName);

        if (!exists) {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'Failed to start PowerShell session' },
            { status: 500 }
          );
        }

        // Get PID
        let pid: number | undefined;
        try {
          const { stdout } = await execAsync(`tmux list-panes -t ${tmuxSessionName} -F "#{pane_pid}"`);
          pid = parseInt(stdout.trim(), 10) || undefined;
        } catch { /* ignore */ }

        const session: PowerShellSession = {
          id: sessionId,
          status: 'active',
          tmuxSessionName,
          pid,
          commands: [],
          createdAt: now,
          lastActivityAt: now,
          timeout,
          createdBy: 'devflow-api',
        };

        await withFileLock(DATA_PATH, async () => {
          const data = await readJsonFile<PowerShellSessionsData>(DATA_PATH, DEFAULT_DATA);
          data.sessions.unshift(session);

          // Trim old closed sessions
          const active = data.sessions.filter(s => s.status === 'active');
          const closed = data.sessions.filter(s => s.status !== 'active');
          data.sessions = [...active, ...closed.slice(0, MAX_SESSIONS)];

          data.lastUpdated = now;
          await writeJsonFile(DATA_PATH, data);
        });

        // Set inactivity timeout
        if (timeout > 0) {
          resetSessionTimeout(sessionId, tmuxSessionName, timeout);
        }

        return NextResponse.json<PowerShellActionResponse>({
          success: true,
          session,
        });
      }

      case 'list': {
        const data = await readJsonFile<PowerShellSessionsData>(DATA_PATH, DEFAULT_DATA);
        const sessions = data.sessions.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        return NextResponse.json<PowerShellActionResponse>({
          success: true,
          sessions,
        });
      }

      case 'get': {
        if (!body.sessionId) {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'sessionId is required' },
            { status: 400 }
          );
        }

        const data = await readJsonFile<PowerShellSessionsData>(DATA_PATH, DEFAULT_DATA);
        const session = data.sessions.find(s => s.id === body.sessionId);
        if (!session) {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'Session not found' },
            { status: 404 }
          );
        }

        // Get live output if active
        if (session.status === 'active') {
          const exists = await tmuxSessionExists(session.tmuxSessionName);
          if (exists) {
            const output = await getTmuxOutput(session.tmuxSessionName);
            return NextResponse.json<PowerShellActionResponse>({
              success: true,
              session,
              output,
            });
          } else {
            session.status = 'closed';
            session.closedAt = new Date().toISOString();
          }
        }

        // Return saved output for closed sessions
        let output = '';
        try {
          output = await fs.readFile(getOutputPath(session.id), 'utf-8');
        } catch { /* no saved output */ }

        return NextResponse.json<PowerShellActionResponse>({
          success: true,
          session,
          output,
        });
      }

      case 'send': {
        if (!body.sessionId) {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'sessionId is required' },
            { status: 400 }
          );
        }
        if (!body.command?.trim()) {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'command is required' },
            { status: 400 }
          );
        }

        const data = await readJsonFile<PowerShellSessionsData>(DATA_PATH, DEFAULT_DATA);
        const session = data.sessions.find(s => s.id === body.sessionId);
        if (!session) {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'Session not found' },
            { status: 404 }
          );
        }

        if (session.status !== 'active') {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: `Session is ${session.status}, cannot send commands` },
            { status: 400 }
          );
        }

        const exists = await tmuxSessionExists(session.tmuxSessionName);
        if (!exists) {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'PowerShell session is no longer running' },
            { status: 400 }
          );
        }

        const command = body.command.trim();
        const commandId = randomUUID();
        const now = new Date().toISOString();

        // Send command via tmux - write to file first for shell safety
        const cmdFile = `${OUTPUT_DIR}/${session.id}.cmd`;
        await fs.writeFile(cmdFile, command);

        const bufferName = `ps${session.id.replace(/-/g, '').slice(0, 8)}`;
        await execAsync(`tmux load-buffer -b "${bufferName}" "${cmdFile}"`);
        await execAsync(`tmux paste-buffer -t ${session.tmuxSessionName} -b "${bufferName}"`);
        await new Promise(resolve => setTimeout(resolve, 100));
        await execAsync(`tmux send-keys -t ${session.tmuxSessionName} Enter`);

        // Clean up
        try {
          await execAsync(`tmux delete-buffer -b "${bufferName}" 2>/dev/null`);
          await fs.unlink(cmdFile);
        } catch { /* ignore */ }

        // Record command
        const cmdRecord: PowerShellCommand = {
          id: commandId,
          command,
          output: '', // Will be populated on next output read
          sentAt: now,
        };

        await withFileLock(DATA_PATH, async () => {
          const freshData = await readJsonFile<PowerShellSessionsData>(DATA_PATH, DEFAULT_DATA);
          const s = freshData.sessions.find(x => x.id === body.sessionId);
          if (s) {
            s.commands.push(cmdRecord);
            s.lastActivityAt = now;
            // Keep only last 100 commands
            if (s.commands.length > 100) {
              s.commands = s.commands.slice(-100);
            }
          }
          freshData.lastUpdated = now;
          await writeJsonFile(DATA_PATH, freshData);
        });

        // Reset inactivity timeout
        if (session.timeout > 0) {
          resetSessionTimeout(session.id, session.tmuxSessionName, session.timeout);
        }

        // Wait a moment for output, then capture
        await new Promise(resolve => setTimeout(resolve, 1500));
        const output = await getTmuxOutput(session.tmuxSessionName);

        // Persist output
        try {
          await fs.writeFile(getOutputPath(session.id), output);
        } catch { /* ignore */ }

        return NextResponse.json<PowerShellActionResponse>({
          success: true,
          session: { ...session, lastActivityAt: now },
          output,
        });
      }

      case 'output': {
        if (!body.sessionId) {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'sessionId is required' },
            { status: 400 }
          );
        }

        const data = await readJsonFile<PowerShellSessionsData>(DATA_PATH, DEFAULT_DATA);
        const session = data.sessions.find(s => s.id === body.sessionId);
        if (!session) {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'Session not found' },
            { status: 404 }
          );
        }

        let output = '';
        if (session.status === 'active' && await tmuxSessionExists(session.tmuxSessionName)) {
          output = await getTmuxOutput(session.tmuxSessionName);
          // Persist for crash recovery
          try {
            await fs.writeFile(getOutputPath(session.id), output);
          } catch { /* ignore */ }
        } else {
          // Read from file
          try {
            output = await fs.readFile(getOutputPath(session.id), 'utf-8');
          } catch { /* no saved output */ }
        }

        return NextResponse.json<PowerShellActionResponse>({
          success: true,
          output,
        });
      }

      case 'close': {
        if (!body.sessionId) {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'sessionId is required' },
            { status: 400 }
          );
        }

        const data = await readJsonFile<PowerShellSessionsData>(DATA_PATH, DEFAULT_DATA);
        const session = data.sessions.find(s => s.id === body.sessionId);
        if (!session) {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: 'Session not found' },
            { status: 404 }
          );
        }

        if (session.status !== 'active') {
          return NextResponse.json<PowerShellActionResponse>(
            { success: false, error: `Session is already ${session.status}` },
            { status: 400 }
          );
        }

        await closeSession(body.sessionId);

        // Re-read for updated state
        const updated = await readJsonFile<PowerShellSessionsData>(DATA_PATH, DEFAULT_DATA);
        const updatedSession = updated.sessions.find(s => s.id === body.sessionId);

        return NextResponse.json<PowerShellActionResponse>({
          success: true,
          session: updatedSession,
        });
      }

      default:
        return NextResponse.json<PowerShellActionResponse>(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[PowerShell] POST error:', error);
    return NextResponse.json<PowerShellActionResponse>(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
});
