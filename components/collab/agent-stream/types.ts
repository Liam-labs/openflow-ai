/**
 * Sprint 36 Phase 2 — Agent Live-Feed Viewer
 *
 * Types for normalized runtime transcript entries streamed by Agent Live View.
 * The server converts Claude, Codex, Gemini, Grok, and Antigravity
 * records to this common envelope before the drawer sees them.
 */

export type RawContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | Array<{ type: string; text?: string; source?: unknown }>;
      is_error?: boolean;
    };

export interface RawMessageEntry {
  type: 'user' | 'assistant' | 'system' | 'summary';
  message?: {
    role?: string;
    content?: string | RawContentBlock[];
  };
  timestamp?: string;
  uuid?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface MetaEvent {
  agent: string;
  path: string;
  runtime: 'claude' | 'gemini' | 'grok' | 'codex' | 'antigravity';
  resolvedVia: string;
}

export interface RotatedEvent {
  newPath: string;
}

export interface StreamErrorEvent {
  message: string;
}

export type StreamItemKind =
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'text'
  | 'system'
  | 'summary'
  | 'raw';

/**
 * Flattened, renderable item. One RawMessageEntry may produce zero, one, or
 * many StreamItems (one per content block, or one wrapping a plain string).
 */
export interface StreamItem {
  /** Stable unique id for React keys — derived from entry uuid + block index. */
  id: string;
  kind: StreamItemKind;
  role: 'user' | 'assistant' | 'system' | 'summary';
  timestamp: string;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** Present on tool_use (source id) AND tool_result (matches back). */
  toolUseId?: string;
  toolResultText?: string;
  toolResultIsError?: boolean;
}
