'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useEventStreamContext } from '@/lib/contexts/EventStreamContext';
import type { UnifiedLogEntry } from '@/lib/log-types';

// Max entries retained in the live tail buffer to avoid memory growth
const MAX_TAIL_ENTRIES = 500;

// ─── Public interface ─────────────────────────────────────────────────────────

export interface UseLogsTailResult {
  /** New log entries received via SSE while live tail is active */
  tailEntries: UnifiedLogEntry[];
  /** Whether live tail is currently streaming */
  isLive: boolean;
  /** Count of entries buffered while paused (user scrolled away) */
  pendingCount: number;
  /**
   * Turn live tail on. Drains any pending (buffered-while-paused) entries
   * into tailEntries and resets the pending counter.
   * Call this when the user clicks the "Resume" button.
   */
  enableLive: () => void;
  /**
   * Turn live tail off without discarding entries. Incoming entries will
   * accumulate in the pending buffer instead.
   * Call this from your scroll handler when the user scrolls up.
   */
  disableLive: () => void;
  /**
   * Clear the tail buffer and reset pending count.
   * Call this when the user changes filters or time range to avoid
   * stale live entries mixing with fresh query results.
   */
  clearEntries: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useLogsTail
 *
 * Subscribes to the `logs:entry` SSE stream for real-time log display.
 * Manages a rolling buffer of live entries (max 500) and tracks how many
 * entries arrived while the user was scrolled away from the bottom.
 *
 * Usage in LogsSection:
 *   const { tailEntries, isLive, pendingCount, enableLive, disableLive } = useLogsTail();
 *   // Merge tailEntries into your main entries list for display
 *   // Auto-scroll to bottom while isLive is true
 *   // Show "Resume (N new)" button when !isLive && pendingCount > 0
 *   // Call disableLive() from your VariableSizeList onScroll handler
 *   // Call enableLive() when user clicks the Resume button
 *   // Call clearEntries() on filter/time-range change
 */
export function useLogsTail(): UseLogsTailResult {
  const [tailEntries, setTailEntries] = useState<UnifiedLogEntry[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Refs to avoid stale closures in the SSE handler
  const isLiveRef = useRef(false);
  const pendingRef = useRef<UnifiedLogEntry[]>([]);

  const { subscribe } = useEventStreamContext();

  const enableLive = useCallback(() => {
    isLiveRef.current = true;
    setIsLive(true);

    // Drain any buffered-while-paused entries into the tail
    if (pendingRef.current.length > 0) {
      setTailEntries(prev => {
        const combined = [...prev, ...pendingRef.current];
        return combined.slice(-MAX_TAIL_ENTRIES);
      });
      pendingRef.current = [];
    }

    setPendingCount(0);
  }, []);

  const disableLive = useCallback(() => {
    isLiveRef.current = false;
    setIsLive(false);
  }, []);

  const clearEntries = useCallback(() => {
    setTailEntries([]);
    pendingRef.current = [];
    setPendingCount(0);
  }, []);

  // Subscribe to logs:entry SSE events
  useEffect(() => {
    return subscribe<UnifiedLogEntry>('logs:entry', (entry) => {
      if (isLiveRef.current) {
        // Live mode: append to visible buffer, capped at MAX_TAIL_ENTRIES
        setTailEntries(prev => {
          const next = [...prev, entry];
          return next.slice(-MAX_TAIL_ENTRIES);
        });
      } else {
        // Paused: accumulate in pending buffer, update counter
        pendingRef.current = [...pendingRef.current, entry];
        setPendingCount(pendingRef.current.length);
      }
    });
  }, [subscribe]);

  return { tailEntries, isLive, pendingCount, enableLive, disableLive, clearEntries };
}
