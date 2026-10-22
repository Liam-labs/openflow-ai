import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join, basename, normalize } from 'path';
import { DEVFLOW_HOME } from '../config';
import type {
  BridgeConfig,
  BridgeResponse,
  ScriptRunRequest,
  ScriptRunResponse,
  ScriptAllowlistResponse,
} from '../../../lib/host-bridge/types';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = join(DEVFLOW_HOME, 'scripts');

export function scriptRouter(config: BridgeConfig): Router {
  const router = Router();

  // POST /script/run — execute an allowlisted script
  router.post('/run', async (req, res) => {
    const { script, args, cwd, timeout } = req.body as ScriptRunRequest;

    if (!script) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: script',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Security: prevent path traversal
    const safeName = basename(normalize(script));
    if (safeName !== script || script.includes('..') || script.includes('/')) {
      res.status(403).json({
        success: false,
        error: 'Path traversal not allowed. Use filename only.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate script name chars
    if (!/^[\w.-]+$/.test(script)) {
      res.status(400).json({
        success: false,
        error: 'Invalid script name. Use alphanumeric, hyphens, underscores, dots only.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check allowlist
    const allowed = config.scriptAllowlist.find((s) => s.name === script);
    if (!allowed) {
      res.status(403).json({
        success: false,
        error: `Script not in allowlist: ${script}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check script exists
    const scriptPath = join(SCRIPTS_DIR, script);
    if (!existsSync(scriptPath)) {
      res.status(400).json({
        success: false,
        error: `Script not found: ${script}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Determine timeout
    const DEFAULT_TIMEOUT = 60_000;
    const MAX_TIMEOUT = 600_000;
    const maxForScript = allowed.maxTimeout || MAX_TIMEOUT;
    const execTimeout = Math.min(timeout || DEFAULT_TIMEOUT, maxForScript);

    // Determine interpreter based on extension
    const ext = script.split('.').pop();
    let interpreter: string;
    switch (ext) {
      case 'py':
        interpreter = 'python3';
        break;
      case 'sh':
        interpreter = '/bin/bash';
        break;
      case 'js':
      case 'mjs':
        interpreter = 'node';
        break;
      default:
        interpreter = '/bin/bash';
    }

    const execArgs = [scriptPath, ...(args || [])];
    const execCwd = cwd || DEVFLOW_HOME;
    const start = Date.now();

    try {
      const { stdout, stderr } = await execFileAsync(interpreter, execArgs, {
        cwd: execCwd,
        timeout: execTimeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: { ...process.env, DEVFLOW_HOME },
      });

      const response: BridgeResponse<ScriptRunResponse> = {
        success: true,
        data: {
          script,
          exitCode: 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          durationMs: Date.now() - start,
        },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (e) {
      const err = e as { code?: string; killed?: boolean; stdout?: string; stderr?: string; status?: number };

      if (err.killed || err.code === 'ERR_CHILD_PROCESS_TIMEOUT') {
        res.status(408).json({
          success: false,
          error: `Script timed out after ${execTimeout}ms`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const response: BridgeResponse<ScriptRunResponse> = {
        success: false,
        data: {
          script,
          exitCode: err.status || 1,
          stdout: err.stdout?.toString() || '',
          stderr: err.stderr?.toString() || '',
          durationMs: Date.now() - start,
        },
        error: err.stderr?.toString() || (e instanceof Error ? e.message : String(e)),
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    }
  });

  // GET /script/allowlist — return the current allowlist
  router.get('/allowlist', (_req, res) => {
    const response: BridgeResponse<ScriptAllowlistResponse> = {
      success: true,
      data: { scripts: config.scriptAllowlist },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  });

  return router;
}
