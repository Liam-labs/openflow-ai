'use client';

/**
 * Sprint 36 Phase 2 — Agent Live-Feed Viewer
 *
 * Thin EventSource wrapper that subscribes to GET /api/agent-stream?agent=<name>
 * and flattens raw Claude Code JSONL entries into a rolling list of StreamItems.
 *
 * Event envelope (frozen in Phase 1):
 *   event: meta       — one-shot, { agent, path, resolvedVia }
 *   event: message    — per JSONL line, RAW entry as data
 *   event: heartbeat  — every 15s, ignored in UI
 *   event: error      — unrecoverable, close EventSource
 *   event: rotated    — file rotated, informational only
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { appendUniqueItems, flattenEntry } from './helpers';
import type {
  MetaEvent,
  RawMessageEntry,
  RotatedEvent,
  StreamErrorEvent,
  StreamItem,
} from './types';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'error'
  | 'closed';

export interface UseAgentStreamResult {
  items: StreamItem[];
  meta: MetaEvent | null;
  connectionState: ConnectionState;
  error: string | null;
  /** Null until an empty state is appropriate (after meta arrives, no items). */
  rotatedPath: string | null;
  reset: () => void;
}

/** Hard cap on retained items — prevents unbounded memory. */
const MAX_ITEMS = 500;

/**
 * Builds the EventSource URL for /api/agent-stream.
 * Exported for unit testing.
 */
export function buildAgentStreamUrl(
  agent: string,
  channelId: string | null | undefined,
  endpoint: string,
): string {
  const url = `${endpoint}?agent=${encodeURIComponent(agent)}`;
  return channelId ? `${url}&channelId=${encodeURIComponent(channelId)}` : url;
}

/**
 * Subscribe to an agent's live feed. Passing `agent = null` tears down any
 * existing EventSource without opening a new one.
 *
 * `endpoint` is injectable for tests/mocks.
 */
export function useAgentStream(
  agent: string | null,
  channelId: string | null | undefined = null,
  endpoint = '/api/agent-stream',
): UseAgentStreamResult {
  const [items, setItems] = useState<StreamItem[]>([]);
  const [meta, setMeta] = useState<MetaEvent | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [rotatedPath, setRotatedPath] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const seenItemIdsRef = useRef<Set<string>>(new Set());

  const reset = useCallback(() => {
    seenItemIdsRef.current.clear();
    setItems([]);
    setMeta(null);
    setError(null);
    setRotatedPath(null);
    setConnectionState('idle');
  }, []);

  useEffect(() => {
    if (!agent) {
      esRef.current?.close();
      esRef.current = null;
      return;
    }

    // Fresh subscription: clear carry-over state from the previous agent.
    seenItemIdsRef.current.clear();
    setItems([]);
    setMeta(null);
    setError(null);
    setRotatedPath(null);
    setConnectionState('connecting');

    const url = buildAgentStreamUrl(agent, channelId, endpoint);
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('open', () => {
      setConnectionState('open');
    });

    es.addEventListener('meta', (ev: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(ev.data) as MetaEvent;
        setMeta(parsed);
      } catch {
        /* tolerate malformed meta */
      }
    });

    es.addEventListener('message', (ev: MessageEvent<string>) => {
      try {
        const raw = JSON.parse(ev.data) as RawMessageEntry;
        const flat = flattenEntry(raw);
        if (flat.length === 0) return;
        setItems((prev) =>
          appendUniqueItems(prev, flat, seenItemIdsRef.current, MAX_ITEMS),
        );
      } catch {
        /* tolerate malformed JSONL line */
      }
    });

    es.addEventListener('heartbeat', () => {
      /* intentionally ignored */
    });

    // Raw log lines from antigravity agents (agy --print wrapper log tail).
    // The backend emits these as SSE event type 'raw' with the line text as data.
    es.addEventListener('raw', (ev: MessageEvent<string>) => {
      const text = typeof ev.data === 'string' ? ev.data : '';
      if (!text) return;
      const item: StreamItem = {
        id: `raw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind: 'raw',
        role: 'system',
        timestamp: new Date().toISOString(),
        text,
      };
      setItems((prev) => {
        const next = [...prev, item];
        if (next.length > MAX_ITEMS) next.splice(0, next.length - MAX_ITEMS);
        return next;
      });
    });

    es.addEventListener('rotated', (ev: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(ev.data) as RotatedEvent;
        setRotatedPath(parsed.newPath || 'rotated');
      } catch {
        setRotatedPath('rotated');
      }
    });

    es.addEventListener('error', (ev: MessageEvent<string>) => {
      // Two flavours: server-emitted 'error' events carry JSON; transport
      // errors have no data and trigger this same handler with readyState set.
      let msg = 'Stream error';
      if (typeof ev.data === 'string' && ev.data) {
        try {
          const parsed = JSON.parse(ev.data) as StreamErrorEvent;
          msg = parsed.message || msg;
        } catch {
          msg = ev.data;
        }
      } else if (es.readyState === EventSource.CLOSED) {
        msg = 'Connection closed';
      } else if (es.readyState === EventSource.CONNECTING) {
        msg = 'Reconnecting…';
        setConnectionState('connecting');
        return;
      }
      setError(msg);
      setConnectionState('error');
      es.close();
    });

    return () => {
      es.close();
      esRef.current = null;
      setConnectionState('closed');
    };
  }, [agent, channelId, endpoint]);

  return { items, meta, connectionState, error, rotatedPath, reset };
}
