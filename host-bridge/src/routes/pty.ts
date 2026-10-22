import { Router } from 'express';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, statSync, mkdirSync } from 'fs';
import { join, isAbsolute } from 'path';
import type {
  BridgeConfig,
  BridgeResponse,
  PtySpawnRequest,
  PtySpawnResponse,
  PtyWriteRequest,
  PtyWriteResponse,
  PtyReadResponse,
  PtyCloseResponse,
  PtySessionInfo,
  PtyListResponse,
} from '../../../lib/host-bridge/types';

const execAsync = promisify(exec);

interface ActiveSession {
  sessionId: string;
  tmuxSession: string;
  pid: number;
  workingDirectory: string;
  createdAt: string;
  pipeLog: string;
}

const sessions = new Map<string, ActiveSession>();

const PIPE_LOG_DIR = '/tmp/DevFlow/host-bridge-pty';

export function ptyRouter(config: BridgeConfig): Router {
  const router = Router();

  // Ensure pipe log dir exists
  mkdirSync(PIPE_LOG_DIR, { recursive: true });

  // POST /pty/spawn — create a new PTY session
  router.post('/spawn', async (req, res) => {
    if (sessions.size >= config.maxPtySessions) {
      res.status(429).json({
        success: false,
        error: `Max PTY sessions reached (${config.maxPtySessions})`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { workingDirectory, command, args, env, historyLimit } = req.body as PtySpawnRequest;

    if (!workingDirectory || !isAbsolute(workingDirectory)) {
      res.status(400).json({
        success: false,
        error: 'workingDirectory must be an absolute path',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!existsSync(workingDirectory)) {
      res.status(400).json({
        success: false,
        error: `Directory does not exist: ${workingDirectory}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const sessionId = randomUUID();
    const tmuxName = `hb-${sessionId.slice(0, 8)}`;
    const pipeLog = join(PIPE_LOG_DIR, `${sessionId}.log`);
    const limit = historyLimit || 50_000;

    // Build the command
    let fullCommand = command || 'bash';
    if (args && args.length > 0) {
      fullCommand += ' ' + args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    }

    // Build env string
    let envPrefix = '';
    if (env) {
      envPrefix = Object.entries(env)
        .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
        .join(' ') + ' ';
    }

    const tmuxCmd = [
      `tmux new-session -d -s ${tmuxName} -c '${workingDirectory}'`,
      `'${envPrefix}${fullCommand}'`,
      `\\; set-option -t ${tmuxName} history-limit ${limit}`,
      `\\; pipe-pane -t ${tmuxName} -o 'cat >> ${pipeLog}'`,
    ].join(' ');

    try {
      await execAsync(tmuxCmd, { timeout: 10_000 });

      // Get the PID of the tmux session's shell
      let pid = 0;
      try {
        const { stdout } = await execAsync(
          `tmux list-panes -t ${tmuxName} -F '#{pane_pid}'`,
          { timeout: 5_000 }
        );
        pid = parseInt(stdout.trim()) || 0;
      } catch {
        // PID lookup is best-effort
      }

      const session: ActiveSession = {
        sessionId,
        tmuxSession: tmuxName,
        pid,
        workingDirectory,
        createdAt: new Date().toISOString(),
        pipeLog,
      };
      sessions.set(sessionId, session);

      const response: BridgeResponse<PtySpawnResponse> = {
        success: true,
        data: { sessionId, pid, tmuxSession: tmuxName },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({
        success: false,
        error: `Failed to spawn PTY: ${msg}`,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // POST /pty/:id/write — send input to a PTY session
  router.post('/:id/write', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({
        success: false,
        error: 'Session not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!isSessionAlive(session.tmuxSession)) {
      sessions.delete(req.params.id);
      res.status(410).json({
        success: false,
        error: 'Session is dead',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { input, raw } = req.body as PtyWriteRequest;

    if (typeof input !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing required field: input',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      // Escape special chars for tmux send-keys -l
      const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
      execSync(`tmux send-keys -t ${session.tmuxSession} -l "${escaped}"`, { timeout: 5_000 });

      if (!raw) {
        execSync(`tmux send-keys -t ${session.tmuxSession} Enter`, { timeout: 5_000 });
      }

      const response: BridgeResponse<PtyWriteResponse> = {
        success: true,
        data: { sessionId: req.params.id, sent: true },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({
        success: false,
        error: `Failed to write: ${msg}`,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // GET /pty/:id/read — read output from PTY pipe log
  router.get('/:id/read', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({
        success: false,
        error: 'Session not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const since = parseInt(req.query.since as string) || 0;
    const alive = isSessionAlive(session.tmuxSession);
    let output = '';
    let offset = since;

    try {
      if (existsSync(session.pipeLog)) {
        const stat = statSync(session.pipeLog);
        if (stat.size > since) {
          const fd = require('fs').openSync(session.pipeLog, 'r');
          const buf = Buffer.alloc(stat.size - since);
          require('fs').readSync(fd, buf, 0, buf.length, since);
          require('fs').closeSync(fd);
          output = buf.toString('utf-8');
          offset = stat.size;
        }
      }
    } catch {
      // Pipe log may not exist yet
    }

    if (!alive) {
      sessions.delete(req.params.id);
    }

    const response: BridgeResponse<PtyReadResponse> = {
      success: true,
      data: { sessionId: req.params.id, output, offset, alive },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  });

  // POST /pty/:id/close — close a PTY session
  router.post('/:id/close', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({
        success: false,
        error: 'Session not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      await execAsync(`tmux kill-session -t ${session.tmuxSession} 2>/dev/null`, { timeout: 5_000 });
    } catch {
      // Session may already be dead
    }

    sessions.delete(req.params.id);

    const response: BridgeResponse<PtyCloseResponse> = {
      success: true,
      data: { sessionId: req.params.id, closed: true },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  });

  // GET /pty/list — list active sessions
  router.get('/list', (_req, res) => {
    // Clean dead sessions
    for (const [id, session] of sessions) {
      if (!isSessionAlive(session.tmuxSession)) {
        sessions.delete(id);
      }
    }

    const list: PtySessionInfo[] = Array.from(sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      tmuxSession: s.tmuxSession,
      pid: s.pid,
      workingDirectory: s.workingDirectory,
      createdAt: s.createdAt,
      alive: isSessionAlive(s.tmuxSession),
    }));

    const response: BridgeResponse<PtyListResponse> = {
      success: true,
      data: { sessions: list },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  });

  return router;
}

function isSessionAlive(tmuxName: string): boolean {
  try {
    execSync(`tmux has-session -t ${tmuxName} 2>/dev/null`, { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}
