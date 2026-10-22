/**
 * Agents that run on the DevFlow machine (roster runLocation 'server') while their working folders live on the desktop.
 *
 * The desktop shares chosen folders (scripts/devflow_share.py); this machine mounts them and registers them in
 * ~/.config/devflow-files/roots.json. scripts/devflow-agent-view starts a command in a private view where each shared folder appears at its
 * desktop path. This file decides WHICH folders an agent's view needs and builds the launch command; it never starts anything itself
 * except the availability check.
 *
 * The rules, so an agent never works on the wrong copy of its files:
 *   - every shared folder that holds the agent's working folder or project is overlaid, plus the agent's own Claude memory folder;
 *   - if no shared folder holds the working folder, or the folder that does is read-only, the agent does not start, with a plain reason;
 *   - if a needed folder is not mounted and answering right now, the agent does not start.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { defaultHost, hostCall } from './host-executor';

const execFileAsync = promisify(execFile);

export interface FilesRoot { id: string; desktopPath: string; viewPath: string }

export class LaptopViewError extends Error {
  constructor(message: string, readonly code: 'NOT_SHARED' | 'READ_ONLY' | 'NO_MEMORY' | 'UNAVAILABLE' | 'BAD_REGISTRY') { super(message); }
}

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export const filesRegistryPath = (): string => process.env.DEVFLOW_FILES_ROOTS || path.join(os.homedir(), '.config', 'devflow-files', 'roots.json');
export const viewScriptPath = (): string => process.env.DEVFLOW_AGENT_VIEW || path.join(process.cwd(), 'scripts', 'devflow-agent-view');

/** The registered folders. Anything malformed is ignored, never guessed at. */
export function parseRegistry(raw: unknown): FilesRoot[] {
  const roots = raw && typeof raw === 'object' ? (raw as { roots?: unknown }).roots : null;
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) return [];
  const out: FilesRoot[] = [];
  for (const [id, info] of Object.entries(roots as Record<string, unknown>)) {
    const entry = info && typeof info === 'object' ? (info as { desktopPath?: unknown; viewPath?: unknown }) : null;
    if (!ID_RE.test(id) || !entry || typeof entry.desktopPath !== 'string' || !entry.desktopPath.startsWith('/')) continue;
    const view = typeof entry.viewPath === 'string' && entry.viewPath.startsWith('/') ? entry.viewPath : entry.desktopPath;
    out.push({ id, desktopPath: path.posix.normalize(entry.desktopPath), viewPath: path.posix.normalize(view) });
  }
  return out;
}

/** The folder name Claude Code uses under ~/.claude/projects for a working directory: every character that is not a letter or digit becomes "-". */
export function claudeProjectKey(workingDirectory: string): string {
  return workingDirectory.replace(/[^a-zA-Z0-9]/g, '-');
}

const within = (parent: string, child: string): boolean => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');

export interface ViewPlan {
  roots: FilesRoot[];            // everything to overlay
  work: FilesRoot[];             // the folders that hold the working folder or project (at least one is required)
  memory: FilesRoot | null;      // the agent's own Claude memory folder
}

/** Which registered folders an agent's view needs. */
export function chooseViewRoots(registry: FilesRoot[], want: { workingDirectory: string; projectPath?: string | null }): ViewPlan {
  const wd = path.posix.normalize(want.workingDirectory);
  const project = want.projectPath ? path.posix.normalize(want.projectPath) : null;
  const key = claudeProjectKey(wd);
  const work = registry.filter(r => within(r.desktopPath, wd) || (project !== null && within(r.desktopPath, project)));
  const memory = registry.find(r => r.desktopPath.endsWith(`/.claude/projects/${key}`)) ?? null;
  const roots = [...work];
  if (memory && !roots.includes(memory)) roots.push(memory);
  return { roots, work, memory };
}

/** POSIX single-quote quoting. */
export function shq(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The launch command with the view around it. `command` is the shell command that would otherwise start the agent (it keeps its own `cd` and `exec`). */
export function wrapLaunchForView(input: { command: string; roots: string[]; workingDirectory: string; viewScript?: string }): string {
  for (const id of input.roots) if (!ID_RE.test(id)) throw new Error(`bad folder id ${id}`);
  const script = input.viewScript ?? viewScriptPath();
  return `exec python3 ${shq(script)} --roots ${input.roots.join(',')} --chdir ${shq(input.workingDirectory)} -- /bin/bash -c ${shq(input.command)}`;
}

/**
 * Environment the agent needs on this machine: programs the agent machine's PATH has but a service's does not, and Playwright's platform name
 * (Playwright 1.59 has no Chromium build for Ubuntu 26.04, so it is told to use the 24.04 one, which runs here once its libraries are installed).
 */
export const LAPTOP_AGENT_ENV_PREFIX =
  'export DEVFLOW_RUN_LOCATION=server PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$PATH";';

export interface ViewProbe { ok: boolean; message: string }
export interface LaptopViewDeps {
  readRegistry: () => Promise<unknown>;
  /** Runs `devflow-agent-view --roots ids --chdir wd -- /usr/bin/test -d wd -a -w wd` and reports its exit code and stderr. */
  probe: (roots: string[], workingDirectory: string) => Promise<{ code: number; stderr: string }>;
  /** Asks the desktop to share this agent's working folder and memory folder (hostd op "share-agent"). Throws with a plain reason if it cannot. */
  requestShare?: (input: { agentName: string; workingDirectory: string }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** How long to wait, after the desktop accepts a share request, for the folders to be registered here and answering. */
export const SHARE_WAIT_MS = 45_000;
const SHARE_POLL_MS = 2_000;

export const defaultDeps: LaptopViewDeps = {
  readRegistry: async () => {
    try { return JSON.parse(await readFile(filesRegistryPath(), 'utf8')); } catch { return null; }
  },
  probe: async (roots, workingDirectory) => {
    try {
      await execFileAsync('python3', [viewScriptPath(), '--roots', roots.join(','), '--chdir', workingDirectory, '--', '/usr/bin/test', '-d', workingDirectory, '-a', '-w', workingDirectory],
        { timeout: 20_000 });
      return { code: 0, stderr: '' };
    } catch (error) {
      const e = error as { code?: number | string; stderr?: string; killed?: boolean };
      return { code: typeof e.code === 'number' ? e.code : 99, stderr: String(e.stderr ?? (e.killed ? 'timed out' : '')).trim() };
    }
  },
  requestShare: async ({ agentName, workingDirectory }) => {
    const host = defaultHost();
    if (!host) throw new Error('no desktop host is configured');
    await hostCall(host, 'share-agent', { agent: agentName, cwd: workingDirectory }, 60_000);
  },
};

export interface LaptopLaunch { roots: string[]; wrap: (command: string) => string }

type ViewCheck = { ok: true; ids: string[] } | { ok: false; error: LaptopViewError };

/** Whether asking the desktop to share the agent's folders could fix this failure. A desktop that is off or asleep is not fixable that way. */
const fixableByShare = (error: LaptopViewError): boolean => error.code === 'NOT_SHARED' || error.code === 'NO_MEMORY' || error.code === 'READ_ONLY';

async function checkView(input: { workingDirectory: string; projectPath?: string | null; agentName: string }, deps: LaptopViewDeps): Promise<ViewCheck> {
  const registry = parseRegistry(await deps.readRegistry());
  const plan = chooseViewRoots(registry, input);
  if (plan.work.length === 0) {
    return { ok: false, error: new LaptopViewError(`${input.workingDirectory} is not in a folder the desktop shares. On the desktop, run: devflow-share agent ${input.agentName} ${input.workingDirectory}`, 'NOT_SHARED') };
  }
  if (!plan.memory) {
    return { ok: false, error: new LaptopViewError(`${input.agentName}'s memory folder is not shared yet, so it would start without its memory. On the desktop, run: devflow-share agent ${input.agentName} ${input.workingDirectory}`, 'NO_MEMORY') };
  }
  const ids = plan.roots.map(r => r.id);
  const result = await deps.probe(ids, input.workingDirectory);
  if (result.code !== 0) {
    if (/not available/i.test(result.stderr)) return { ok: false, error: new LaptopViewError(`A desktop folder this agent needs is not available (the desktop may be off or asleep): ${result.stderr.replace(/^devflow-agent-view:\s*/, '')}`, 'UNAVAILABLE') };
    if (result.code === 1) return { ok: false, error: new LaptopViewError(`${input.workingDirectory} cannot be written from here, so ${input.agentName} could not keep its notes. On the desktop, run: devflow-share agent ${input.agentName} ${input.workingDirectory}`, 'READ_ONLY') };
    return { ok: false, error: new LaptopViewError(`The desktop folders could not be checked: ${result.stderr || 'no answer'}`, 'UNAVAILABLE') };
  }
  return { ok: true, ids };
}

/**
 * Check that everything an agent needs on the desktop is there right now, and return how to start it. Throws LaptopViewError with a plain reason.
 *
 * If the agent's folders are not shared (a new agent, or an agent in a new project), the desktop is asked to share them and the check is repeated
 * until they answer, so nobody has to run a share command by hand. If the desktop cannot or will not, the error says why and names the manual command.
 */
export async function prepareLaptopLaunch(
  input: { workingDirectory: string; projectPath?: string | null; agentName: string },
  deps: LaptopViewDeps = defaultDeps,
): Promise<LaptopLaunch> {
  let result = await checkView(input, deps);
  if (!result.ok && fixableByShare(result.error) && deps.requestShare) {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const now = deps.now ?? Date.now;
    const first = result.error;
    try {
      await deps.requestShare({ agentName: input.agentName, workingDirectory: input.workingDirectory });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new LaptopViewError(`${first.message} (Asking the desktop to share it automatically failed: ${reason})`, first.code);
    }
    const deadline = now() + SHARE_WAIT_MS;
    do {
      await sleep(SHARE_POLL_MS);
      result = await checkView(input, deps);
    } while (!result.ok && now() < deadline && (fixableByShare(result.error) || result.error.code === 'UNAVAILABLE'));
  }
  if (!result.ok) throw result.error;
  const ids = result.ids;
  return { roots: ids, wrap: command => wrapLaunchForView({ command: `${LAPTOP_AGENT_ENV_PREFIX} ${command}`, roots: ids, workingDirectory: input.workingDirectory }) };
}
