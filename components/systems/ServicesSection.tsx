'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Server, RefreshCw,
  ChevronRight, GripVertical, HardDrive,
  Globe, Wrench, Brain, Activity, Network, Bot, Code2, Zap, Film,
} from 'lucide-react';
import { ServiceDetail } from './ServiceDetail';
import {
  DndContext, DragOverlay, useSensor, useSensors, PointerSensor,
  useDraggable, useDroppable,
} from '@dnd-kit/core';
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core';
import { StatusBadge } from './DataTable';
import { useEventStream } from '@/lib/contexts/EventStreamContext';
import { useToast } from '@/lib/contexts/ToastContext';
import type { Project, PM2Process, PM2Response, ProjectCategory } from '@/lib/types';
import type { SystemsNavState, ContextPanelEntity, ServiceTab } from './systems-types';
import { SectionLoadingSkeleton } from './SectionLoadingSkeleton';

// ─── Row shape ────────────────────────────────────────────────────────────────

interface ServiceRow {
  id: string;
  name: string;
  status: string;
  category: string;
  port: number | null;
  pid: number | null;
  uptime: string;
  cpu: number | null;
  memory: string;
  memoryBytes: number | null;
  restarts: number | null;
  pm2Name: string | null;
  project: Project;
  pm2: PM2Process | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMem(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mergeRows(projects: Project[], processes: PM2Process[]): ServiceRow[] {
  const pm2Map = new Map<string, PM2Process>(processes.map(p => [p.name, p]));
  return projects
    .filter(p => p.server)
    .map(project => {
      const pm2Name = project.server?.pm2Name ?? null;
      const proc = pm2Name ? pm2Map.get(pm2Name) ?? null : null;
      const status = proc?.status ?? 'stopped';
      return {
        id: project.id,
        name: project.name,
        status,
        category: project.category,
        port: proc?.port ?? project.server?.port ?? null,
        pid: proc?.pid ?? null,
        uptime: proc?.uptimeFormatted ?? '—',
        cpu: proc?.cpu ?? null,
        memory: fmtMem(proc?.memory ?? null),
        memoryBytes: proc?.memory ?? null,
        restarts: proc?.restarts ?? null,
        pm2Name,
        project,
        pm2: proc,
      };
    });
}

const CATEGORY_COLOURS: Record<string, string> = {
  development:    '#3b82f6',
  automation:     '#8b5cf6',
  media:          '#ec4899',
  ai:             '#06b6d4',
  monitoring:     '#22c55e',
  infrastructure: '#f97316',
  agent:          '#a855f7',
  service:        '#3b82f6',
  server:         '#f97316',
  tool:           '#71717a',
  site:           '#22c55e',
  api:            '#06b6d4',
  default:        '#71717a',
};
function catColour(cat: string) { return CATEGORY_COLOURS[cat.toLowerCase()] ?? CATEGORY_COLOURS.default; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LucideIcon = React.ComponentType<any>;

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  development:    Code2,
  automation:     Zap,
  media:          Film,
  ai:             Brain,
  monitoring:     Activity,
  infrastructure: Network,
  agent:          Bot,
  service:        Server,
  server:         HardDrive,
  tool:           Wrench,
  site:           Globe,
  api:            Code2,
  default:        Server,
};
function catIcon(cat: string): LucideIcon {
  return CATEGORY_ICONS[cat.toLowerCase()] ?? CATEGORY_ICONS.default;
}

// ─── Compact service card ─────────────────────────────────────────────────────

function SvcCard({
  row, selected, onClick, onRename, dragHandleProps,
}: {
  row: ServiceRow;
  selected: boolean;
  onClick: () => void;
  onRename: (row: ServiceRow, newName: string) => Promise<void>;
  dragHandleProps?: React.HTMLAttributes<HTMLSpanElement>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(row.name);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const colour = catColour(row.category);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(row.name);
    setIsEditing(true);
    setTimeout(() => { inputRef.current?.select(); }, 10);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setEditValue(row.name);
  };

  const commitEdit = async () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === row.name) { cancelEdit(); return; }
    setIsSaving(true);
    try {
      await onRename(row, trimmed);
    } finally {
      setIsSaving(false);
      setIsEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') { cancelEdit(); }
  };

  return (
    <div
      className={`svc-card${selected ? ' svc-card--selected' : ''}${isEditing ? ' svc-card--editing' : ''}`}
      style={{ '--svc-cat-colour': colour } as React.CSSProperties}
      onClick={isEditing ? undefined : onClick}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onKeyDown={isEditing ? undefined : e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      {/* Drag handle */}
      {dragHandleProps && (
        <span className="svc-card__drag-handle" {...dragHandleProps} aria-label="Drag to reorder">
          <GripVertical size={11} />
        </span>
      )}
      {/* Category icon */}
      {React.createElement(catIcon(row.category), {
        size: 12,
        'aria-hidden': true,
        className: 'svc-card__cat-icon',
        style: { color: colour, flexShrink: 0 },
      })}
      {/* Name — inline edit on double-click */}
      {isEditing ? (
        <input
          ref={inputRef}
          className="svc-card__name-input"
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={handleKeyDown}
          disabled={isSaving}
          aria-label="Rename service"
          onClick={e => e.stopPropagation()}
        />
      ) : (
        <span
          className="svc-card__name"
          title={row.name}
          onDoubleClick={startEdit}
        >
          {row.name}
        </span>
      )}
      {/* Port — only stat shown on compact card */}
      {!isEditing && row.port !== null && (
        <span className="svc-card__stat svc-card__stat--port">:{row.port}</span>
      )}
      {/* Status badge */}
      <StatusBadge status={row.status} />
    </div>
  );
}

// ─── Draggable card wrapper ───────────────────────────────────────────────────

function DraggableSvcCard({
  row, selected, onClick, onRename,
}: {
  row: ServiceRow;
  selected: boolean;
  onClick: () => void;
  onRename: (row: ServiceRow, newName: string) => Promise<void>;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: row.id,
    data: { row },
  });

  return (
    <div ref={setNodeRef} style={isDragging ? { opacity: 0 } : undefined}>
      <SvcCard
        row={row}
        selected={selected}
        onClick={onClick}
        onRename={onRename}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

// ─── Droppable group body ─────────────────────────────────────────────────────

function DroppableGroupBody({
  category, children, activeDragCategory,
}: {
  category: string;
  children: React.ReactNode;
  activeDragCategory: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${category}` });
  const isDifferentGroup = activeDragCategory !== null && activeDragCategory !== category;

  return (
    <div
      ref={setNodeRef}
      className={`svc-group__body${isOver && isDifferentGroup ? ' svc-group__body--drop-target' : ''}`}
    >
      {children}
    </div>
  );
}

// ─── Filter chip ──────────────────────────────────────────────────────────────

function FilterChip({
  label, active, count, onClick, variant = 'default',
}: {
  label: string; active: boolean; count?: number; onClick: () => void;
  variant?: 'default' | 'success' | 'error' | 'warning';
}) {
  const isError = variant === 'error';
  return (
    <button
      className={`svc-filter-chip svc-filter-chip--${variant}${active ? ' svc-filter-chip--active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      {isError && <span className="svc-filter-chip__pulse" aria-hidden="true" />}
      {label}
      {count !== undefined && <span className="svc-filter-chip__count">{count}</span>}
    </button>
  );
}

// ─── Status filters ───────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { value: 'all',     label: 'All' },
  { value: 'online',  label: 'Online',  variant: 'success' as const },
  { value: 'stopped', label: 'Stopped' },
  { value: 'errored', label: 'Errored', variant: 'error' as const },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]['value'];

// ─── Component ────────────────────────────────────────────────────────────────

interface ServicesSectionProps {
  onNavigate: (partial: Partial<SystemsNavState>) => void;
  onEntitySelect: (entity: ContextPanelEntity) => void;
}

export function ServicesSection({ onNavigate, onEntitySelect }: ServicesSectionProps) {
  void onNavigate;
  void onEntitySelect;

  const { toast } = useToast();

  const [projects, setProjects]         = useState<Project[]>([]);
  const [processes, setProcesses]       = useState<PM2Process[]>([]);
  const [isLoading, setIsLoading]       = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [selectedTab, setSelectedTab]   = useState<ServiceTab>('overview');
  const [dragItem, setDragItem]         = useState<ServiceRow | null>(null);

  // DnD sensors — require 8px movement to distinguish click from drag
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const { data: sseData } = useEventStream<PM2Response>('pm2:status', {
    fallbackUrl: '/api/pm2',
    fallbackInterval: 10000,
  });

  useEffect(() => {
    if (sseData?.processes) setProcesses(sseData.processes);
  }, [sseData]);

  const fetchAll = useCallback(async () => {
    try {
      const [pm2Res, projRes] = await Promise.all([fetch('/api/pm2'), fetch('/api/projects')]);
      const pm2Data: PM2Response = await pm2Res.json();
      const projData = await projRes.json();
      setProcesses(pm2Data.processes ?? []);
      setProjects(Array.isArray(projData) ? projData : projData.projects ?? []);
    } catch {
      // SSE keeps us live
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const rows = useMemo(() => mergeRows(projects, processes), [projects, processes]);

  const grouped = useMemo(() => {
    const filtered = statusFilter === 'all' ? rows : rows.filter(r => r.status === statusFilter);
    const map = new Map<string, ServiceRow[]>();
    for (const row of filtered) {
      if (!map.has(row.category)) map.set(row.category, []);
      map.get(row.category)!.push(row);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cat, items]) => ({ cat, rows: items.sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [rows, statusFilter]);

  const onlineCount  = rows.filter(r => r.status === 'online').length;
  const stoppedCount = rows.filter(r => r.status === 'stopped').length;
  const erroredCount = rows.filter(r => r.status === 'errored').length;

  const toggleGroup = useCallback((cat: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }, []);

  // ─── Optimistic project update (used by inline edit + DnD) ───────────────────

  const handleProjectUpdate = useCallback(async (
    projectId: string,
    updates: { name?: string; category?: string; description?: string }
  ) => {
    // Snapshot for rollback
    const prev = projects.find(p => p.id === projectId);
    if (!prev) return;

    // Optimistic
    setProjects(ps => ps.map(p => {
      if (p.id !== projectId) return p;
      return {
        ...p,
        ...(updates.name        !== undefined && { name:        updates.name }),
        ...(updates.description !== undefined && { description: updates.description }),
        ...(updates.category    !== undefined && { category:    updates.category as ProjectCategory }),
      };
    }));

    try {
      const res = await fetch('/api/projects', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, ...updates }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? 'Update failed');
      }
      if (updates.name) toast.success(`Renamed to "${updates.name}"`);
      else if (updates.category) toast.success(`Moved to ${updates.category}`);
      else toast.success('Updated');
    } catch (err) {
      // Rollback
      setProjects(ps => ps.map(p =>
        p.id === projectId ? prev : p
      ));
      toast.error(err instanceof Error ? err.message : 'Update failed');
    }
  }, [projects, toast]);

  // ─── DnD handlers ────────────────────────────────────────────────────────────

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const row = rows.find(r => r.id === event.active.id);
    setDragItem(row ?? null);
  }, [rows]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    setDragItem(null);

    if (!over) return;

    const overId = String(over.id);
    if (!overId.startsWith('group:')) return;

    const newCategory = overId.replace('group:', '');
    const row = rows.find(r => r.id === String(active.id));
    if (!row || row.category === newCategory) return;

    await handleProjectUpdate(row.id, { category: newCategory });
  }, [rows, handleProjectUpdate]);

  if (isLoading) return <SectionLoadingSkeleton rows={8} />;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="systems-section">
        {/* Header */}
        <div className="systems-section__header">
          <div className="systems-section__title-group">
            <Server size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <h2 className="systems-section__title">Services</h2>
            <span className="systems-section__count">{rows.length}</span>
            <span className="svc-stat-inline">
              <span className="svc-stat-inline__dot svc-stat-inline__dot--online" />
              {onlineCount} online
            </span>
            {erroredCount > 0 && (
              <span className="svc-stat-inline svc-stat-inline--error">
                <span className="svc-stat-inline__dot svc-stat-inline__dot--error" />
                {erroredCount} errored
              </span>
            )}
          </div>
          <button className="systems-section__btn" onClick={fetchAll} aria-label="Refresh" title="Refresh">
            <RefreshCw size={13} />
          </button>
        </div>

        {/* Filter bar */}
        <div className="svc-filter-bar">
          <span className="svc-filter-bar__label">Cluster Status:</span>
          <div className="svc-filter-group">
            {STATUS_FILTERS.map(sf => (
              <FilterChip
                key={sf.value}
                label={sf.label}
                active={statusFilter === sf.value}
                count={
                  sf.value === 'all'     ? rows.length :
                  sf.value === 'online'  ? onlineCount  :
                  sf.value === 'stopped' ? stoppedCount :
                  erroredCount
                }
                onClick={() => setStatusFilter(sf.value)}
                variant={'variant' in sf ? sf.variant : 'default'}
              />
            ))}
          </div>
        </div>

        {/* 2-column split */}
        <div className="svc-split">
          {/* Left: service list */}
          <div className="svc-split__list">
            {grouped.length === 0 ? (
              <div className="svc-empty">No services match the current filter.</div>
            ) : grouped.map(({ cat, rows: catRows }) => {
              const isOpen = !collapsedGroups.has(cat);
              const catOnline  = catRows.filter(r => r.status === 'online').length;
              const catErrored = catRows.filter(r => r.status === 'errored').length;
              const colour = catColour(cat);
              return (
                <div key={cat} className="svc-group">
                  <div
                    className="svc-group__header"
                    style={{ '--svc-cat-colour': colour } as React.CSSProperties}
                    onClick={() => toggleGroup(cat)}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(cat); } }}
                  >
                    <span className={`svc-group__chevron${isOpen ? ' svc-group__chevron--open' : ''}`}>
                      <ChevronRight size={12} />
                    </span>
                    <span className="svc-group__cat-name">{cat}</span>
                    <span className="svc-group__count">{catRows.length}</span>
                    {catOnline > 0 && (
                      <span className="svc-group__stat svc-group__stat--online">{catOnline} online</span>
                    )}
                    {catErrored > 0 && (
                      <span className="svc-group__stat svc-group__stat--errored">{catErrored} errored</span>
                    )}
                  </div>
                  {isOpen && (
                    <DroppableGroupBody
                      category={cat}
                      activeDragCategory={dragItem?.category ?? null}
                    >
                      {catRows.map(row => (
                        <DraggableSvcCard
                          key={row.id}
                          row={row}
                          selected={selectedId === row.id}
                          onClick={() => { setSelectedId(prev => prev === row.id ? null : row.id); setSelectedTab('overview'); }}
                          onRename={(r, newName) => handleProjectUpdate(r.id, { name: newName })}
                        />
                      ))}
                    </DroppableGroupBody>
                  )}
                </div>
              );
            })}
          </div>

          {/* Right: full inline detail */}
          <div className="svc-split__detail">
            {selectedId ? (
              <ServiceDetail
                serviceId={selectedId}
                tab={selectedTab}
                onTabChange={setSelectedTab}
                onBack={() => setSelectedId(null)}
              />
            ) : (
              <div className="svc-detail-empty">
                <Server size={32} aria-hidden="true" />
                <p>Select a service to inspect</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Drag overlay — ghost card while dragging */}
      <DragOverlay dropAnimation={null}>
        {dragItem ? (
          <div className="svc-card svc-card--drag-ghost" style={{
            '--svc-cat-colour': catColour(dragItem.category),
            opacity: 0.85,
            transform: 'rotate(1.5deg)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            pointerEvents: 'none',
          } as React.CSSProperties}>
            <GripVertical size={11} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            {React.createElement(catIcon(dragItem.category), {
              size: 12, 'aria-hidden': true,
              style: { color: catColour(dragItem.category), flexShrink: 0 },
            })}
            <span className="svc-card__name">{dragItem.name}</span>
            <StatusBadge status={dragItem.status} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
