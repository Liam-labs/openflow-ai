import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

const execAsync = promisify(exec);

const MAX_LINES = 500;
const DEFAULT_LINES = 100;
const PM2_LIST_TIMEOUT_MS = 10000;
const TAIL_EXEC_TIMEOUT_MS = 10000;

type LogType = 'out' | 'err' | 'both';

interface PM2LogEntry {
  timestamp: string | null;
  message: string;
  type: 'out' | 'err';
}

interface PM2LogsApiResponse {
  name: string;
  lines: PM2LogEntry[];
  count: number;
  logPaths: { out: string | null; err: string | null };
}

async function getLogPaths(name: string): Promise<{ out: string | null; err: string | null }> {
  const { stdout } = await execAsync('pm2 jlist', { timeout: PM2_LIST_TIMEOUT_MS });
  let procs: Record<string, unknown>[];
  try {
    procs = JSON.parse(stdout);
  } catch {
    return { out: null, err: null };
  }
  const proc = procs.find(p => p.name === name);
  if (!proc) return { out: null, err: null };

  const env = (proc.pm2_env || {}) as Record<string, unknown>;
  return {
    out: (env.pm_out_log_path as string) || null,
    err: (env.pm_err_log_path as string) || null,
  };
}

async function tailFile(filePath: string, lines: number, type: 'out' | 'err'): Promise<PM2LogEntry[]> {
  try {
    // Use tail to read last N lines — handles large files efficiently
    const { stdout } = await execAsync(`tail -n ${lines} ${JSON.stringify(filePath)}`, { timeout: TAIL_EXEC_TIMEOUT_MS });
    return stdout
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => {
        // PM2 JSON logs: {"message":"...","timestamp":"...","type":"out",...}
        // Try to parse structured log lines
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          return {
            timestamp: (parsed.timestamp as string) || null,
            message: (parsed.message as string) || line,
            type,
          };
        } catch {
          return { timestamp: null, message: line, type };
        }
      });
  } catch {
    // File may not exist yet (new process, no logs written)
    return [];
  }
}

// GET /api/pm2/logs?name=devflow&lines=100&type=both
export const GET = tracked('/api/pm2/logs', async (request: NextRequest) => {
  try {
    const authDenied = await requireAuthOrLocal(request, 'read');
    if (authDenied) return authDenied;

    const { searchParams } = new URL(request.url);
    const name = searchParams.get('name');
    const linesParam = parseInt(searchParams.get('lines') || String(DEFAULT_LINES), 10);
    const typeParam = (searchParams.get('type') || 'both') as LogType;

    if (!name || name.trim().length === 0) {
      return NextResponse.json({ error: 'Missing required param: name' }, { status: 400 });
    }

    if (!['out', 'err', 'both'].includes(typeParam)) {
      return NextResponse.json({ error: 'Invalid type: must be out, err, or both' }, { status: 400 });
    }

    const lines = Math.min(Math.max(1, isNaN(linesParam) ? DEFAULT_LINES : linesParam), MAX_LINES);

    const logPaths = await getLogPaths(name);

    if (!logPaths.out && !logPaths.err) {
      return NextResponse.json({ error: `Process not found: ${name}` }, { status: 404 });
    }

    // Fetch the requested log stream(s) in parallel
    const [outEntries, errEntries] = await Promise.all([
      typeParam !== 'err' && logPaths.out ? tailFile(logPaths.out, lines, 'out') : Promise.resolve([]),
      typeParam !== 'out' && logPaths.err ? tailFile(logPaths.err, lines, 'err') : Promise.resolve([]),
    ]);

    // Merge and return — keep original file order, no sorting needed
    const allEntries =
      typeParam === 'out' ? outEntries :
      typeParam === 'err' ? errEntries :
      [...outEntries, ...errEntries].slice(-lines);

    const response: PM2LogsApiResponse = {
      name,
      lines: allEntries,
      count: allEntries.length,
      logPaths,
    };

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
