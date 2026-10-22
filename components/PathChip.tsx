'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { File, Folder } from 'lucide-react';
import { getDisplayName, isDirectoryPath, openInWindows } from '@/lib/path-chip-helpers';

interface PathChipProps {
  /** Absolute Linux path, or relative path for display */
  path: string;
  /** Resolved absolute path for click/reveal actions (when path is relative) */
  resolvedPath?: string;
  /** Override directory detection heuristic */
  isDirectory?: boolean;
  /** Human-readable label for a named Markdown link. */
  label?: string;
}

/**
 * Inline clickable path chip.
 * - Click → show the location in Windows File Explorer (file selected)
 * - Right-click → context menu: "Open" (default app) or "Show in File Explorer"
 * - Enter/Space → same as click
 * - Disabled on error with tooltip
 */
export default function PathChip({ path, resolvedPath, isDirectory: isDirOverride, label }: PathChipProps) {
  const clickTarget = resolvedPath ?? path;
  const isDir = isDirOverride ?? isDirectoryPath(clickTarget);
  const displayName = getDisplayName(path);
  const chipRef = useRef<HTMLSpanElement>(null);

  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const handleOpen = useCallback(async () => {
    if (status === 'loading') return;
    setStatus('loading');
    const result = await openInWindows(clickTarget, 'open');
    if (result.ok) {
      setStatus('idle');
    } else {
      setStatus('error');
      setErrorMsg(result.error || 'Failed to open');
      // Auto-clear error after 4s
      setTimeout(() => { setStatus('idle'); setErrorMsg(''); }, 4000);
    }
  }, [clickTarget, status]);

  const handleReveal = useCallback(async () => {
    setCtxMenu(null);
    if (status === 'loading') return;
    setStatus('loading');
    const result = await openInWindows(clickTarget, 'reveal');
    if (result.ok) {
      setStatus('idle');
    } else {
      setStatus('error');
      setErrorMsg(result.error || 'Failed to reveal');
      setTimeout(() => { setStatus('idle'); setErrorMsg(''); }, 4000);
    }
  }, [clickTarget, status]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleReveal();
    }
  }, [handleReveal]);

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!ctxMenu) return;

    const close = () => setCtxMenu(null);
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

    document.addEventListener('click', close);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [ctxMenu]);

  const Icon = isDir ? Folder : File;

  const stateClass = status === 'error'
    ? 'path-chip--error'
    : status === 'loading'
      ? 'path-chip--loading'
      : '';

  const tooltip = status === 'error' ? errorMsg : clickTarget;

  return (
    <>
      <span
        ref={chipRef}
        className={`path-chip ${stateClass}`}
        role="button"
        tabIndex={0}
        title={tooltip}
        aria-label={`Show in File Explorer: ${clickTarget}`}
        onClick={handleReveal}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <Icon className="path-chip__icon" aria-hidden="true" />
        <span className="path-chip__name">{label ?? displayName}</span>
      </span>

      {ctxMenu && createPortal(
        <div
          className="path-chip-ctx"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          aria-label="Path actions"
        >
          <button
            className="path-chip-ctx__item"
            role="menuitem"
            onClick={handleOpen}
          >
            Open
          </button>
          <button
            className="path-chip-ctx__item"
            role="menuitem"
            onClick={handleReveal}
          >
            Show in File Explorer
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
