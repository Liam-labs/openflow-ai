'use client';

import { useEffect, useRef } from 'react';

// ─── Public interface ─────────────────────────────────────────────────────────

export type LogsTimePreset = '1h' | '6h' | '24h' | '7d';

export interface LogsKeyboardActions {
  /** j — move selection down one row */
  onMoveDown: () => void;
  /** k — move selection up one row */
  onMoveUp: () => void;
  /** Enter or ArrowRight — expand the selected row */
  onExpand: () => void;
  /** Escape or ArrowLeft — collapse the selected row */
  onCollapse: () => void;
  /** g — open the go-to-time picker */
  onOpenTimePicker: () => void;
  /** / — focus the search input */
  onFocusSearch: () => void;
  /** L — toggle live tail on/off */
  onToggleLive: () => void;
  /** 1=1h, 6=6h, d=24h, w=7d — apply a time range preset */
  onSetTimePreset: (preset: LogsTimePreset) => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useLogsKeyboard
 *
 * Registers keyboard shortcuts for the Logs Dashboard.
 * Shortcuts are suppressed when focus is on an input, textarea, select,
 * or contenteditable element — except Escape, which always fires.
 *
 * Shortcuts:
 *   j / k         — move selection down / up
 *   Enter / →     — expand selected row
 *   Esc / ←       — collapse selected row
 *   g             — open time picker (go to time)
 *   /             — focus search input (preventDefault to block browser search)
 *   L             — toggle live tail
 *   1             — set time range to Last 1h
 *   6             — set time range to Last 6h
 *   d             — set time range to Last 24h
 *   w             — set time range to Last 7d
 *
 * @param actions  Callback handlers — updated on every render via ref (no stale closures)
 * @param active   Set to false to disable all shortcuts (e.g., when a modal is open)
 */
export function useLogsKeyboard(
  actions: LogsKeyboardActions,
  active = true,
): void {
  // Keep latest actions in a ref so the registered handler never goes stale
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (!active) return;

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;

      const a = actionsRef.current;

      switch (e.key) {
        // ── Navigation ────────────────────────────────────────────
        case 'j':
          if (!inInput) { e.preventDefault(); a.onMoveDown(); }
          break;
        case 'k':
          if (!inInput) { e.preventDefault(); a.onMoveUp(); }
          break;

        // ── Expand / collapse ─────────────────────────────────────
        case 'Enter':
          if (!inInput) { e.preventDefault(); a.onExpand(); }
          break;
        case 'ArrowRight':
          if (!inInput) { e.preventDefault(); a.onExpand(); }
          break;
        case 'Escape':
          // Always fires — also closes dialogs/drawers
          e.preventDefault();
          a.onCollapse();
          break;
        case 'ArrowLeft':
          if (!inInput) { e.preventDefault(); a.onCollapse(); }
          break;

        // ── Time / search ─────────────────────────────────────────
        case 'g':
          if (!inInput) { e.preventDefault(); a.onOpenTimePicker(); }
          break;
        case '/':
          if (!inInput) { e.preventDefault(); a.onFocusSearch(); }
          break;

        // ── Live tail ─────────────────────────────────────────────
        case 'L':
          if (!inInput) { e.preventDefault(); a.onToggleLive(); }
          break;

        // ── Time range presets ────────────────────────────────────
        case '1':
          if (!inInput) { e.preventDefault(); a.onSetTimePreset('1h'); }
          break;
        case '6':
          if (!inInput) { e.preventDefault(); a.onSetTimePreset('6h'); }
          break;
        case 'd':
          if (!inInput) { e.preventDefault(); a.onSetTimePreset('24h'); }
          break;
        case 'w':
          if (!inInput) { e.preventDefault(); a.onSetTimePreset('7d'); }
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active]);
}
