/**
 * Reading a channel's PROJECT.md for the Project Docs panel, from the machine where the project lives.
 *
 * DevFlow now runs on the laptop server while project folders (the main project and the rest) live on the desktop PC, so reading the file
 * from the server's own disk answered "file not found" for every desktop project (18 Oct 2026). When an agent host is configured
 * (DEVFLOW_AGENT_HOST, the same switch channel tools use) the file is read through that host's agent-hostd op `project-doc-read`;
 * otherwise, on a machine that holds the projects itself, it is read from disk.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { hostCall, filesHostFor, type HostAgentRef } from './host-executor';

export type ProjectDocStatus = 'ok' | 'not-found' | 'no-folder' | 'host-offline' | 'host-outdated' | 'error';

export interface ProjectDocResult {
  projectPath: string;
  content: string | null;
  exists: boolean;
  /** When the file was last modified (whole seconds), passed back on save so a change made meanwhile is noticed. */
  mtime?: number;
  status: ProjectDocStatus;
  /** Plain English, set when the panel should say why it has nothing to show. */
  message?: string;
}

export interface ProjectDocDeps {
  hostCall: <T>(host: string, op: string, args: Record<string, unknown>, waitMs?: number) => Promise<T>;
  readFile: (file: string) => Promise<string>;
  writeFile: (file: string, content: string) => Promise<void>;
  mtimeSeconds: (file: string) => Promise<number | null>;
  isDirectory: (dir: string) => Promise<boolean>;
}

const defaultDeps: ProjectDocDeps = {
  hostCall,
  readFile: file => fs.readFile(file, 'utf-8'),
  writeFile: async (file, content) => {
    const tmp = `${file}.devflow-tmp`;
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, file);
  },
  mtimeSeconds: async file => { try { return Math.floor((await fs.stat(file)).mtimeMs / 1000); } catch { return null; } },
  isDirectory: async dir => (await fs.stat(dir)).isDirectory(),
};

const HOST_WAIT_MS = 15_000;

interface HostReply { exists: boolean; folderExists: boolean; content?: string; mtime?: number }

function hostProblem(error: unknown): { status: ProjectDocStatus; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code;
  if (code === 'EHOSTTIMEOUT') {
    return { status: 'host-offline', message: "The agent machine isn't answering, so the project document can't be read right now." };
  }
  if (/unknown op/i.test(message)) {
    return { status: 'host-outdated', message: "The agent machine's helper (agent-hostd) needs a restart before it can read project documents." };
  }
  return { status: 'error', message: `The project document could not be read: ${message.slice(0, 200)}` };
}

export async function readProjectDoc(
  projectPath: string,
  agent?: HostAgentRef | null,
  deps: ProjectDocDeps = defaultDeps,
): Promise<ProjectDocResult> {
  const host = filesHostFor(agent);
  if (!host) {
    try {
      const file = path.join(projectPath, 'PROJECT.md');
      const content = await deps.readFile(file);
      return { projectPath, content, exists: true, mtime: (await deps.mtimeSeconds(file)) ?? undefined, status: 'ok' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { projectPath, content: null, exists: false, status: 'not-found' };
      return { projectPath, content: null, exists: false, ...hostProblem(error) };
    }
  }
  try {
    const reply = await deps.hostCall<HostReply>(host, 'project-doc-read', { dir: projectPath }, HOST_WAIT_MS);
    if (reply.exists && typeof reply.content === 'string') return { projectPath, content: reply.content, exists: true, mtime: reply.mtime, status: 'ok' };
    if (!reply.folderExists) {
      return { projectPath, content: null, exists: false, status: 'no-folder', message: `The folder ${projectPath} does not exist on the agent machine.` };
    }
    return { projectPath, content: null, exists: false, status: 'not-found' };
  } catch (error) {
    return { projectPath, content: null, exists: false, ...hostProblem(error) };
  }
}

/** Whether the project folder exists where the project lives (used when a channel's working directory is set). */
export async function projectFolderExists(
  projectPath: string,
  agent?: HostAgentRef | null,
  deps: ProjectDocDeps = defaultDeps,
): Promise<{ ok: true; exists: boolean } | { ok: false; status: ProjectDocStatus; message: string }> {
  const host = filesHostFor(agent);
  if (!host) {
    try {
      return { ok: true, exists: await deps.isDirectory(projectPath) };
    } catch {
      return { ok: true, exists: false };
    }
  }
  try {
    const reply = await deps.hostCall<HostReply>(host, 'project-doc-read', { dir: projectPath }, HOST_WAIT_MS);
    return { ok: true, exists: reply.folderExists === true };
  } catch (error) {
    return { ok: false, ...hostProblem(error) };
  }
}

export type ProjectDocWrite =
  | { ok: true; mtime: number | null }
  | { ok: false; conflict: true; content: string; mtime: number | null }
  | { ok: false; conflict?: false; status: ProjectDocStatus; message: string };

/**
 * Saves a channel's PROJECT.md where the project lives. `expectedMtime` is the modified time the editor read: when the file has
 * changed since (an agent edited it), nothing is written and the current text comes back as a conflict.
 */
export async function writeProjectDoc(
  projectPath: string,
  content: string,
  expectedMtime: number | null,
  agent?: HostAgentRef | null,
  deps: ProjectDocDeps = defaultDeps,
): Promise<ProjectDocWrite> {
  const host = filesHostFor(agent);
  if (!host) {
    try {
      const file = path.join(projectPath, 'PROJECT.md');
      const current = await deps.mtimeSeconds(file);
      if (current !== null && expectedMtime !== null && current !== expectedMtime) {
        return { ok: false, conflict: true, content: await deps.readFile(file), mtime: current };
      }
      await deps.writeFile(file, content);
      return { ok: true, mtime: await deps.mtimeSeconds(file) };
    } catch (error) {
      return { ok: false, ...hostProblem(error) };
    }
  }
  try {
    const reply = await deps.hostCall<{ saved: boolean; conflict?: boolean; content?: string; mtime?: number }>(
      host, 'project-doc-write', { dir: projectPath, content, expectedMtime }, HOST_WAIT_MS,
    );
    if (reply.conflict) return { ok: false, conflict: true, content: reply.content ?? '', mtime: reply.mtime ?? null };
    return { ok: true, mtime: reply.mtime ?? null };
  } catch (error) {
    const problem = hostProblem(error);
    if (problem.status === 'host-outdated') {
      return { ok: false, status: 'host-outdated', message: "The agent machine's helper (agent-hostd) needs a restart before project documents can be saved." };
    }
    return { ok: false, ...problem };
  }
}
