/**
 * Claude Sessions Actions
 *
 * Actions for managing Claude terminal sessions.
 */

import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import type {
  AgentApiRequest,
  AgentAuthContext,
  ClaudeSession,
  SessionsData,
  SessionStatus,
} from '@/lib/types';

const SESSIONS_PATH = DataPaths.sessions;

const DEFAULT_SESSIONS_DATA: SessionsData = {
  sessions: [],
  config: {
    pollInterval: 5000,
    staleThreshold: 30,
    autoDiscovery: true,
  },
  lastUpdated: new Date().toISOString(),
};

async function loadSessionsData(): Promise<SessionsData> {
  return readJsonFile<SessionsData>(SESSIONS_PATH, DEFAULT_SESSIONS_DATA);
}

async function saveSessionsData(data: SessionsData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await writeJsonFile(SESSIONS_PATH, data);
}

/**
 * sessions.list - List active Claude sessions
 */
export async function list(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ sessions: ClaudeSession[]; count: number }> {
  const data = await loadSessionsData();

  let sessions = data.sessions;

  // Filter by status if specified
  if (body.status && typeof body.status === 'string') {
    sessions = sessions.filter(s => s.status === body.status);
  }

  // Filter by project path if specified
  if (body.projectPath && typeof body.projectPath === 'string') {
    sessions = sessions.filter(s => s.projectPath === body.projectPath);
  }

  return {
    sessions,
    count: sessions.length,
  };
}

/**
 * sessions.get - Get details of a specific session
 */
export async function get(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ session: ClaudeSession | null; found: boolean }> {
  const sessionId = body.sessionId;
  const pid = body.pid;

  if (!sessionId && !pid) {
    throw new Error('sessionId or pid is required');
  }

  const data = await loadSessionsData();

  let session: ClaudeSession | undefined;

  if (sessionId) {
    session = data.sessions.find(s => s.sessionId === sessionId);
  } else if (pid) {
    session = data.sessions.find(s => s.pid === pid);
  }

  return {
    session: session || null,
    found: !!session,
  };
}

/**
 * sessions.register - Register this agent as a session
 */
export async function register(
  body: AgentApiRequest,
  auth: AgentAuthContext
): Promise<{ sessionId: string; registered: boolean }> {
  const projectPath = body.projectPath;
  const pid = body.pid;
  const capabilities = body.capabilities;
  const displayName = body.displayName;

  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('projectPath is required');
  }

  return withFileLock(SESSIONS_PATH, async () => {
    const data = await loadSessionsData();

    // Generate session ID
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Extract project name from path
    const projectName = projectPath.split('/').pop() || projectPath;

    // Validate PID is a positive integer
    const validPid = typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : 0;

    const newSession: ClaudeSession = {
      sessionId,
      pid: validPid,
      projectPath,
      projectName,
      displayName: typeof displayName === 'string' ? displayName : auth.tokenName,
      status: 'active',
      registeredAt: now,
      lastHeartbeat: now,
      lastActivity: now,
      capabilities: Array.isArray(capabilities) ? capabilities : [],
      currentTask: undefined,
    };

    // Cap: prune stale sessions before adding new one
    const MAX_SESSIONS = 200;
    const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
    const now_ms = Date.now();
    data.sessions = data.sessions.filter(s => {
      const age = now_ms - new Date(s.lastHeartbeat).getTime();
      return age < STALE_THRESHOLD_MS;
    });
    if (data.sessions.length >= MAX_SESSIONS) {
      // Remove oldest by lastHeartbeat
      data.sessions.sort((a, b) => new Date(b.lastHeartbeat).getTime() - new Date(a.lastHeartbeat).getTime());
      data.sessions = data.sessions.slice(0, MAX_SESSIONS - 1);
    }

    data.sessions.push(newSession);
    await saveSessionsData(data);

    return { sessionId, registered: true };
  });
}

/**
 * sessions.heartbeat - Update session status/heartbeat
 */
export async function heartbeat(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ updated: boolean }> {
  const sessionId = body.sessionId;
  const status = body.status as SessionStatus | undefined;
  const currentTask = body.currentTask;

  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }

  return withFileLock(SESSIONS_PATH, async () => {
    const data = await loadSessionsData();
    const session = data.sessions.find(s => s.sessionId === sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.lastHeartbeat = new Date().toISOString();

    if (status && ['active', 'idle', 'busy', 'offline'].includes(status)) {
      session.status = status;
    }

    if (currentTask !== undefined) {
      session.currentTask = typeof currentTask === 'string' ? currentTask : undefined;
    }

    if (body.currentTaskId !== undefined) {
      session.currentTaskId = typeof body.currentTaskId === 'string' ? body.currentTaskId : undefined;
    }

    await saveSessionsData(data);

    return { updated: true };
  });
}

/**
 * sessions.end - Unregister/terminate a session
 */
export async function end(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ removed: boolean }> {
  const sessionId = body.sessionId;
  const pid = body.pid;

  if (!sessionId && !pid) {
    throw new Error('sessionId or pid is required');
  }

  return withFileLock(SESSIONS_PATH, async () => {
    const data = await loadSessionsData();
    const before = data.sessions.length;

    if (sessionId && typeof sessionId === 'string') {
      data.sessions = data.sessions.filter(s => s.sessionId !== sessionId);
    } else if (typeof pid === 'number') {
      data.sessions = data.sessions.filter(s => s.pid !== pid);
    }

    const removed = data.sessions.length < before;
    if (removed) {
      await saveSessionsData(data);
    }

    return { removed };
  });
}

/**
 * sessions.spawn - Spawn a new terminal agent
 * Note: This is a placeholder - actual spawning requires terminal integration
 */
export async function spawn(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ message: string; channelId?: string }> {
  const channelId = body.channelId;

  return {
    message: 'Terminal agent spawning requires collab-claude wrapper integration',
    channelId: typeof channelId === 'string' ? channelId : undefined,
  };
}

/**
 * sessions.spawn_pty - Spawn a PTY-managed agent
 * Note: This is a placeholder - actual PTY spawning handled by existing API
 */
export async function spawnPty(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ message: string; channelId?: string; agentName?: string }> {
  const channelId = body.channelId;
  const agentName = body.agentName;

  return {
    message: 'PTY agent spawning requires browser-side integration. Use POST /api/claude/sessions with action: spawn_pty',
    channelId: typeof channelId === 'string' ? channelId : undefined,
    agentName: typeof agentName === 'string' ? agentName : undefined,
  };
}
