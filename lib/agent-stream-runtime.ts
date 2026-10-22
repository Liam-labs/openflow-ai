/**
 * Runtime-aware source resolution and normalization for Agent Live View.
 *
 * Every harness persists a different transcript format. This module owns the
 * runtime dispatch and converts native records to the Claude-compatible
 * RawMessageEntry envelope consumed by the existing drawer.
 */

import { join, resolve } from 'node:path';
import { resolveJsonlForDir, type ResolverOptions } from '@/lib/agent-jsonl-resolver';
import { localStreamFs, type StreamFs } from '@/lib/agent-stream-fs';
import type { AgentRosterEntry } from '@/lib/types';

import { getHomeDir } from '@/lib/home-dir';
export type AgentRuntime = NonNullable<AgentRosterEntry['agentType']>;

export interface ResolvedAgentStream {
  path: string;
  runtime: AgentRuntime;
  resolvedVia: string;
}

export interface RuntimeResolverOptions extends ResolverOptions {}

type JsonRecord = Record<string, unknown>;

function agentDirectory(agent: AgentRosterEntry): string {
  return agent.effectiveWorkingDirectory?.trim() || agent.workingDirectory;
}

function runtimeFor(agent: AgentRosterEntry): AgentRuntime {
  return agent.agentType ?? 'claude';
}

async function homeFor(options: RuntimeResolverOptions | undefined, fsx: StreamFs): Promise<string> {
  return options?.home ?? (fsx.remote ? fsx.home() : getHomeDir());
}

/** Codex sessions are matched by reading each rollout's first line, newest first. On the agent host that is one call each, so look at fewer. */
const REMOTE_CODEX_PROBES = 40;

function sameDirectory(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function newestPath(files: Array<{ path: string; mtimeMs: number }>): string | null {
  let newest: string | null = null;
  let newestMtime = -Infinity;
  for (const file of files) {
    if (file.mtimeMs > newestMtime) {
      newest = file.path;
      newestMtime = file.mtimeMs;
    }
  }
  return newest;
}

async function readFirstJsonRecord(fsx: StreamFs, path: string): Promise<JsonRecord | null> {
  const head = await fsx.readText(path, 64 * 1024);
  if (head === null) return null;
  try {
    const parsed = JSON.parse(head.split('\n', 1)[0]) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function resolveCodex(
  fsx: StreamFs,
  cwd: string,
  home: string,
): Promise<ResolvedAgentStream | null> {
  const root = join(home, '.codex', 'sessions');
  const candidates = await fsx.findFiles(root, { prefix: 'rollout-', suffix: '.jsonl', maxDepth: 4 });
  const ordered = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = fsx.remote ? ordered.slice(0, REMOTE_CODEX_PROBES) : ordered;

  for (const candidate of limited) {
    const first = await readFirstJsonRecord(fsx, candidate.path);
    const payload = isRecord(first?.payload) ? first.payload : null;
    if (
      first?.type === 'session_meta' &&
      typeof payload?.cwd === 'string' &&
      sameDirectory(payload.cwd, cwd)
    ) {
      return {
        path: candidate.path,
        runtime: 'codex',
        resolvedVia: 'codex-session-cwd',
      };
    }
  }
  return null;
}

async function resolveGemini(
  fsx: StreamFs,
  cwd: string,
  home: string,
): Promise<ResolvedAgentStream | null> {
  const tmpRoot = join(home, '.gemini', 'tmp');
  const projectDirs = await fsx.readdir(tmpRoot);
  if (!projectDirs) return null;

  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of projectDirs) {
    if (!entry.isDir) continue;
    const projectDir = join(tmpRoot, entry.name);
    // Ignore stale/incomplete Gemini temp projects.
    const projectRoot = (await fsx.readText(join(projectDir, '.project_root')))?.trim();
    if (!projectRoot || !sameDirectory(projectRoot, cwd)) continue;
    const chats = await fsx.readdir(join(projectDir, 'chats'));
    for (const chat of chats ?? []) {
      if (chat.isFile && chat.name.startsWith('session-') && chat.name.endsWith('.jsonl')) {
        candidates.push({ path: join(projectDir, 'chats', chat.name), mtimeMs: chat.mtimeMs });
      }
    }
  }

  const path = newestPath(candidates);
  return path
    ? { path, runtime: 'gemini', resolvedVia: 'gemini-project-root' }
    : null;
}

async function resolveGrok(
  fsx: StreamFs,
  cwd: string,
  home: string,
): Promise<ResolvedAgentStream> {
  const wrapperPath = join(cwd, '.grok-stream.jsonl');
  if (await fsx.stat(wrapperPath)) {
    return {
      path: wrapperPath,
      runtime: 'grok',
      resolvedVia: 'grok-wrapper-stream',
    };
  }

  const nativeRoot = join(home, '.grok', 'sessions', encodeURIComponent(cwd));
  const candidates = await fsx.findFiles(nativeRoot, { name: 'chat_history.jsonl', maxDepth: 2 });
  const nativePath = newestPath(candidates);
  if (nativePath) {
    return {
      path: nativePath,
      runtime: 'grok',
      resolvedVia: 'grok-native-chat',
    };
  }

  // The legacy direct-API Grok harness writes this deterministic source. It
  // may not exist until the first post-upgrade turn; the tail reader tolerates
  // that and starts emitting as soon as the wrapper creates it.
  return {
    path: wrapperPath,
    runtime: 'grok',
    resolvedVia: 'grok-wrapper-stream',
  };
}

/** Resolve one roster entry to a source owned by that entry's actual runtime. */
export async function resolveAgentStreamSource(
  agent: AgentRosterEntry,
  options?: RuntimeResolverOptions,
): Promise<ResolvedAgentStream | null> {
  const runtime = runtimeFor(agent);
  const cwd = agentDirectory(agent);
  const fsx = options?.fsx ?? localStreamFs();
  const home = await homeFor(options, fsx);
  if (!cwd) return null;

  switch (runtime) {
    case 'claude': {
      const result = await resolveJsonlForDir(cwd, { ...options, fsx });
      if (!result) return null;
      return {
        path: result.path,
        runtime,
        resolvedVia: `claude-${result.resolvedVia}`,
      };
    }
    case 'codex':
      return resolveCodex(fsx, cwd, home);
    case 'gemini':
      return resolveGemini(fsx, cwd, home);
    case 'grok':
      return resolveGrok(fsx, cwd, home);
    case 'antigravity':
      return {
        path: join(cwd, '.antigravity-stream.jsonl'),
        runtime,
        resolvedVia: 'antigravity-decoder',
      };
  }
}

function parseJson(line: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textFrom(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!isRecord(item)) return '';
        if (typeof item.text === 'string') return item.text;
        if (isRecord(item.functionResponse)) {
          return textFrom(item.functionResponse);
        }
        if (isRecord(item.response)) return textFrom(item.response);
        if (typeof item.output === 'string') return item.output;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.output === 'string') return value.output;
    if ('response' in value) return textFrom(value.response);
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return value === null || value === undefined ? '' : String(value);
}

function parseToolInput(value: unknown): JsonRecord {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Preserve non-JSON command input without evaluating it.
    }
    return { input: value };
  }
  return {};
}

function entry(
  type: 'user' | 'assistant' | 'system',
  content: unknown,
  source: JsonRecord,
  uuid?: string,
): JsonRecord {
  return {
    type,
    uuid: uuid ?? (typeof source.id === 'string' ? source.id : undefined),
    timestamp:
      typeof source.timestamp === 'string'
        ? source.timestamp
        : typeof source.ts === 'string'
          ? source.ts
          : undefined,
    message: { role: type, content },
  };
}

function normalizeCodex(source: JsonRecord): JsonRecord[] {
  if (source.type !== 'response_item' || !isRecord(source.payload)) return [];
  const payload = source.payload;
  const payloadType = payload.type;

  if (payloadType === 'message') {
    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') return [];
    const blocks = Array.isArray(payload.content)
      ? payload.content
          .map((block) => {
            if (!isRecord(block)) return null;
            const text = typeof block.text === 'string' ? block.text : '';
            return text ? { type: 'text', text } : null;
          })
          .filter((block): block is { type: string; text: string } => block !== null)
      : [];
    return blocks.length
      ? [
          entry(
            role,
            blocks,
            source,
            typeof payload.id === 'string' ? payload.id : undefined,
          ),
        ]
      : [];
  }

  if (payloadType === 'reasoning') {
    const thinking = Array.isArray(payload.summary)
      ? payload.summary.map(textFrom).filter(Boolean).join('\n')
      : '';
    // Never surface encrypted_content; only the explicitly exported summary.
    return thinking
      ? [
          entry(
            'assistant',
            [{ type: 'thinking', thinking }],
            source,
            typeof payload.id === 'string' ? payload.id : undefined,
          ),
        ]
      : [];
  }

  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const id =
      typeof payload.call_id === 'string'
        ? payload.call_id
        : typeof payload.id === 'string'
          ? payload.id
          : '';
    const name = typeof payload.name === 'string' ? payload.name : 'unknown';
    return [
      entry(
        'assistant',
        [{ type: 'tool_use', id, name, input: parseToolInput(payload.arguments ?? payload.input) }],
        source,
        id || undefined,
      ),
    ];
  }

  if (
    payloadType === 'function_call_output' ||
    payloadType === 'custom_tool_call_output'
  ) {
    const id =
      typeof payload.call_id === 'string'
        ? payload.call_id
        : typeof payload.id === 'string'
          ? payload.id
          : '';
    const content = textFrom(payload.output);
    return [
      entry(
        'user',
        [{ type: 'tool_result', tool_use_id: id, content, is_error: false }],
        source,
        id ? `${id}-result` : undefined,
      ),
    ];
  }

  return [];
}

function geminiTextBlocks(content: unknown): JsonRecord[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: JsonRecord[] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.text !== 'string' || !block.text) continue;
    blocks.push({ type: 'text', text: block.text });
  }
  return blocks;
}

function normalizeGemini(source: JsonRecord): JsonRecord[] {
  // `$set` records are persistence bookkeeping and frequently repeat the full
  // message list. Direct records that follow contain the renderable updates.
  if ('$set' in source || 'sessionId' in source) return [];
  if (source.type === 'user') {
    const blocks = geminiTextBlocks(source.content);
    return blocks.length ? [entry('user', blocks, source)] : [];
  }
  if (source.type === 'info' || source.type === 'error') {
    const text = textFrom(source.content);
    return text ? [entry('system', text, source)] : [];
  }
  if (source.type !== 'gemini') return [];

  const assistantBlocks: JsonRecord[] = [];
  if (Array.isArray(source.thoughts)) {
    const thinking = source.thoughts
      .map((thought) => {
        if (!isRecord(thought)) return '';
        return [thought.subject, thought.description]
          .filter((part): part is string => typeof part === 'string' && Boolean(part))
          .join('\n');
      })
      .filter(Boolean)
      .join('\n\n');
    if (thinking) assistantBlocks.push({ type: 'thinking', thinking });
  }
  assistantBlocks.push(...geminiTextBlocks(source.content));

  const results: JsonRecord[] = [];
  if (Array.isArray(source.toolCalls)) {
    for (const tool of source.toolCalls) {
      if (!isRecord(tool)) continue;
      const id = typeof tool.id === 'string' ? tool.id : '';
      const name = typeof tool.name === 'string' ? tool.name : 'unknown';
      results.push(
        entry(
          'assistant',
          [{ type: 'tool_use', id, name, input: parseToolInput(tool.args) }],
          source,
          id || undefined,
        ),
      );
      if ('result' in tool) {
        results.push(
          entry(
            'user',
            [
              {
                type: 'tool_result',
                tool_use_id: id,
                content: textFrom(tool.result),
                is_error: false,
              },
            ],
            source,
            id ? `${id}-result` : undefined,
          ),
        );
      }
    }
  }

  return [
    ...(assistantBlocks.length ? [entry('assistant', assistantBlocks, source)] : []),
    ...results,
  ];
}

function normalizeGrok(source: JsonRecord): JsonRecord[] {
  if (source.type === 'system') return [];
  const role = source.type;
  if (role !== 'user' && role !== 'assistant') return [];
  const blocks = geminiTextBlocks(source.content);
  return blocks.length ? [entry(role, blocks, source)] : [];
}

/** Convert one native JSONL line into zero or more drawer-compatible entries. */
export function normalizeAgentStreamLine(
  runtime: AgentRuntime,
  line: string,
): JsonRecord[] {
  const source = parseJson(line);
  if (!source) return runtime === 'claude' ? [{ raw: line }] : [];

  switch (runtime) {
    case 'claude':
    case 'antigravity':
      return [source];
    case 'codex':
      return normalizeCodex(source);
    case 'gemini':
      return normalizeGemini(source);
    case 'grok':
      // Wrapper records are already normalized; native chat records are not.
      if (
        (source.type === 'user' || source.type === 'assistant') &&
        isRecord(source.message)
      ) {
        return [source];
      }
      return normalizeGrok(source);
  }
}
