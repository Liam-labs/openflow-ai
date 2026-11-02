import { Router } from 'express';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, statSync, mkdirSync, chmodSync } from 'fs';
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
import { buildSessionCommand, historyLimit, newSessionArgs, pipePaneArgs, sendTextArgs } from '../tmux-args';

const execFileAsync = promisify(execFile);

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
  // Private: these logs hold everything a session printed.
  mkdirSync(PIPE_LOG_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(PIPE_LOG_DIR, 0o700); } catch { /* a folder owned by someone else: the spawn will fail on its own */ }

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

    const { workingDirectory, command, args, env, historyLimit: requestedHistory } = req.body as PtySpawnRequest;

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
    const limit = historyLimit(requestedHistory);

    let sessionCommand: string;
    try {
      sessionCommand = buildSessionCommand(command, args, env);
    } catch (e) {
      res.status(400).json({ success: false, error: e instanceof Error ? e.message : String(e), timestamp: new Date().toISOString() });
      return;
    }

    try {
      await execFileAsync('tmux', newSessionArgs(tmuxName, workingDirectory, sessionCommand), { timeout: 10_000 });
      await execFileAsync('tmux', ['set-option', '-t', tmuxName, 'history-limit', String(limit)], { timeout: 5_000 });
      await execFileAsync('tmux', pipePaneArgs(tmuxName, pipeLog), { timeout: 5_000 });

      // Get the PID of the tmux session's shell
      let pid = 0;
      try {
        const { stdout } = await execFileAsync('tmux', ['list-panes', '-t', tmuxName, '-F', '#{pane_pid}'], { timeout: 5_000 });
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
      execFileSync('tmux', sendTextArgs(session.tmuxSession, input), { timeout: 5_000 });

      if (!raw) {
        execFileSync('tmux', ['send-keys', '-t', session.tmuxSession, 'Enter'], { timeout: 5_000 });
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
      await execFileAsync('tmux', ['kill-session', '-t', session.tmuxSession], { timeout: 5_000 });
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
    execFileSync('tmux', ['has-session', '-t', tmuxName], { timeout: 2_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
