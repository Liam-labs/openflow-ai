import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  BridgeConfig,
  BridgeResponse,
  PM2StatusResponse,
  PM2ProcessInfo,
  PM2ExecRequest,
  PM2ExecResponse,
  PM2LogsResponse,
} from '../../../lib/host-bridge/types';

const execAsync = promisify(exec);

export function pm2Router(config: BridgeConfig): Router {
  const router = Router();

  // GET /pm2/status — list all PM2 processes
  router.get('/status', async (_req, res) => {
    try {
      const { stdout } = await execAsync('pm2 jlist', { timeout: 10_000 });
      const raw = JSON.parse(stdout);
      const processes: PM2ProcessInfo[] = raw.map((p: Record<string, unknown>) => {
        const env = (p.pm2_env || {}) as Record<string, unknown>;
        const monit = (p.monit || {}) as Record<string, number>;
        const mem = monit.memory || 0;
        const uptime = env.pm_uptime ? Date.now() - (env.pm_uptime as number) : 0;

        return {
          name: p.name as string,
          pm_id: p.pm_id as number,
          pid: p.pid as number,
          status: (env.status as string) || 'stopped',
          cpu: monit.cpu || 0,
          memory: mem,
          memoryFormatted: formatBytes(mem),
          uptime,
          uptimeFormatted: formatUptime(uptime),
          restarts: (env.restart_time as number) || 0,
          port: (env.PORT as number) || null,
          cwd: (env.pm_cwd as string) || '',
          execMode: (env.exec_mode as string) || 'fork',
        };
      });

      // Build ports map
      const portsInUse: Record<number, string> = {};
      for (const proc of processes) {
        if (proc.port && proc.status === 'online') {
          portsInUse[proc.port] = proc.name;
        }
      }

      const response: BridgeResponse<PM2StatusResponse> = {
        success: true,
        data: { processes, portsInUse },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // PM2 daemon might not be running
      if (msg.includes('PM2') || msg.includes('ENOENT')) {
        const response: BridgeResponse<PM2StatusResponse> = {
          success: true,
          data: { processes: [], portsInUse: {} },
          timestamp: new Date().toISOString(),
        };
        res.json(response);
        return;
      }
      res.status(500).json({
        success: false,
        error: msg,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // POST /pm2/exec — execute a PM2 action
  router.post('/exec', async (req, res) => {
    const { action, target, port } = req.body as PM2ExecRequest;

    if (!action || !target) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: action, target',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate action
    const allowedActions = ['start', 'stop', 'restart'];
    if (!allowedActions.includes(action)) {
      res.status(403).json({
        success: false,
        error: `Action '${action}' is not allowed. Permitted: ${allowedActions.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate target name — alphanumeric, hyphens, underscores only
    if (!/^[\w-]+$/.test(target)) {
      res.status(400).json({
        success: false,
        error: 'Invalid target name. Use alphanumeric, hyphens, underscores only.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Build command and validate against allowlist
    const command = `pm2 ${action} ${target}`;
    if (!isAllowedPm2Command(command, config.pm2Allowlist)) {
      res.status(403).json({
        success: false,
        error: `Command not in allowlist: ${command}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Port conflict check for start/restart
    if (port && (action === 'start' || action === 'restart')) {
      try {
        const { stdout } = await execAsync('pm2 jlist', { timeout: 10_000 });
        const procs = JSON.parse(stdout);
        for (const p of procs) {
          const env = (p.pm2_env || {}) as Record<string, unknown>;
          if (
            (env.PORT as number) === port &&
            (p.name as string) !== target &&
            (env.status as string) === 'online'
          ) {
            const data: PM2ExecResponse = {
              action,
              target,
              portConflict: { port, ownedBy: p.name as string },
            };
            res.status(409).json({
              success: false,
              data,
              error: `Port ${port} already in use by ${p.name}`,
              timestamp: new Date().toISOString(),
            });
            return;
          }
        }
      } catch {
        // Proceed anyway if we can't check ports
      }
    }

    try {
      const { stdout, stderr } = await execAsync(command, { timeout: 30_000 });
      const response: BridgeResponse<PM2ExecResponse> = {
        success: true,
        data: { action, target, output: stdout || stderr },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({
        success: false,
        error: msg,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // GET /pm2/logs — fetch recent log lines
  router.get('/logs', async (req, res) => {
    const name = req.query.name as string;
    const lines = Math.min(parseInt(req.query.lines as string) || 50, 500);

    if (!name) {
      res.status(400).json({
        success: false,
        error: 'Missing required query param: name',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!/^[\w-]+$/.test(name)) {
      res.status(400).json({
        success: false,
        error: 'Invalid process name',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const command = `pm2 logs ${name} --nostream --lines ${lines}`;
    if (!isAllowedPm2Command(command, config.pm2Allowlist)) {
      res.status(403).json({
        success: false,
        error: `Command not in allowlist`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const { stdout, stderr } = await execAsync(command, { timeout: 15_000 });
      const output = (stdout + stderr).split('\n').filter(Boolean);
      const response: BridgeResponse<PM2LogsResponse> = {
        success: true,
        data: { name, lines: output, count: output.length },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({
        success: false,
        error: msg,
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}

function isAllowedPm2Command(command: string, allowlist: string[]): boolean {
  return allowlist.some((pattern) => new RegExp(pattern).test(command));
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatUptime(ms: number): string {
  if (ms <= 0) return '0s';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
