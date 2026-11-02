/**
 * Runs the `cloudflared` connector for the WebGate wizard, as a child of the app that outlives it and is started again at every app
 * start while the wizard's tunnel is switched on. The tunnel token goes to cloudflared through a private file (--token-file), never
 * through the command line, so it does not show up in a process list.
 */
import { execFile, spawn } from 'child_process';
import { existsSync, openSync, closeSync, promises as fs } from 'fs';
import path from 'path';
import { DataPaths } from '../data-paths';
import { isPidAlive, readProcCmdline } from '../proc-info';

export interface ConnectorRunner {
  installed(): Promise<{ path: string | null; version: string | null }>;
  running(): Promise<boolean>;
  start(): Promise<{ ok: true } | { ok: false; error: string }>;
  stop(): Promise<void>;
}

export function cloudflaredCandidates(home = process.env.HOME || ''): string[] {
  return [
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'cloudflared')),
    path.join(home, '.local/bin/cloudflared'), '/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/opt/homebrew/bin/cloudflared',
  ];
}

export function findCloudflared(exists: (p: string) => boolean = existsSync, candidates = cloudflaredCandidates()): string | null {
  return candidates.find((p) => exists(p)) ?? null;
}

async function readPid(file = DataPaths.cloudflaredPid): Promise<number | null> {
  try {
    const n = Number((await fs.readFile(file, 'utf8')).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export const realRunner: ConnectorRunner = {
  async installed() {
    const bin = findCloudflared();
    if (!bin) return { path: null, version: null };
    const version = await new Promise<string | null>((resolve) => execFile(bin, ['--version'], { timeout: 8000 }, (e, out) => resolve(e ? null : String(out).split('\n')[0].trim() || null)));
    return { path: bin, version };
  },

  async running() {
    const pid = await readPid();
    if (!pid || !(await isPidAlive(pid))) return false;
    return /cloudflared/.test(await readProcCmdline(pid));          // a recycled pid is not our connector
  },

  async start() {
    if (await this.running()) return { ok: true };
    const bin = findCloudflared();
    if (!bin) return { ok: false, error: 'cloudflared is not installed.' };
    if (!existsSync(DataPaths.cloudflaredToken)) return { ok: false, error: 'There is no tunnel token to start with.' };
    const out = openSync(DataPaths.cloudflaredLog, 'a', 0o600);
    try {
      const child = spawn(bin, ['tunnel', '--no-autoupdate', 'run', '--token-file', DataPaths.cloudflaredToken], { detached: true, stdio: ['ignore', out, out] });
      child.on('error', () => undefined);
      child.unref();
      if (!child.pid) return { ok: false, error: 'cloudflared did not start.' };
      await fs.writeFile(DataPaths.cloudflaredPid, String(child.pid), { mode: 0o600 });
      return { ok: true };
    } finally {
      closeSync(out);
    }
  },

  async stop() {
    const pid = await readPid();
    if (pid && (await isPidAlive(pid)) && /cloudflared/.test(await readProcCmdline(pid))) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      for (let i = 0; i < 20 && (await isPidAlive(pid)); i++) await new Promise((r) => setTimeout(r, 250));
    }
    await fs.rm(DataPaths.cloudflaredPid, { force: true });
  },
};
