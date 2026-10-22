/**
 * Sprint 36 Phase 2 — Agent Live-Feed Viewer
 *
 * Pure helpers for transforming raw Claude Code JSONL entries into renderable
 * StreamItems. Kept framework-free so they can be unit-tested with vitest
 * without a DOM environment.
 */

import {
  normalizeToolResult,
  summarizeToolInput,
} from '@/lib/agent-stream-interpret/utils';
import type {
  RawContentBlock,
  RawMessageEntry,
  StreamItem,
  StreamItemKind,
} from './types';

/**
 * Flatten a single raw JSONL entry into zero or more renderable stream items.
 *
 * Rules:
 *   - `user`/`assistant` with `message.content` as string → single 'text' item
 *   - `user`/`assistant` with `message.content` as array → one item per block
 *   - `system` → single 'system' item (best-effort text extraction)
 *   - `summary` → single 'summary' item from `entry.summary`
 *   - Unknown/malformed entries → empty array (never throws)
 *
 * The `baseId` falls back to the entry uuid, then to a random token so React
 * keys stay stable. Block index is appended to disambiguate multi-block
 * entries.
 */
export function flattenEntry(entry: RawMessageEntry): StreamItem[] {
  if (!entry || typeof entry !== 'object') return [];

  const baseId = entry.uuid || stableEntryId(entry);
  const ts = typeof entry.timestamp === 'string' ? entry.timestamp : '';
  const role = normalizeRole(entry.type);

  if (entry.type === 'summary') {
    const text = typeof entry.summary === 'string' ? entry.summary : '';
    if (!text) return [];
    return [
      {
        id: `${baseId}:0`,
        kind: 'summary',
        role: 'summary',
        timestamp: ts,
        text,
      },
    ];
  }

  if (entry.type === 'system') {
    const content = entry.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : extractFirstText(content) || '';
    if (!text) return [];
    return [
      {
        id: `${baseId}:0`,
        kind: 'system',
        role: 'system',
        timestamp: ts,
        text,
      },
    ];
  }

  // user / assistant
  const content = entry.message?.content;
  if (typeof content === 'string') {
    if (!content) return [];
    return [
      {
        id: `${baseId}:0`,
        kind: 'text',
        role,
        timestamp: ts,
        text: content,
      },
    ];
  }

  if (!Array.isArray(content)) return [];

  const items: StreamItem[] = [];
  content.forEach((block, idx) => {
    const item = blockToStreamItem(block, `${baseId}:${idx}`, role, ts);
    if (item) items.push(item);
  });
  return items;
}

function blockToStreamItem(
  block: RawContentBlock | unknown,
  id: string,
  role: StreamItem['role'],
  timestamp: string,
): StreamItem | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as { type?: string } & Record<string, unknown>;

  switch (b.type) {
    case 'text': {
      const text = typeof b.text === 'string' ? b.text : '';
      if (!text) return null;
      return { id, kind: 'text', role, timestamp, text };
    }
    case 'thinking': {
      const text = typeof b.thinking === 'string' ? b.thinking : '';
      if (!text) return null;
      return { id, kind: 'thinking', role, timestamp, text };
    }
    case 'tool_use': {
      const name = typeof b.name === 'string' ? b.name : 'unknown';
      const input =
        b.input && typeof b.input === 'object'
          ? (b.input as Record<string, unknown>)
          : {};
      const toolUseId = typeof b.id === 'string' ? b.id : '';
      return {
        id,
        kind: 'tool_use',
        role,
        timestamp,
        toolName: name,
        toolInput: input,
        toolUseId,
      };
    }
    case 'tool_result': {
      const toolUseId =
        typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
      const raw = (b as { content?: unknown }).content;
      const text = normalizeToolResult(raw);
      const isError =
        typeof (b as { is_error?: unknown }).is_error === 'boolean'
          ? ((b as { is_error: boolean }).is_error)
          : false;
      return {
        id,
        kind: 'tool_result',
        role,
        timestamp,
        toolUseId,
        toolResultText: text,
        toolResultIsError: isError,
      };
    }
    default:
      return null;
  }
}

// Sprint 5: normalizeToolResult relocated to lib/agent-stream-interpret/utils.ts
// (imported above, re-exported below for backwards compatibility).
export { normalizeToolResult };

function extractFirstText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const b of content) {
    if (b && typeof b === 'object') {
      const obj = b as { type?: string; text?: string };
      if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
    }
  }
  return '';
}

function normalizeRole(
  type: RawMessageEntry['type'],
): StreamItem['role'] {
  switch (type) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'summary':
      return type;
    default:
      return 'assistant';
  }
}

function stableEntryId(entry: RawMessageEntry): string {
  // FNV-1a gives replayed JSONL records the same fallback ID after an SSE
  // reconnect. This is not a security boundary; it is a compact UI identity.
  const value = JSON.stringify(entry);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(36)}`;
}

/** Append only IDs not already observed during the current subscription. */
export function appendUniqueItems(
  current: StreamItem[],
  incoming: StreamItem[],
  seenIds: Set<string>,
  maxItems: number,
): StreamItem[] {
  const unique: StreamItem[] = [];
  for (const item of incoming) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    unique.push(item);
  }
  if (unique.length === 0) return current;
  const next = [...current, ...unique];
  if (next.length > maxItems) {
    const removed = next.splice(0, next.length - maxItems);
    for (const item of removed) seenIds.delete(item.id);
  }
  return next;
}

/**
 * Filter a list of items for the Summary view. Removes all `thinking` items;
 * everything else passes through unchanged.
 */
export function filterForSummary(items: StreamItem[]): StreamItem[] {
  return items.filter((i) => i.kind !== 'thinking' && i.kind !== 'raw');
}

/**
 * Build an index mapping tool_use_id → the tool_use item, used by renderers
 * to show the originating tool name on a tool_result card.
 */
export function buildToolUseIndex(
  items: StreamItem[],
): Map<string, StreamItem> {
  const map = new Map<string, StreamItem>();
  for (const i of items) {
    if (i.kind === 'tool_use' && i.toolUseId) {
      map.set(i.toolUseId, i);
    }
  }
  return map;
}

/**
 * Short wall-clock time for a timestamp (HH:MM:SS, 24h). Returns '' if the
 * input is missing or unparseable. Uses en-GB so the format is predictable
 * across locales.
 */
export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

// Sprint 5: summarizeToolInput relocated to lib/agent-stream-interpret/utils.ts
// (imported above, re-exported below for backwards compatibility).
export { summarizeToolInput };

export type { StreamItem, StreamItemKind } from './types';
