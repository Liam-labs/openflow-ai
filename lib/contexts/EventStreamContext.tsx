'use client';

import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Event Types - must match backend SSE event bus (lib/event-bus.ts)
// ---------------------------------------------------------------------------

export type EventStreamType =
  | 'pm2:status'           // PM2 process list update
  | 'health:status'        // Health check results changed
  | 'collab:message'       // New message in a channel
  | 'collab:participant'   // Participant joined/left/status changed
  | 'collab:typing'        // Typing/working indicator update
  | 'collab:task'          // Task board change
  | 'loops:status'         // Ralph loop status change
  | 'ports:change'         // Listening ports changed
  | 'sessions:change'      // Session connect/disconnect
  | 'terminal:status'      // Terminal task status change
  | 'cron:status'          // Cron job list/status change
  | 'watchdog:event'       // Service watchdog action (restart, cooldown, etc.)
  | 'network:wsl-status'   // WSL2 localhost bridge health change
  | 'expert:enforcement'          // Expert sub-agent enforcement hook fired for a message
  | 'expert:enforcement:received' // Injected directive confirmed received by the target agent
  | 'error:api'            // API route error
  | 'error:collab'         // Collab system error
  | 'error:agent'          // Agent process / session error
  | 'logs:entry'           // New unified log entry (live tail)
  | 'system:restarting';   // Server about to restart (graceful SSE shutdown)

/** All known event types - used to register EventSource listeners */
const ALL_EVENT_TYPES: EventStreamType[] = [
  'pm2:status', 'health:status',
  'collab:message', 'collab:participant', 'collab:typing',
  'collab:task',
  'loops:status', 'ports:change', 'sessions:change', 'terminal:status', 'cron:status',
  'watchdog:event',
  'network:wsl-status',
  'expert:enforcement',
  'expert:enforcement:received',
  'error:api', 'error:collab', 'error:agent',
  'logs:entry',
  'system:restarting',
];

export interface EventStreamMessage<T = unknown> {
  type: EventStreamType;
  data: T;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface EventStreamContextValue {
  /** Current connection state */
  connectionState: ConnectionState;
  /** Subscribe to a specific event type. Returns unsubscribe function. */
  subscribe: <T = unknown>(type: EventStreamType, handler: (data: T, msg: EventStreamMessage<T>) => void) => () => void;
  /** Subscribe to multiple event types at once. Returns unsubscribe function. */
  subscribeMany: <T = unknown>(types: EventStreamType[], handler: (data: T, msg: EventStreamMessage<T>) => void) => () => void;
  /** Force reconnect the SSE stream */
  reconnect: () => void;
  /** Whether SSE is supported and active (vs fallback polling) */
  isSSE: boolean;
}

const EventStreamContext = createContext<EventStreamContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const SSE_URL = '/api/events';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

type Handler = (data: unknown, msg: EventStreamMessage) => void;

export function EventStreamProvider({ children }: { children: ReactNode }) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [isSSE, setIsSSE] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const listenersRef = useRef<Map<EventStreamType, Set<Handler>>>(new Map());
  // Track named handlers so we can removeEventListener before each reconnect
  const esHandlersRef = useRef<Map<EventStreamType, (e: MessageEvent) => void>>(new Map());
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Dispatch event to all matching listeners
  const dispatch = useCallback((type: EventStreamType, rawData: string) => {
    const handlers = listenersRef.current.get(type);
    if (!handlers || handlers.size === 0) return;

    try {
      const data = JSON.parse(rawData);
      const msg: EventStreamMessage = { type, data, timestamp: new Date().toISOString() };
      handlers.forEach(handler => {
        try {
          handler(data, msg);
        } catch (err) {
          console.error(`[EventStream] Handler error for ${type}:`, err);
        }
      });
    } catch {
      // Ignore malformed JSON
    }
  }, []);

  // Remove all named listeners from the current EventSource and clear the ref map
  const removeEsListeners = useCallback(() => {
    if (eventSourceRef.current) {
      for (const [eventType, handler] of esHandlersRef.current) {
        eventSourceRef.current.removeEventListener(eventType, handler);
      }
    }
    esHandlersRef.current.clear();
  }, []);

  // Close current connection and schedule reconnect
  const closeAndReconnect = useCallback(() => {
    if (eventSourceRef.current) {
      removeEsListeners();
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    if (!mountedRef.current) return;

    setConnectionState('disconnected');
    setIsSSE(false);

    // Exponential backoff
    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
    reconnectAttemptRef.current = attempt + 1;

    console.log(`[EventStream] Reconnecting in ${delay}ms (attempt ${attempt + 1})`);

    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) connect();
    }, delay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removeEsListeners]);

  // Establish SSE connection
  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      removeEsListeners();
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setConnectionState('connecting');

    const es = new EventSource(SSE_URL);
    eventSourceRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current) return;
      setConnectionState('connected');
      setIsSSE(true);
      reconnectAttemptRef.current = 0;
      console.log('[EventStream] Connected');
    };

    // Register a named event listener for each known event type.
    // The backend sends named events (event: pm2:status) which do NOT
    // trigger onmessage — they require addEventListener per type.
    // Handlers are tracked in esHandlersRef so they can be removed on reconnect.
    for (const eventType of ALL_EVENT_TYPES) {
      const handler = (e: MessageEvent) => {
        if (!mountedRef.current) return;
        dispatch(eventType, e.data);
      };
      es.addEventListener(eventType, handler);
      esHandlersRef.current.set(eventType, handler);
    }

    es.onerror = () => {
      if (!mountedRef.current) return;
      setConnectionState('error');
      closeAndReconnect();
    };
  }, [dispatch, closeAndReconnect, removeEsListeners]);

  // Connect on mount, cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (eventSourceRef.current) {
        removeEsListeners();
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to a single event type
  const subscribe = useCallback(<T = unknown>(
    type: EventStreamType,
    handler: (data: T, msg: EventStreamMessage<T>) => void
  ): (() => void) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    const wrappedHandler = handler as Handler;
    listenersRef.current.get(type)!.add(wrappedHandler);

    return () => {
      listenersRef.current.get(type)?.delete(wrappedHandler);
    };
  }, []);

  // Subscribe to multiple event types
  const subscribeMany = useCallback(<T = unknown>(
    types: EventStreamType[],
    handler: (data: T, msg: EventStreamMessage<T>) => void
  ): (() => void) => {
    const unsubs = types.map(type => subscribe<T>(type, handler));
    return () => unsubs.forEach(unsub => unsub());
  }, [subscribe]);

  // Manual reconnect (resets backoff)
  const reconnect = useCallback(() => {
    reconnectAttemptRef.current = 0;
    closeAndReconnect();
  }, [closeAndReconnect]);

  return (
    <EventStreamContext.Provider value={{ connectionState, subscribe, subscribeMany, reconnect, isSSE }}>
      {children}
    </EventStreamContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Access the event stream context directly */
export function useEventStreamContext() {
  const ctx = useContext(EventStreamContext);
  if (!ctx) {
    throw new Error('useEventStreamContext must be used within an EventStreamProvider');
  }
  return ctx;
}

/**
 * Subscribe to a specific SSE event type and maintain state.
 * Falls back to polling if SSE is disconnected.
 *
 * @param eventType - The SSE event type to listen for
 * @param options - Configuration options
 * @returns The latest data received for this event type
 */
export function useEventStream<T>(
  eventType: EventStreamType,
  options?: {
    /** Polling fallback URL - called when SSE is disconnected */
    fallbackUrl?: string;
    /** Polling interval in ms (default: 10000) */
    fallbackInterval?: number;
    /** Transform the fallback fetch response before setting state */
    fallbackTransform?: (response: unknown) => T;
    /** Initial data value */
    initialData?: T;
  }
): { data: T | undefined; isConnected: boolean; isSSE: boolean } {
  const ctx = useContext(EventStreamContext);
  const [data, setData] = useState<T | undefined>(options?.initialData);
  const fallbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fallbackTransformRef = useRef(options?.fallbackTransform);
  useEffect(() => {
    fallbackTransformRef.current = options?.fallbackTransform;
  }, [options?.fallbackTransform]);

  const isConnected = ctx?.connectionState === 'connected';
  const sseActive = ctx?.isSSE ?? false;

  // SSE subscription
  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe<T>(eventType, (newData) => {
      setData(newData);
    });
  }, [ctx, eventType]);

  // Fallback polling when SSE is not connected
  useEffect(() => {
    if (sseActive || !options?.fallbackUrl) {
      if (fallbackTimerRef.current) {
        clearInterval(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      return;
    }

    const interval = options.fallbackInterval ?? 10000;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const res = await fetch(options.fallbackUrl!, { signal: controller.signal });
        const json = await res.json();
        const transformed = fallbackTransformRef.current ? fallbackTransformRef.current(json) : json as T;
        if (!controller.signal.aborted) setData(transformed);
      } catch {
        // Silently ignore polling errors
      }
    };

    poll(); // Immediate first poll
    fallbackTimerRef.current = setInterval(poll, interval);

    return () => {
      controller.abort();
      if (fallbackTimerRef.current) {
        clearInterval(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  }, [sseActive, options?.fallbackUrl, options?.fallbackInterval]);

  return { data, isConnected: isConnected ?? false, isSSE: sseActive };
}

/**
 * Subscribe to multiple SSE event types with a single handler.
 * Useful for components that react to several related events.
 */
export function useEventStreamMulti<T>(
  eventTypes: EventStreamType[],
  handler: (data: T, msg: EventStreamMessage<T>) => void
): { isConnected: boolean; isSSE: boolean } {
  const ctx = useContext(EventStreamContext);

  const isConnected = ctx?.connectionState === 'connected';
  const sseActive = ctx?.isSSE ?? false;

  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribeMany<T>(eventTypes, handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, ...eventTypes]);

  return { isConnected: isConnected ?? false, isSSE: sseActive };
}
