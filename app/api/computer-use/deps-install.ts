/**
 * deps.install status tracking helpers (audit task 85fa35d9).
 *
 * Pulled out of route.ts because Next.js route files only allow handler
 * exports (POST, GET, dynamic, …). The handlers in route.ts import these.
 *
 * The PowerShell wrapper writes a JSON status sidecar before/after pip and
 * a log file alongside it. loadDepsInstallStatus reads both back so agents
 * can observe completion or pip failures instead of trusting the
 * fire-and-forget success:true.
 *
 * Files live on the Windows side (C:\Temp\) because pip runs in Windows;
 * from WSL we read them via /mnt/c/Temp/. Filenames are namespaced by
 * depsInstallId.
 */

import { promises as fsPromises } from 'fs';

export const DEPS_INSTALL_DIR_WIN = 'C:\\Temp';
export const DEPS_INSTALL_DIR_WSL = '/mnt/c/Temp';
export const DEPS_INSTALL_LOG_TAIL_LINES = 80;

export type DepsInstallStatusValue = 'running' | 'completed' | 'failed';

export interface DepsInstallStatus {
  id: string;
  status: DepsInstallStatusValue;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  logTail?: string;
}

export function parseDepsInstallStatus(content: string): DepsInstallStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const id = obj.id;
  const status = obj.status;
  const startedAt = obj.startedAt;
  if (typeof id !== 'string' || typeof startedAt !== 'string') return null;
  if (status !== 'running' && status !== 'completed' && status !== 'failed') return null;
  const result: DepsInstallStatus = { id, status, startedAt };
  if (typeof obj.endedAt === 'string') result.endedAt = obj.endedAt;
  if (typeof obj.exitCode === 'number') result.exitCode = obj.exitCode;
  return result;
}

export function tailLog(content: string, maxLines: number): string {
  if (!content) return '';
  const lines = content.replace(/\n+$/, '').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(-maxLines).join('\n');
}

interface LoadDepsInstallStatusDeps {
  readFile?: (path: string) => Promise<string>;
  dirOverride?: string;
}

export async function loadDepsInstallStatus(
  id: string,
  deps: LoadDepsInstallStatusDeps = {},
): Promise<DepsInstallStatus | null> {
  const readFile = deps.readFile ?? ((p: string) => fsPromises.readFile(p, 'utf-8'));
  const dir = deps.dirOverride ?? DEPS_INSTALL_DIR_WSL;
  const statusPath = `${dir}/devflow-deps-install-${id}.json`;
  const logPath = `${dir}/devflow-deps-install-${id}.log`;

  let statusContent: string;
  try {
    statusContent = await readFile(statusPath);
  } catch {
    return null;
  }
  const parsed = parseDepsInstallStatus(statusContent);
  if (!parsed) return null;

  try {
    const logContent = await readFile(logPath);
    parsed.logTail = tailLog(logContent, DEPS_INSTALL_LOG_TAIL_LINES);
  } catch {
    // Log not yet written or unreadable — leave undefined.
  }
  return parsed;
}
