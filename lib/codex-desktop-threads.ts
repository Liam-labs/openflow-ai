import { spawn } from 'child_process';

import { resolveWorkingWslInterop } from '@/lib/windows-interop';

const RPC_TIMEOUT_MS = 12_000;
const CREATE_RPC_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_THREADS = 40;
const ROUTING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface CodexDesktopThread {
  id: string;
  sessionId: string;
  title: string;
  project: string;
  updatedAt: string;
  cwd: string;
  historyMode: 'legacy' | 'paginated';
}

interface AppServerThread {
  id?: unknown;
  sessionId?: unknown;
  name?: unknown;
  preview?: unknown;
  cwd?: unknown;
  updatedAt?: unknown;
  source?: unknown;
  ephemeral?: unknown;
  historyMode?: unknown;
}

interface ThreadListPayload {
  data?: unknown;
}

type RpcThreadList = () => Promise<ThreadListPayload>;

interface ThreadStartPayload {
  thread?: unknown;
}

type RpcThreadStart = (input: { cwd: string; name: string }) => Promise<ThreadStartPayload>;

export class CodexDesktopThreadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CodexDesktopThreadError';
  }
}

function safeProcessEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) =>
      value !== undefined && !/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH|COOKIE)/i.test(key)
    ),
  );
  return { ...environment, NODE_ENV: process.env.NODE_ENV ?? 'production' } as NodeJS.ProcessEnv;
}

export async function createCodexDesktopProcessEnvironment(
  resolveInterop: () => Promise<string> = resolveWorkingWslInterop,
): Promise<NodeJS.ProcessEnv> {
  return {
    ...safeProcessEnvironment(),
    WSL_INTEROP: await resolveInterop(),
  };
}

async function windowsThreadListRpc(): Promise<ThreadListPayload> {
  let environment: NodeJS.ProcessEnv;
  try {
    environment = await createCodexDesktopProcessEnvironment();
  } catch {
    throw new CodexDesktopThreadError(
      'Codex Desktop chat list is unavailable',
      'CODEX_DESKTOP_THREAD_LIST_UNAVAILABLE',
      503,
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& (Get-Command codex -ErrorAction Stop).Source app-server --listen stdio://',
      ],
      {
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let settled = false;
    let buffer = '';
    let stdoutBytes = 0;

    const finish = (error?: Error, payload?: ThreadListPayload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(payload ?? { data: [] });
    };

    const timeout = setTimeout(() => finish(new CodexDesktopThreadError(
      'Codex Desktop chat list timed out',
      'CODEX_DESKTOP_THREAD_LIST_UNAVAILABLE',
      503,
    )), RPC_TIMEOUT_MS);

    child.on('error', () => finish(new CodexDesktopThreadError(
      'Codex Desktop chat list is unavailable',
      'CODEX_DESKTOP_THREAD_LIST_UNAVAILABLE',
      503,
    )));
    child.on('exit', (code) => {
      if (!settled && code !== null) finish(new CodexDesktopThreadError(
        'Codex Desktop chat list is unavailable',
        'CODEX_DESKTOP_THREAD_LIST_UNAVAILABLE',
        503,
      ));
    });
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        finish(new CodexDesktopThreadError(
          'Codex Desktop returned too much thread data',
          'CODEX_DESKTOP_THREAD_LIST_UNAVAILABLE',
          503,
        ));
        return;
      }
      buffer += chunk.replace(/\r/g, '');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        let message: { id?: number; result?: ThreadListPayload; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({
            method: 'thread/list',
            id: 2,
            params: {
              limit: MAX_THREADS,
              sortKey: 'updated_at',
              sortDirection: 'desc',
              sourceKinds: ['vscode', 'appServer'],
              archived: false,
              useStateDbOnly: true,
            },
          })}\n`);
        } else if (message.id === 2) {
          if (message.error || !message.result) {
            finish(new CodexDesktopThreadError(
              'Codex Desktop could not list chats',
              'CODEX_DESKTOP_THREAD_LIST_UNAVAILABLE',
              503,
            ));
          } else {
            finish(undefined, message.result);
          }
        }
      }
    });

    child.stdin.write(`${JSON.stringify({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'devflow-chat-picker', title: 'DevFlow Chat Picker', version: '1.0.0' },
        capabilities: null,
      },
    })}\n`);
  });
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function projectName(cwd: unknown): string {
  const normalized = text(cwd, 500);
  return normalized.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 80) || 'Codex project';
}

function normalizeThread(value: unknown): CodexDesktopThread | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const thread = value as AppServerThread;
  if (
    (thread.source !== 'vscode' && thread.source !== 'appServer')
    || thread.ephemeral === true
    || typeof thread.id !== 'string'
    || typeof thread.sessionId !== 'string'
    || !ROUTING_ID_PATTERN.test(thread.id)
    || !ROUTING_ID_PATTERN.test(thread.sessionId)
    || typeof thread.updatedAt !== 'number'
    || !Number.isFinite(thread.updatedAt)
  ) return null;
  const preview = text(thread.preview, 180);
  const cwd = text(thread.cwd, 500);
  return {
    id: thread.id,
    sessionId: thread.sessionId,
    title: text(thread.name, 120) || preview.slice(0, 120) || 'Untitled Codex chat',
    project: projectName(thread.cwd),
    updatedAt: new Date(thread.updatedAt * 1_000).toISOString(),
    cwd,
    historyMode: thread.historyMode === 'paginated' ? 'paginated' : 'legacy',
  };
}

async function windowsThreadStartRpc(input: { cwd: string; name: string }): Promise<ThreadStartPayload> {
  let environment: NodeJS.ProcessEnv;
  try {
    environment = await createCodexDesktopProcessEnvironment();
  } catch {
    throw new CodexDesktopThreadError(
      'Codex Desktop bridge chat is unavailable',
      'CODEX_DESKTOP_THREAD_CREATE_UNAVAILABLE',
      503,
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& (Get-Command codex -ErrorAction Stop).Source app-server --listen stdio://',
      ],
      {
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let settled = false;
    let buffer = '';
    let stdoutBytes = 0;
    let started: ThreadStartPayload | null = null;

    const finish = (error?: Error, payload?: ThreadStartPayload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(payload ?? { thread: undefined });
    };

    const timeout = setTimeout(() => finish(new CodexDesktopThreadError(
      'Codex Desktop bridge chat creation timed out',
      'CODEX_DESKTOP_THREAD_CREATE_UNAVAILABLE',
      503,
    )), CREATE_RPC_TIMEOUT_MS);

    child.on('error', () => finish(new CodexDesktopThreadError(
      'Codex Desktop bridge chat is unavailable',
      'CODEX_DESKTOP_THREAD_CREATE_UNAVAILABLE',
      503,
    )));
    child.on('exit', (code) => {
      if (!settled && code !== null) finish(new CodexDesktopThreadError(
        'Codex Desktop bridge chat could not be created',
        'CODEX_DESKTOP_THREAD_CREATE_UNAVAILABLE',
        503,
      ));
    });
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        finish(new CodexDesktopThreadError(
          'Codex Desktop returned too much thread data',
          'CODEX_DESKTOP_THREAD_CREATE_UNAVAILABLE',
          503,
        ));
        return;
      }
      buffer += chunk.replace(/\r/g, '');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        let message: { id?: number; result?: ThreadStartPayload; error?: { message?: unknown } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({
            method: 'thread/start',
            id: 2,
            params: {
              cwd: input.cwd,
              historyMode: 'legacy',
              serviceName: 'devflow_agentchat',
            },
          })}\n`);
        } else if (message.id === 2) {
          if (message.error || !message.result) {
            const detail = typeof message.error?.message === 'string'
              ? `: ${message.error.message}`
              : '';
            finish(new CodexDesktopThreadError(
              `Codex Desktop could not create a bridge-compatible chat${detail}`,
              'CODEX_DESKTOP_THREAD_CREATE_UNAVAILABLE',
              503,
            ));
            continue;
          }
          started = message.result;
          const thread = message.result.thread as { id?: unknown } | undefined;
          if (!thread || typeof thread.id !== 'string' || !ROUTING_ID_PATTERN.test(thread.id)) {
            finish(new CodexDesktopThreadError(
              'Codex Desktop returned an invalid bridge chat identity',
              'CODEX_DESKTOP_THREAD_CREATE_UNAVAILABLE',
              503,
            ));
            continue;
          }
          child.stdin.write(`${JSON.stringify({
            method: 'thread/name/set',
            id: 3,
            params: { threadId: thread.id, name: input.name },
          })}\n`);
        } else if (message.id === 3 && started) {
          // Naming is cosmetic; the persisted legacy thread is usable even if
          // an older app-server build does not support thread/name/set.
          finish(undefined, started);
        }
      }
    });

    child.stdin.write(`${JSON.stringify({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'devflow-agentchat', title: 'DevFlow AgentChat', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    })}\n`);
  });
}

export function createCodexDesktopBridgeThreadCreator(
  { rpc = windowsThreadStartRpc }: { rpc?: RpcThreadStart } = {},
) {
  return async (source: CodexDesktopThread): Promise<CodexDesktopThread> => {
    const name = source.title.endsWith(' · AgentChat')
      ? source.title
      : `${source.title} · AgentChat`.slice(0, 120);
    const result = await rpc({ cwd: source.cwd, name });
    const thread = result.thread as { id?: unknown; sessionId?: unknown } | undefined;
    if (
      !thread
      || typeof thread.id !== 'string'
      || typeof thread.sessionId !== 'string'
      || !ROUTING_ID_PATTERN.test(thread.id)
      || !ROUTING_ID_PATTERN.test(thread.sessionId)
    ) {
      throw new CodexDesktopThreadError(
        'Codex Desktop returned an invalid bridge chat identity',
        'CODEX_DESKTOP_THREAD_CREATE_UNAVAILABLE',
        503,
      );
    }
    cached = null;
    return {
      id: thread.id,
      sessionId: thread.sessionId,
      title: name,
      project: source.project,
      updatedAt: new Date().toISOString(),
      cwd: source.cwd,
      historyMode: 'legacy',
    };
  };
}

export function createCodexDesktopThreadLister({ rpc = windowsThreadListRpc }: { rpc?: RpcThreadList } = {}) {
  return async (): Promise<CodexDesktopThread[]> => {
    const result = await rpc();
    if (!Array.isArray(result.data)) return [];
    return result.data.flatMap((item) => {
      const thread = normalizeThread(item);
      return thread ? [thread] : [];
    }).slice(0, MAX_THREADS);
  };
}

const uncachedList = createCodexDesktopThreadLister();
let cached: { expiresAt: number; threads: CodexDesktopThread[] } | null = null;
let inFlight: Promise<CodexDesktopThread[]> | null = null;

export async function listCodexDesktopThreads(): Promise<CodexDesktopThread[]> {
  if (cached && cached.expiresAt > Date.now()) return cached.threads;
  if (!inFlight) {
    inFlight = uncachedList().then((threads) => {
      cached = { expiresAt: Date.now() + 5_000, threads };
      return threads;
    }).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

export async function findCodexDesktopThread(threadId: string): Promise<CodexDesktopThread> {
  if (!ROUTING_ID_PATTERN.test(threadId)) {
    throw new CodexDesktopThreadError('Invalid Codex Desktop chat selection', 'CODEX_DESKTOP_THREAD_INVALID', 400);
  }
  const thread = (await listCodexDesktopThreads()).find((item) => item.id === threadId);
  if (!thread) {
    throw new CodexDesktopThreadError('That Codex Desktop chat is no longer available', 'CODEX_DESKTOP_THREAD_NOT_FOUND', 404);
  }
  return thread;
}

export const createCodexDesktopBridgeThread = createCodexDesktopBridgeThreadCreator();

export async function ensureCodexDesktopBridgeThread(
  thread: CodexDesktopThread,
  createBridgeThread: (source: CodexDesktopThread) => Promise<CodexDesktopThread> = createCodexDesktopBridgeThread,
): Promise<CodexDesktopThread> {
  return thread.historyMode === 'paginated' ? createBridgeThread(thread) : thread;
}
