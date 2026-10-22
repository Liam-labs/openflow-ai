import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  ClaudeSession,
  SessionsResponse,
  SessionActionRequest,
  SessionActionResponse,
  SessionsData,
  SessionStatus,
  CollabMessage,
  CollabChannelsData,
} from '@/lib/types';
import {
  spawnCollabPtySession,
  sendToPty,
} from '@/lib/collab-pty';
import { getWindowsTerminalTabs, type WindowsTerminalTab } from '@/lib/windows-terminal';
import { randomUUID } from 'crypto';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { readChannelMessages, appendMessage as appendChannelMessage } from '@/lib/collab-message-io';
import { tracked } from '@/lib/api-tracking';
import { appRoot } from '@/lib/app-paths';
import { getHomeDir, getWindowsHome } from '@/lib/home-dir';

const execAsync = promisify(exec);

const SESSIONS_PATH = DataPaths.sessions;
const HISTORY_PATH = path.join(process.env.HOME || '', '.claude', 'history.jsonl');

/** Guard: projectPath must resolve within HOME or process.cwd() */
function isAllowedProjectPath(p: string): boolean {
  const resolved = path.resolve(p);
  const home = getHomeDir();
  const cwd = appRoot();
  return resolved.startsWith(home + path.sep) || resolved === home ||
         resolved.startsWith(cwd + path.sep) || resolved === cwd;
}
const HEARTBEAT_FILENAME = '.claude/session-heartbeat.json';

// Default config
const DEFAULT_CONFIG = {
  pollInterval: 5000,
  staleThreshold: 30,
  autoDiscovery: true
};

interface DetectedProcess {
  pid: number;
  cwd: string;
  name?: string;  // Display name from collab-ready file
}

interface HistoryEntry {
  sessionId: string;
  project: string;
  timestamp: number;
}

const DEFAULT_SESSIONS_DATA: SessionsData = {
  sessions: [],
  config: DEFAULT_CONFIG,
  lastUpdated: new Date().toISOString(),
};

// Read sessions data from file
async function readSessionsData(): Promise<SessionsData> {
  return readJsonFile<SessionsData>(SESSIONS_PATH, DEFAULT_SESSIONS_DATA);
}

// Write sessions data to file (with stale pruning and cap)
const MAX_SESSIONS = 200;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEAD_PID_PRUNE_MS = 5 * 60 * 1000; // 5 minutes — prune dead-PID sessions faster

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    await fs.access(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

async function writeSessionsData(data: SessionsData): Promise<void> {
  await withFileLock(SESSIONS_PATH, async () => {
    // Prune sessions with no heartbeat in 24h, or dead PID + stale heartbeat > 5min
    const now = Date.now();
    const survived: ClaudeSession[] = [];
    for (const s of data.sessions) {
      const age = now - new Date(s.lastHeartbeat).getTime();
      if (age >= STALE_THRESHOLD_MS) continue; // Always prune after 24h
      if (age >= DEAD_PID_PRUNE_MS && s.pid) {
        // Check if PID is still alive — skip dead-PID sessions quickly
        const alive = await isPidAlive(s.pid);
        if (!alive) continue;
      }
      survived.push(s);
    }
    data.sessions = survived;
    // Hard cap — keep newest by heartbeat
    if (data.sessions.length > MAX_SESSIONS) {
      data.sessions.sort((a, b) => new Date(b.lastHeartbeat).getTime() - new Date(a.lastHeartbeat).getTime());
      data.sessions = data.sessions.slice(0, MAX_SESSIONS);
    }
    data.lastUpdated = new Date().toISOString();
    await writeJsonFile(SESSIONS_PATH, data);
  });
}

// Startup sweep — prune stale sessions without waiting for a write trigger
(async () => {
  try {
    const data = await readSessionsData();
    if (data.sessions.length > 0) {
      await writeSessionsData(data); // triggers pruning logic
    }
  } catch { /* best-effort */ }
})();

// Check if a session is collab-ready (running with collab-claude wrapper or PS bridge)
async function isCollabReady(pid: number): Promise<boolean> {
  // Check WSL ready file
  try {
    await fs.access(`/tmp/collab-ready-${pid}.json`);
    return true;
  } catch {
    // Not in WSL, check PS bridge
  }

  // Check PowerShell bridge ready file
  try {
    await fs.access(`${PS_BRIDGE_PATH}/ready-${pid}.json`);
    return true;
  } catch {
    return false;
  }
}

// Bridge path for PowerShell agent registration
const PS_BRIDGE_PATH = `${getWindowsHome()}/devflow-bridge/collab`;

// Detect running Claude processes (interactive terminal sessions only)
async function detectClaudeProcesses(): Promise<DetectedProcess[]> {
  const processes: DetectedProcess[] = [];
  const seenPids = new Set<number>();

  // 0. Detect collab-claude wrapper sessions (from /tmp/collab-ready-*.json files)
  try {
    const { stdout: files } = await execAsync("find /tmp -maxdepth 1 -name 'collab-ready-*.json' -type f 2>/dev/null || true");
    for (const file of files.trim().split('\n').filter(Boolean)) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const data = JSON.parse(content);
        const pid = data.pid;
        // Verify process still exists
        try {
          await fs.access(`/proc/${pid}`);
          const cwd = data.cwd || await fs.readlink(`/proc/${pid}/cwd`).catch(() => '');
          const name = data.name;  // Get display name from wrapper
          if (pid && cwd && !seenPids.has(pid)) {
            processes.push({ pid, cwd, name });
            seenPids.add(pid);
          }
        } catch {
          // Process is dead - clean up the stale ready file
          await fs.unlink(file).catch(() => {});
        }
      } catch {
        // File might be corrupted, ignore
      }
    }
  } catch {
    // No collab-ready files
  }

  // 0.5. Detect PowerShell agents via bridge directory (ready-*.json files)
  try {
    const { stdout: psFiles } = await execAsync(`find ${PS_BRIDGE_PATH} -maxdepth 1 -name 'ready-*.json' -type f 2>/dev/null || true`);
    for (const file of psFiles.trim().split('\n').filter(Boolean)) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const data = JSON.parse(content);
        const pid = data.pid;
        const name = data.name;  // Get display name from PS agent

        // Verify Windows process is still running via PowerShell
        let processAlive = false;
        try {
          // Validate PID is numeric before shell interpolation
          const safePid = Number.isInteger(pid) && pid > 0 ? pid : -1;
          const { stdout: psCheck } = await execAsync(
            `powershell.exe -NoProfile -Command "if (Get-Process -Id ${safePid} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }"`,
            { timeout: 3000 }
          );
          processAlive = psCheck.trim() === 'alive';
        } catch {
          // PowerShell check failed - check file age as fallback (stale if >5 min old)
          try {
            const stats = await fs.stat(file);
            const ageMinutes = (Date.now() - stats.mtimeMs) / 60000;
            processAlive = ageMinutes < 5; // Assume alive if file modified within 5 minutes
          } catch {
            processAlive = false;
          }
        }

        if (!processAlive) {
          // Process is dead - clean up stale ready file
          await fs.unlink(file).catch(() => {});
          continue;
        }

        const cwd = data.cwd || getWindowsHome();
        if (pid && !seenPids.has(pid)) {
          processes.push({ pid, cwd, name });
          seenPids.add(pid);
        }
      } catch (e) {
      }
    }
  } catch (e) {
  }

  // 1. Detect WSL/Linux terminal sessions
  try {
    // Detect all Claude CLI sessions in interactive terminals (pts/)
    // Matches both "claude" and "claude --dangerously-skip-permissions"
    // Excludes node processes (MCP servers) and background daemons
    const { stdout } = await execAsync(
      'ps -eo pid,tty,args | grep "pts/" | grep -E "^\\s*[0-9]+\\s+pts/[0-9]+\\s+claude" | grep -v grep'
    );
    const lines = stdout.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);
      if (!isNaN(pid) && !seenPids.has(pid)) {
        // Get CWD directly from /proc/{pid}/cwd symlink (most reliable)
        try {
          const cwd = await fs.readlink(`/proc/${pid}/cwd`);
          if (cwd) {
            processes.push({ pid, cwd });
            seenPids.add(pid);
          }
        } catch {
          // Process might have exited or we don't have permission
          continue;
        }
      }
    }
  } catch {
    // No WSL processes found
  }

  // Windows-native Claude processes are not probed here: Windows does not expose
  // another process's working directory (StartInfo is empty), so the old
  // per-process PowerShell probe never produced a session while costing one
  // interop spawn per Claude.exe process on every request. Windows agents are
  // discovered through their bridge ready files above.

  return processes;
}

// Get recent session IDs from history.jsonl
async function getRecentSessionsFromHistory(): Promise<Map<string, HistoryEntry>> {
  const sessionMap = new Map<string, HistoryEntry>();

  try {
    const data = await fs.readFile(HISTORY_PATH, 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean);

    // Process last 100 entries (most recent activity)
    const recentLines = lines.slice(-100);

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId && entry.project) {
          sessionMap.set(entry.project, {
            sessionId: entry.sessionId,
            project: entry.project,
            timestamp: entry.timestamp
          });
        }
      } catch {
        continue;
      }
    }
  } catch {
    // History file doesn't exist or can't be read
  }

  return sessionMap;
}

// Check for heartbeat file in a project
async function checkHeartbeat(projectPath: string): Promise<{ status: SessionStatus; currentTask?: string } | null> {
  // Path traversal guard: heartbeat must resolve within the project directory
  const heartbeatPath = path.resolve(projectPath, HEARTBEAT_FILENAME);
  const resolvedProject = path.resolve(projectPath);
  if (!heartbeatPath.startsWith(resolvedProject + path.sep)) {
    return null;
  }
  try {
    const data = await fs.readFile(heartbeatPath, 'utf-8');
    const heartbeat = JSON.parse(data);

    // Check if heartbeat is stale (older than 30 seconds)
    const heartbeatTime = new Date(heartbeat.timestamp).getTime();
    const now = Date.now();
    const ageSeconds = (now - heartbeatTime) / 1000;

    if (ageSeconds > 30) {
      return { status: 'offline' };
    }

    return {
      status: heartbeat.status || 'active',
      currentTask: heartbeat.currentTask
    };
  } catch {
    return null;
  }
}

// Get project name from path
function getProjectName(projectPath: string): string {
  return path.basename(projectPath);
}

// Main session detection logic
async function detectActiveSessions(): Promise<ClaudeSession[]> {
  const sessionsData = await readSessionsData();
  const detectedProcesses = await detectClaudeProcesses();
  const historyMap = await getRecentSessionsFromHistory();
  const now = new Date().toISOString();

  const activeSessions: ClaudeSession[] = [];
  const seenPids = new Set<number>();

  // First, check registered sessions (by session ID)
  for (const session of sessionsData.sessions) {
    // Check if session is still alive (process running or recent heartbeat)
    const heartbeat = await checkHeartbeat(session.projectPath);
    // Match by PID first (exact match), then fall back to matching by project path
    // This prevents wrong name assignment when multiple agents share the same project
    const pidMatch = detectedProcesses.find(p => p.pid === session.pid);
    const pathMatch = !pidMatch ? detectedProcesses.find(p => p.cwd === session.projectPath) : null;
    const matchingProcess = pidMatch || pathMatch;

    if (matchingProcess || (heartbeat && heartbeat.status !== 'offline')) {
      // Session is active - matching process takes precedence over stale heartbeat
      const updatedSession: ClaudeSession = {
        ...session,
        // If we have a matching process, session is active (regardless of stale heartbeat)
        // Otherwise use heartbeat status
        status: matchingProcess ? 'active' : (heartbeat?.status || 'active'),
        lastHeartbeat: now,
        currentTask: heartbeat?.currentTask || session.currentTask
      };

      if (matchingProcess) {
        seenPids.add(matchingProcess.pid);
        updatedSession.projectPath = matchingProcess.cwd; // Update CWD in case it changed
        updatedSession.projectName = getProjectName(matchingProcess.cwd);
        // Only update displayName from ready file if this is a PID match (not project path fallback)
        // This prevents wrong name assignment when multiple agents share the same project
        if (pidMatch && matchingProcess.name) {
          updatedSession.displayName = matchingProcess.name;
        }
      }

      activeSessions.push(updatedSession);
    } else {
      // Session is stale - check how long since last heartbeat
      const lastHeartbeat = new Date(session.lastHeartbeat).getTime();
      const ageSeconds = (Date.now() - lastHeartbeat) / 1000;

      if (ageSeconds < sessionsData.config.staleThreshold) {
        // Still within threshold, keep as active but mark as idle
        activeSessions.push({
          ...session,
          status: 'idle',
          lastHeartbeat: session.lastHeartbeat
        });
      }
      // Don't show sessions that are too stale
    }
  }

  // Auto-discover unregistered sessions if enabled
  // Each running Claude process gets its own entry
  if (sessionsData.config.autoDiscovery) {
    for (const process of detectedProcesses) {
      if (!seenPids.has(process.pid)) {
        // This is an unregistered session - try to get session ID from history
        const historyEntry = historyMap.get(process.cwd);

        const newSession: ClaudeSession = {
          sessionId: historyEntry?.sessionId || `pid-${process.pid}`,
          pid: process.pid,
          projectPath: process.cwd,
          projectName: getProjectName(process.cwd),
          // Use name from ready file if available (collab-ready sessions)
          displayName: process.name,
          status: 'active',
          registeredAt: now,
          lastHeartbeat: now,
          lastActivity: now,
          capabilities: ['code'],
          currentTask: undefined
        };

        // Check heartbeat for more info (but process is definitely running, so don't downgrade to offline)
        const heartbeat = await checkHeartbeat(process.cwd);
        if (heartbeat) {
          // Only use heartbeat status if it's not 'offline' (stale heartbeat shouldn't override running process)
          if (heartbeat.status !== 'offline') {
            newSession.status = heartbeat.status;
          }
          newSession.currentTask = heartbeat.currentTask;
        }

        activeSessions.push(newSession);
        seenPids.add(process.pid);
      }
    }
  }

  // Add collabReady status to all sessions
  for (const session of activeSessions) {
    if (session.pid) {
      session.collabReady = await isCollabReady(session.pid);
    }
  }

  return activeSessions;
}

// Every open DevFlow tab refreshes this on channel activity, and each scan
// spawns Windows interop processes. Concurrent callers share one scan.
let inFlightScan: Promise<[ClaudeSession[], WindowsTerminalTab[]]> | null = null;

function scanSessionsAndTabs(): Promise<[ClaudeSession[], WindowsTerminalTab[]]> {
  if (!inFlightScan) {
    inFlightScan = Promise.all([detectActiveSessions(), getWindowsTerminalTabs()])
      .finally(() => { inFlightScan = null; });
  }
  return inFlightScan;
}

export const GET = tracked('/api/claude/sessions', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const [sessions, terminalTabs] = await scanSessionsAndTabs();

    return NextResponse.json<SessionsResponse>({
      sessions,
      terminalTabs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    return NextResponse.json<SessionsResponse>({
      sessions: [],
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Failed to fetch sessions'
    });
  }
});

export const POST = tracked('/api/claude/sessions', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body: SessionActionRequest = await request.json();

    // sessionId is optional for spawn, spawn_pty, and invite_to_channel actions
    if (!body.sessionId && body.action !== 'spawn' && body.action !== 'spawn_pty' && body.action !== 'invite_to_channel') {
      return NextResponse.json<SessionActionResponse>({
        success: false,
        error: 'sessionId is required'
      }, { status: 400 });
    }

    const sessionsData = await readSessionsData();
    const now = new Date().toISOString();

    if (body.action === 'register') {
      if (!body.projectPath) {
        return NextResponse.json<SessionActionResponse>({
          success: false,
          error: 'projectPath is required for registration'
        }, { status: 400 });
      }

      if (!isAllowedProjectPath(body.projectPath)) {
        return NextResponse.json<SessionActionResponse>({
          success: false,
          error: 'projectPath is outside allowed paths'
        }, { status: 400 });
      }

      // Check if session already exists
      const existingIndex = sessionsData.sessions.findIndex(
        s => s.sessionId === body.sessionId || s.projectPath === body.projectPath
      );

      const newSession: ClaudeSession = {
        sessionId: body.sessionId!, // Already validated as required for non-spawn actions
        pid: typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : 0,
        projectPath: body.projectPath,
        projectName: getProjectName(body.projectPath),
        displayName: body.displayName,
        status: body.status || 'active',
        registeredAt: now,
        lastHeartbeat: now,
        lastActivity: now,
        capabilities: body.capabilities || ['code'],
        currentTask: body.currentTask
      };

      if (existingIndex >= 0) {
        // Update existing session
        sessionsData.sessions[existingIndex] = {
          ...sessionsData.sessions[existingIndex],
          ...newSession,
          registeredAt: sessionsData.sessions[existingIndex].registeredAt // Keep original registration time
        };
      } else {
        // Add new session
        sessionsData.sessions.push(newSession);
      }

      await writeSessionsData(sessionsData);

      // Sync displayName to any channel participants matching this PID
      // This ensures /register-session updates are reflected in collab channels
      if (body.pid && body.displayName) {
        const syncPid = body.pid;
        const syncName = body.displayName;
        try {
          await mutateChannels('claude-sessions:register-sync-display-name', async channelsData => {
            let channelsUpdated = false;

            for (const channel of channelsData.channels) {
              for (const participant of channel.participants) {
                // Match by PID for terminal agents
                if (participant.pid === syncPid && participant.name !== syncName) {
                  participant.name = syncName;
                  channelsUpdated = true;
                }
              }
            }

            if (channelsUpdated) {
              await saveChannels(channelsData);
            }
          });
        } catch (syncError) {
          // Don't fail registration if sync fails - just log it
          console.error('[Sessions] Failed to sync displayName to channels:', syncError);
        }
      }

      return NextResponse.json<SessionActionResponse>({
        success: true,
        message: existingIndex >= 0 ? 'Session updated' : 'Session registered',
        sessionId: body.sessionId
      });
    }

    if (body.action === 'heartbeat') {
      let heartbeatResult: NextResponse<SessionActionResponse> | null = null;
      let syncPid: number | undefined;
      let syncName: string | undefined;

      await withFileLock(SESSIONS_PATH, async () => {
        // Re-read inside the lock to get current state
        const lockedData = await readJsonFile<SessionsData>(SESSIONS_PATH, DEFAULT_SESSIONS_DATA);
        const sessionIndex = lockedData.sessions.findIndex(s => s.sessionId === body.sessionId);

        if (sessionIndex >= 0) {
          lockedData.sessions[sessionIndex].lastHeartbeat = now;
          lockedData.sessions[sessionIndex].lastActivity = now;

          // Update PID if provided (allows process tracking)
          if (body.pid && body.pid > 0) {
            lockedData.sessions[sessionIndex].pid = body.pid;
          }
          if (body.status) {
            lockedData.sessions[sessionIndex].status = body.status;
          }
          if (body.currentTask !== undefined) {
            lockedData.sessions[sessionIndex].currentTask = body.currentTask;
          }
          if (body.displayName !== undefined) {
            lockedData.sessions[sessionIndex].displayName = body.displayName;
          }

          // Capture PID for post-lock sync
          syncPid = body.pid || lockedData.sessions[sessionIndex].pid;
          syncName = body.displayName;

          await writeJsonFile(SESSIONS_PATH, lockedData);
          heartbeatResult = NextResponse.json<SessionActionResponse>({
            success: true,
            message: 'Heartbeat recorded'
          });
        } else if (body.projectPath && isAllowedProjectPath(body.projectPath)) {
          // Session not registered - auto-register inside the lock
          const newSession: ClaudeSession = {
            sessionId: body.sessionId!, // Already validated as required for non-spawn actions
            pid: body.pid || 0,
            projectPath: body.projectPath,
            projectName: getProjectName(body.projectPath),
            displayName: body.displayName,
            status: body.status || 'active',
            registeredAt: now,
            lastHeartbeat: now,
            lastActivity: now,
            capabilities: body.capabilities || ['code'],
            currentTask: body.currentTask
          };

          lockedData.sessions.push(newSession);
          await writeJsonFile(SESSIONS_PATH, lockedData);
          heartbeatResult = NextResponse.json<SessionActionResponse>({
            success: true,
            message: 'Session auto-registered via heartbeat',
            sessionId: body.sessionId
          });
        }
        // else: not found, no projectPath — heartbeatResult stays null
      });

      if (heartbeatResult) {
        // Sync displayName to channel participants (same logic as register)
        if (syncPid && syncName !== undefined) {
          const resolvedSyncName: string = syncName;
          try {
            await mutateChannels('claude-sessions:heartbeat-sync-display-name', async channelsData => {
              let channelsUpdated = false;

              for (const channel of channelsData.channels) {
                for (const participant of channel.participants) {
                  if (participant.pid === syncPid && participant.name !== resolvedSyncName) {
                    participant.name = resolvedSyncName;
                    channelsUpdated = true;
                  }
                }
              }

              if (channelsUpdated) {
                await saveChannels(channelsData);
              }
            });
          } catch {
            // Don't fail heartbeat if sync fails
          }
        }

        return heartbeatResult;
      }

      return NextResponse.json<SessionActionResponse>({
        success: false,
        error: 'Session not found. Provide projectPath to auto-register.'
      }, { status: 404 });
    }

    if (body.action === 'unregister') {
      const sessionIndex = sessionsData.sessions.findIndex(s => s.sessionId === body.sessionId);

      if (sessionIndex >= 0) {
        sessionsData.sessions.splice(sessionIndex, 1);
        await writeSessionsData(sessionsData);

        return NextResponse.json<SessionActionResponse>({
          success: true,
          message: 'Session unregistered'
        });
      }

      return NextResponse.json<SessionActionResponse>({
        success: false,
        error: 'Session not found'
      }, { status: 404 });
    }

    if (body.action === 'spawn') {
      // Spawn a new Claude session in a terminal window
      const channelId = body.channelId;
      const channelName = body.channelName || 'Collaboration';

      try {
        // Sanitize channelId for use in path (UUID chars only; prevents path traversal/injection)
        const safeChannelId = typeof channelId === 'string'
          ? channelId.replace(/[^a-zA-Z0-9\-]/g, '').slice(0, 64)
          : 'default';
        // Sanitize channelName for use in terminal title (alphanumeric + dash only, same as safeChannelId)
        const safeName = typeof channelName === 'string'
          ? channelName.replace(/[^a-zA-Z0-9\-]/g, '').slice(0, 50) || 'Collaboration'
          : 'Collaboration';
        // Create a collab context directory with chat history
        const collabDir = `/tmp/devflow-collab-${safeChannelId}`;
        await fs.mkdir(collabDir, { recursive: true });

        // Build context file with chat history
        let contextContent = `# Collaboration Session: ${channelName}\n\n`;
        contextContent += `> You are joining an active collaboration channel. Read the conversation below and participate naturally.\n\n`;
        contextContent += `**Channel:** ${channelName}\n`;
        contextContent += `**API Endpoint:** http://localhost:3000/api/collab\n`;

        if (channelId) {
          // Fetch channel history from per-channel message file
          try {
            const msgData = await readChannelMessages(channelId);

            if (msgData.messages.length > 0) {
              contextContent += `**Channel ID:** ${channelId}\n\n`;
              contextContent += `## Recent Conversation\n\n`;

              // Include last 20 messages for context
              const recentMessages = msgData.messages.slice(-20);
              for (const msg of recentMessages) {
                const timestamp = new Date(msg.timestamp).toLocaleTimeString();
                const sender = msg.from?.name || 'Unknown';
                contextContent += `**[${timestamp}] ${sender}:** ${msg.content}\n\n`;
              }

              contextContent += `---\n\n`;
              contextContent += `## How to Participate\n\n`;
              contextContent += `1. To send a message to the channel:\n`;
              contextContent += `\`\`\`bash\ncurl -X POST http://localhost:3000/api/collab \\\n`;
              contextContent += `  -H "Content-Type: application/json" \\\n`;
              contextContent += `  -d '{"action":"message","channelId":"${channelId}","participantId":"YOUR_ID","content":"Your message"}'\n\`\`\`\n\n`;
              contextContent += `2. To poll for new messages:\n`;
              contextContent += `\`\`\`bash\ncurl "http://localhost:3000/api/collab?channelId=${channelId}&since=ISO_TIMESTAMP"\n\`\`\`\n\n`;
            }
          } catch (e) {
            console.error('Failed to read collab channel data:', e);
          }
        }

        contextContent += `## Your Task\n\n`;
        contextContent += `Introduce yourself to the channel and ask how you can help!\n`;

        // Write context file
        await fs.writeFile(path.join(collabDir, 'CLAUDE.md'), contextContent);

        // Open in Windows Terminal with Ubuntu profile, cd to collab dir
        const terminalCmd = `cmd.exe /c start wt.exe -p "Ubuntu" --title "Claude - ${safeName}" -- wsl.exe -e bash -ic "cd ${collabDir} && claude --dangerously-skip-permissions"`;

        await execAsync(terminalCmd);

        return NextResponse.json<SessionActionResponse>({
          success: true,
          message: `Spawned new Claude session for ${channelName} with chat context`
        });
      } catch (spawnError) {
        console.error('Failed to spawn Claude session:', spawnError);
        return NextResponse.json<SessionActionResponse>({
          success: false,
          error: 'Failed to spawn Claude session. Make sure Windows Terminal is installed.'
        }, { status: 500 });
      }
    }

    if (body.action === 'spawn_pty') {
      // Spawn a PTY-managed Claude agent for a collab channel
      const channelId = body.channelId;
      const channelName = body.channelName || 'Collaboration';
      const agentName = body.agentName;

      if (!channelId) {
        return NextResponse.json<SessionActionResponse>({
          success: false,
          error: 'channelId is required for spawn_pty'
        }, { status: 400 });
      }

      try {
        // Read channel data for context
        const channelsPath = DataPaths.collabChannels;
        const defaultChannels: CollabChannelsData = { channels: [], lastUpdated: new Date().toISOString() };
        const channelsData = await readJsonFile<CollabChannelsData>(channelsPath, defaultChannels);

        const channel = channelsData.channels.find(c => c.id === channelId);
        if (!channel) {
          return NextResponse.json<SessionActionResponse>({
            success: false,
            error: 'Channel not found'
          }, { status: 404 });
        }

        // Spawn PTY session - don't pass systemPrompt yet, we'll send it after we have participant.id
        const { session, participant, emitter } = await spawnCollabPtySession({
          channelId,
          channelName,
          participantName: agentName,

          // Disable raw output streaming - agents post messages via curl instead
          onData: async () => {},
          onEnd: async () => {},
          onError: async (error: Error) => {
            console.error(`[spawn_pty] Session error:`, error);
          },
          onStatusChange: async (status) => {
          },
        });

        // Build system prompt with real participant ID for curl commands
        let systemPrompt = `You are "${participant.name}", a collaborative AI agent in the "${channelName}" channel.

CRITICAL: To send messages that others can see, write JSON to a temp file and curl it:

Step 1 - Write your message to a file:
\`\`\`bash
echo '{"action":"message","channelId":"${channelId}","participantId":"${participant.id}","content":"YOUR MESSAGE HERE"}' > /tmp/msg.json
\`\`\`

Step 2 - Send it:
\`\`\`bash
curl -s -X POST http://localhost:3000/api/collab -H "Content-Type: application/json" -d @/tmp/msg.json
\`\`\`

Replace YOUR MESSAGE HERE with your actual response text.

When you see messages like "[Someone]: Hello", respond using the two-step approach above.
`;

        // Add recent message history for context from per-channel file
        const ptyMsgData = await readChannelMessages(channelId);
        if (ptyMsgData.messages.length > 0) {
          systemPrompt += `\n## Recent Conversation\n\n`;
          const recentMessages = ptyMsgData.messages.slice(-10);
          for (const msg of recentMessages) {
            const sender = msg.from?.name || 'Unknown';
            const content = msg.content || '';
            systemPrompt += `**${sender}:** ${content}\n\n`;
          }
        }

        systemPrompt += `\nIntroduce yourself now by running the curl command above.\n`;

        // Send system prompt to PTY session after a delay for Claude to be ready
        setTimeout(() => {
          sendToPty(session.id, systemPrompt);
        }, 3000);

        // Add participant to channel (locked) and append join message to per-channel file
        const joinMessage: CollabMessage = {
          id: randomUUID(),
          channelId,
          from: {
            id: 'system',
            type: 'user',
            name: 'System',
            source: 'DevFlow',
            joinedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
          },
          content: `${participant.name} (PTY Agent) joined the channel`,
          timestamp: new Date().toISOString(),
        };

        await mutateChannels('claude-sessions:spawn-pty-add-participant', async freshData => {
          const freshChannel = freshData.channels.find(c => c.id === channelId);
          if (freshChannel) {
            freshChannel.participants.push(participant);
            freshChannel.lastActivity = new Date().toISOString();
            await saveChannels(freshData);
          }
        });

        // Append join message to per-channel message file (separate lock)
        await appendChannelMessage(channelId, joinMessage);

        return NextResponse.json<SessionActionResponse>({
          success: true,
          message: `Spawned PTY agent "${participant.name}" for ${channelName}`,
          ptySession: session,
          participant,
        });
      } catch (spawnError) {
        console.error('Failed to spawn PTY agent:', spawnError);
        return NextResponse.json<SessionActionResponse>({
          success: false,
          error: spawnError instanceof Error ? spawnError.message : 'Failed to spawn PTY agent'
        }, { status: 500 });
      }
    }

    // Invite an existing terminal session to a collab channel
    if (body.action === 'invite_to_channel') {
      const { pid, channelId, channelName, displayName } = body;

      if (!pid || !channelId) {
        return NextResponse.json<SessionActionResponse>({
          success: false,
          error: 'pid and channelId are required'
        }, { status: 400 });
      }

      try {
        // Check if this is a collab-ready session (WSL or PS)
        const wslReadyFile = `/tmp/collab-ready-${pid}.json`;
        const psReadyFile = `${PS_BRIDGE_PATH}/ready-${pid}.json`;
        let isPsAgent = false;

        try {
          await fs.access(wslReadyFile);
        } catch {
          // Not a WSL agent, check PS bridge
          try {
            await fs.access(psReadyFile);
            isPsAgent = true;
          } catch {
            return NextResponse.json<SessionActionResponse>({
              success: false,
              error: 'Session is not collab-ready. It may not be running with a collab wrapper.'
            }, { status: 400 });
          }
        }

        // Write the invite file to the appropriate location
        // Include displayName so wrapper joins with correct name
        const inviteFile = isPsAgent
          ? `${PS_BRIDGE_PATH}/invite-${pid}.json`
          : `/tmp/collab-invite-${pid}.json`;

        await fs.writeFile(inviteFile, JSON.stringify({
          channelId,
          channelName: channelName || 'Unnamed Channel',
          displayName: displayName || null,  // Pass name to wrapper
          force: true,  // User-initiated invite overrides blocked status
          invitedAt: new Date().toISOString()
        }));

        // Pre-clear any blocks for this agent so even old wrappers (without force flag) can join
        try {
          await mutateChannels('claude-sessions:invite-unblock', async channelsData => {
            const channel = channelsData.channels?.find(c => c.id === channelId);
            if (channel?.blockedParticipantIds?.length) {
              const before = channel.blockedParticipantIds.length;
              // Read the ready file to get the agent's name for stable ID matching
              const readyFile = isPsAgent ? `${PS_BRIDGE_PATH}/ready-${pid}.json` : `/tmp/collab-ready-${pid}.json`;
              let agentName = displayName || '';
              try {
                const readyRaw = await fs.readFile(readyFile, 'utf-8');
                const readyData = JSON.parse(readyRaw);
                agentName = readyData.name || agentName;
              } catch { /* skip */ }

              // Remove any blocked IDs that match this agent's possible identifiers
              // We can't know the exact participant ID that will be used, so also check session files
              const sessionFile = `/tmp/collab-session-${pid}.json`;
              let sessionParticipantId: string | null = null;
              try {
                const sessRaw = await fs.readFile(sessionFile, 'utf-8');
                const sessData = JSON.parse(sessRaw);
                sessionParticipantId = sessData.participantId || null;
              } catch { /* skip */ }

              channel.blockedParticipantIds = channel.blockedParticipantIds.filter(id => {
                if (sessionParticipantId && id === sessionParticipantId) return false;
                return true;
              });

              if (channel.blockedParticipantIds.length < before) {
                await saveChannels(channelsData);
              }
            }
          });
        } catch (unblockErr) {
        }

        const agentType = isPsAgent ? 'PS' : 'WSL';
        return NextResponse.json<SessionActionResponse>({
          success: true,
          message: `Invited ${agentType} session ${pid} to channel. It should join within a few seconds.`
        });
      } catch (inviteError) {
        console.error('Failed to invite session:', inviteError);
        return NextResponse.json<SessionActionResponse>({
          success: false,
          error: inviteError instanceof Error ? inviteError.message : 'Failed to invite session'
        }, { status: 500 });
      }
    }

    return NextResponse.json<SessionActionResponse>({
      success: false,
      error: `Unknown action: ${body.action}`
    }, { status: 400 });
  } catch (error) {
    console.error('Error executing session action:', error);
    return NextResponse.json<SessionActionResponse>({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to execute action'
    }, { status: 500 });
  }
});
