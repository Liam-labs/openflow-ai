'use client';

import React, { useState, useCallback, useRef } from 'react';
import { HardDrive, RefreshCw, ChevronRight, Home, FolderOpen } from 'lucide-react';
import { DataTable } from './DataTable';
import type { ColumnDef } from './DataTable';
import { SectionLoadingSkeleton } from './SectionLoadingSkeleton';
import type { DiskEntry } from '@/app/api/disk/scan/route';

interface ScanResponse {
  entries: DiskEntry[];
  path: string;
  totalBytes: number;
  totalHuman: string;
  scanMs: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  entry: DiskEntry;
}

export function DiskManagementSection() {
  const [path, setPath] = useState('/');
  const [history, setHistory] = useState<string[]>(['/']);
  const [data, setData] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const scan = useCallback(async (targetPath: string) => {
    setLoading(true);
    setError(null);
    setContextMenu(null);
    try {
      const res = await fetch('/api/disk/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: targetPath }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Scan failed');
      setData(json as ScanResponse);
      setPath(targetPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  React.useEffect(() => { scan('/'); }, [scan]);

  // Dismiss context menu on outside click
  React.useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler, { capture: true });
    return () => window.removeEventListener('click', handler, { capture: true });
  }, [contextMenu]);

  const navigateTo = useCallback((targetPath: string) => {
    setHistory(prev => [...prev, targetPath]);
    scan(targetPath);
  }, [scan]);

  const navigateBack = useCallback(() => {
    if (history.length <= 1) return;
    const newHistory = history.slice(0, -1);
    setHistory(newHistory);
    scan(newHistory[newHistory.length - 1]);
  }, [history, scan]);

  const openInExplorer = useCallback(async (entryPath: string) => {
    setOpeningPath(entryPath);
    try {
      await fetch('/api/disk/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: entryPath }),
      });
    } finally {
      setOpeningPath(null);
    }
  }, []);

  // Breadcrumb segments from current path
  const breadcrumbs = React.useMemo(() => {
    const parts = path.split('/').filter(Boolean);
    const segments: { label: string; path: string }[] = [{ label: 'root', path: '/' }];
    for (let i = 0; i < parts.length; i++) {
      segments.push({
        label: parts[i],
        path: '/' + parts.slice(0, i + 1).join('/'),
      });
    }
    return segments;
  }, [path]);

  const columns: ColumnDef<DiskEntry>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      render: (entry) => (
        <div className="disk-name-cell">
          <FolderOpen size={13} className="disk-name-cell__icon" aria-hidden="true" />
          <span className="disk-name-cell__label">{entry.name}</span>
        </div>
      ),
      getValue: (entry) => entry.name,
    },
    {
      key: 'sizeHuman',
      header: 'Size',
      sortable: true,
      align: 'right',
      render: (entry) => (
        <div className="disk-size-cell">
          <span className="disk-size-cell__bar-wrap">
            <span
              className="disk-size-cell__bar"
              style={{
                width: `${data ? Math.min(100, (entry.sizeBytes / (data.entries[0]?.sizeBytes || 1)) * 100) : 0}%`,
              }}
              aria-hidden="true"
            />
          </span>
          <span className="disk-size-cell__label">{entry.sizeHuman}</span>
        </div>
      ),
      getValue: (entry) => entry.sizeBytes,
    },
    {
      key: 'type',
      header: 'Type',
      sortable: true,
      render: (entry) => <span className="disk-type-badge">{entry.type}</span>,
      getValue: (entry) => entry.type,
    },
  ];

  return (
    <div
      className="systems-section disk-section"
      ref={containerRef}
      onClick={() => setContextMenu(null)}
    >
      {/* Header */}
      <div className="systems-section__header">
        <div className="systems-section__title-group">
          <HardDrive size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <h2 className="systems-section__title">Disk Management</h2>
          {data && (
            <span className="systems-section__count">{data.entries.length} entries</span>
          )}
          {data && (
            <span className="disk-total-size">{data.totalHuman} total · scanned in {data.scanMs}ms</span>
          )}
        </div>
        <button
          className="systems-section__btn"
          onClick={() => scan(path)}
          disabled={loading}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw size={13} className={loading ? 'sjs-spin' : ''} />
        </button>
      </div>

      {/* Breadcrumb */}
      <nav className="disk-breadcrumb" aria-label="Path navigation">
        {history.length > 1 && (
          <button className="disk-breadcrumb__back" onClick={navigateBack} title="Go back">
            <ChevronRight size={12} style={{ transform: 'rotate(180deg)' }} />
          </button>
        )}
        {breadcrumbs.map((seg, i) => (
          <React.Fragment key={seg.path}>
            {i === 0 ? (
              <button
                className="disk-breadcrumb__seg disk-breadcrumb__seg--home"
                onClick={() => navigateTo('/')}
                title="/"
              >
                <Home size={12} />
              </button>
            ) : (
              <button
                className={`disk-breadcrumb__seg${i === breadcrumbs.length - 1 ? ' disk-breadcrumb__seg--current' : ''}`}
                onClick={i < breadcrumbs.length - 1 ? () => navigateTo(seg.path) : undefined}
                disabled={i === breadcrumbs.length - 1}
              >
                {seg.label}
              </button>
            )}
            {i < breadcrumbs.length - 1 && (
              <ChevronRight size={10} className="disk-breadcrumb__sep" aria-hidden="true" />
            )}
          </React.Fragment>
        ))}
      </nav>

      {/* Table */}
      {loading && !data ? (
        <SectionLoadingSkeleton rows={10} />
      ) : (
        <DataTable
          columns={columns}
          data={data?.entries ?? []}
          rowKey={(e) => e.path}
          onRowClick={(entry) => { if (entry.type === 'dir') navigateTo(entry.path); }}
          pageSize={50}
          initialSort={{ key: 'sizeHuman', direction: 'desc' }}
          emptyMessage={error ?? 'No entries found'}
          // Right-click via wrapper div around rows isn't possible through DataTable API;
          // we intercept at the section level via a global contextmenu listener
        />
      )}

      {error && !loading && (
        <div className="systems-section__error" style={{ marginTop: 8 }}>{error}</div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="disk-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <button
            className={`disk-context-menu__item${openingPath === contextMenu.entry.path ? ' disk-context-menu__item--loading' : ''}`}
            onClick={() => { openInExplorer(contextMenu.entry.path); setContextMenu(null); }}
            disabled={openingPath !== null}
            role="menuitem"
          >
            <FolderOpen size={12} />
            Open in Windows Explorer
          </button>
        </div>
      )}

      {/* Right-click listener — attached to section container */}
      <RightClickCapture
        containerRef={containerRef}
        entries={data?.entries ?? []}
        onContextMenu={(entry, x, y) => setContextMenu({ x, y, entry })}
      />
    </div>
  );
}

// Attaches a contextmenu listener to the container and resolves which row was clicked
function RightClickCapture({
  containerRef,
  entries,
  onContextMenu,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  entries: DiskEntry[];
  onContextMenu: (entry: DiskEntry, x: number, y: number) => void;
}) {
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (e: MouseEvent) => {
      // Walk up from target to find a table row
      let node = e.target as HTMLElement | null;
      while (node && node !== el) {
        if (node.tagName === 'TR') {
          // Find which entry corresponds to this row by matching displayed name text
          const nameEl = node.querySelector('.disk-name-cell__label');
          if (nameEl) {
            const name = nameEl.textContent ?? '';
            const entry = entriesRef.current.find(en => en.name === name);
            if (entry) {
              e.preventDefault();
              onContextMenu(entry, e.clientX, e.clientY);
              return;
            }
          }
        }
        node = node.parentElement;
      }
    };

    el.addEventListener('contextmenu', handler);
    return () => el.removeEventListener('contextmenu', handler);
  }, [containerRef, onContextMenu]);

  return null;
}
