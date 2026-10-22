/**
 * Reading a channel's PROJECT.md for the Project Docs panel, from the machine where the project lives.
 *
 * DevFlow now runs on the laptop server while project folders (SG-1 and the rest) live on the desktop PC, so reading the file
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
  status: ProjectDocStatus;
  /** Plain English, set when the panel should say why it has nothing to show. */
  message?: string;
}

export interface ProjectDocDeps {
  hostCall: <T>(host: string, op: string, args: Record<string, unknown>, waitMs?: number) => Promise<T>;
  readFile: (file: string) => Promise<string>;
  isDirectory: (dir: string) => Promise<boolean>;
}

const defaultDeps: ProjectDocDeps = {
  hostCall,
  readFile: file => fs.readFile(file, 'utf-8'),
  isDirectory: async dir => (await fs.stat(dir)).isDirectory(),
};

const HOST_WAIT_MS = 15_000;

interface HostReply { exists: boolean; folderExists: boolean; content?: string }

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
      return { projectPath, content: await deps.readFile(path.join(projectPath, 'PROJECT.md')), exists: true, status: 'ok' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { projectPath, content: null, exists: false, status: 'not-found' };
      return { projectPath, content: null, exists: false, ...hostProblem(error) };
    }
  }
  try {
    const reply = await deps.hostCall<HostReply>(host, 'project-doc-read', { dir: projectPath }, HOST_WAIT_MS);
    if (reply.exists && typeof reply.content === 'string') return { projectPath, content: reply.content, exists: true, status: 'ok' };
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
