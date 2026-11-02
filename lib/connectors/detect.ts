/**
 * Works out, for each catalog connector, whether it is already set up on this machine.
 * It looks only at the machine: program files on the PATH, key NAMES, MCP server NAMES, a local port.
 * It never reads or returns a key value, and the only program it runs is a connector's own fixed sign-in check.
 */
import { promises as fs, constants as fsConstants } from 'fs';
import { execFile } from 'child_process';
import net from 'net';
import path from 'path';
import { getHomeDir } from '@/lib/home-dir';
import type { Connector } from '@/lib/connectors/catalog';
import { jevConnection } from '@/lib/skill-router-jev';

export type ConnectorState = 'unknown' | 'not-set-up' | 'installed' | 'ready' | 'running';

export interface ConnectorStatus {
  id: string;
  state: ConnectorState;
  /** Plain-English facts behind the state, for example "gh found" or "key saved". */
  notes: string[];
  /** Where a key was found: saved through this page, or already in the environment. */
  keyFrom?: 'saved' | 'environment';
}

export interface Facts {
  binaries: (name: string) => Promise<boolean>;
  envNames: ReadonlySet<string>;
  savedNames: ReadonlySet<string>;
  mcpNames: ReadonlySet<string>;
  port: (port: number) => Promise<boolean>;
  authCheck: (argv: string[]) => Promise<boolean>;
  /** Connectors that are connected through the DevFlow gateway instead of a key on this machine (TypeSafe Jev). */
  viaGateway?: (id: string) => Promise<boolean>;
}

export function extraBinDirs(home: string = getHomeDir()): string[] {
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/snap/bin',
  ];
}

async function nvmBinDirs(home: string): Promise<string[]> {
  try {
    const root = path.join(home, '.nvm', 'versions', 'node');
    const versions = (await fs.readdir(root)).sort().reverse();
    return versions.map((v) => path.join(root, v, 'bin'));
  } catch {
    return [];
  }
}

export async function searchDirs(home: string = getHomeDir(), pathEnv: string = process.env.PATH ?? ''): Promise<string[]> {
  const dirs = [...pathEnv.split(path.delimiter).filter(Boolean), ...extraBinDirs(home), ...(await nvmBinDirs(home))];
  return [...new Set(dirs)];
}

export async function binaryOnDisk(name: string, dirs: string[]): Promise<boolean> {
  for (const dir of dirs) {
    try {
      await fs.access(path.join(dir, name), fsConstants.X_OK);
      return true;
    } catch { /* try the next folder */ }
  }
  return false;
}

export function tcpOpen(port: number, host = '127.0.0.1', timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Names of MCP servers set up for the user's own agents: Claude's user list, the shared list, and Codex's config. */
export async function configuredMcpNames(home: string = getHomeDir()): Promise<Set<string>> {
  const names = new Set<string>();
  for (const file of [path.join(home, '.claude.json'), path.join(home, '.mcp.json')]) {
    try {
      const json = JSON.parse(await fs.readFile(file, 'utf-8')) as { mcpServers?: Record<string, unknown> };
      for (const n of Object.keys(json.mcpServers ?? {})) names.add(n);
    } catch { /* missing or unreadable: nothing to add */ }
  }
  try {
    const toml = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf-8');
    for (const m of toml.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)) names.add(m[1]);
  } catch { /* no Codex config */ }
  return names;
}

export function runAuthCheck(argv: string[], dirs: string[], home: string = getHomeDir()): Promise<boolean> {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, PATH: [...dirs, process.env.PATH ?? ''].join(path.delimiter), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
    execFile(argv[0], argv.slice(1), { timeout: 6000, env, windowsHide: true }, (err) => resolve(!err));
  });
}

export async function gatherFacts(savedNames: string[], home: string = getHomeDir()): Promise<Facts> {
  const dirs = await searchDirs(home);
  return {
    binaries: (name) => binaryOnDisk(name, dirs),
    envNames: new Set(Object.keys(process.env).filter((k) => !!process.env[k])),
    savedNames: new Set(savedNames),
    mcpNames: await configuredMcpNames(home),
    port: (p) => tcpOpen(p),
    authCheck: (argv) => runAuthCheck(argv, dirs, home),
    viaGateway: async (id) => id === 'typesafe-jev' && (await jevConnection()).via === 'gateway',
  };
}

export async function detectConnector(c: Connector, facts: Facts): Promise<ConnectorStatus> {
  const notes: string[] = [];
  const d = c.detect;
  const hasBinary = d.binary ? await facts.binaries(d.binary) : false;
  if (d.binary) notes.push(hasBinary ? `${d.binary} is installed` : `${d.binary} is not installed`);

  if (c.kind === 'api-key') {
    const name = c.setup.key!.env;
    const saved = facts.savedNames.has(name);
    const inEnv = facts.envNames.has(name);
    if (saved || inEnv) {
      notes.push(saved ? 'key saved here' : 'key found in the environment');
      return { id: c.id, state: 'ready', notes, keyFrom: saved ? 'saved' : 'environment' };
    }
    if (facts.viaGateway && await facts.viaGateway(c.id)) {
      notes.push('connected through the DevFlow gateway');
      return { id: c.id, state: 'ready', notes };
    }
    notes.push('no key yet');
    return { id: c.id, state: 'not-set-up', notes };
  }

  if (c.kind === 'mcp') {
    const has = !!d.mcp && facts.mcpNames.has(d.mcp);
    notes.push(has ? 'in your MCP list' : 'not in your MCP list');
    if (d.port) {
      const up = await facts.port(d.port);
      notes.push(up ? `port ${d.port} answers` : `nothing answers on port ${d.port}`);
    }
    return { id: c.id, state: has ? 'ready' : 'not-set-up', notes };
  }

  if (c.kind === 'local-service') {
    const up = d.port ? await facts.port(d.port) : false;
    if (d.port) notes.push(up ? `answering on port ${d.port}` : `nothing answers on port ${d.port}`);
    if (up) return { id: c.id, state: 'running', notes };
    return { id: c.id, state: hasBinary ? 'installed' : 'not-set-up', notes };
  }

  // cli
  if (!hasBinary) return { id: c.id, state: 'not-set-up', notes };
  if (c.authCheck) {
    const ok = await facts.authCheck(c.authCheck);
    notes.push(ok ? 'signed in' : 'not signed in yet');
    return { id: c.id, state: ok ? 'ready' : 'installed', notes };
  }
  notes.push('sign-in is not checked from here');
  return { id: c.id, state: 'installed', notes };
}

export async function detectAll(connectors: Connector[], facts: Facts): Promise<ConnectorStatus[]> {
  return Promise.all(connectors.map((c) => detectConnector(c, facts)));
}
