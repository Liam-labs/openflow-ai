'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, ChevronUp, ChevronDown, User, Clock, Circle, Check } from 'lucide-react';
import type { CollabTask, CollabParticipant } from '@/lib/types';

interface TaskDetailPaneProps {
  task: CollabTask;
  allTasks: CollabTask[];
  participants: CollabParticipant[];
  channelId: string;
  participantId: string;
  onClose: () => void;
  onTaskUpdate: () => void;
  onNavigate: (task: CollabTask) => void;
}

export function TaskDetailPane({
  task,
  allTasks,
  participants,
  channelId,
  participantId,
  onClose,
  onTaskUpdate,
  onNavigate,
}: TaskDetailPaneProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [notes, setNotes] = useState(task.notes || '');
  const [resolution, setResolution] = useState(task.resolution || '');
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const currentIndex = allTasks.findIndex(t => t.id === task.id);

  // Sync fields when task changes
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description || '');
    setNotes(task.notes || '');
    setResolution(task.resolution || '');
  }, [task.id]);

  // Keyboard navigation — only when focus is NOT inside a textarea/input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const inField = tag === 'TEXTAREA' || tag === 'INPUT';

      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (inField) return;

      if (e.key === 'ArrowUp' && currentIndex > 0) {
        e.preventDefault();
        onNavigate(allTasks[currentIndex - 1]);
      }
      if (e.key === 'ArrowDown' && currentIndex < allTasks.length - 1) {
        e.preventDefault();
        onNavigate(allTasks[currentIndex + 1]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, allTasks, onClose, onNavigate]);

  const handleSave = useCallback(async () => {
    const trimmedTitle = title.trim();
    const trimmedDesc = description.trim();
    if (!trimmedTitle) {
      setTitle(task.title);
      return;
    }
    if (trimmedTitle === task.title && trimmedDesc === (task.description || '')) return;

    setSaving(true);
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          channelId,
          participantId,
          taskId: task.id,
          title: trimmedTitle,
          description: trimmedDesc || undefined,
        }),
      });
      if (res.ok) onTaskUpdate();
    } catch (err) {
      console.error('Failed to save task:', err);
    } finally {
      setSaving(false);
    }
  }, [title, description, task, channelId, participantId, onTaskUpdate]);

  // Save just notes (claimer's progress notes) on blur
  const handleNotesSave = useCallback(async () => {
    const trimmed = notes.trim();
    if (trimmed === (task.notes || '')) return;
    setSaving(true);
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update', channelId, participantId, taskId: task.id,
          notes: trimmed || undefined,
        }),
      });
      if (res.ok) onTaskUpdate();
    } catch (err) {
      console.error('Failed to save notes:', err);
    } finally {
      setSaving(false);
    }
  }, [notes, task, channelId, participantId, onTaskUpdate]);

  // Save resolution (final outcome) on blur
  const handleResolutionSave = useCallback(async () => {
    const trimmed = resolution.trim();
    if (trimmed === (task.resolution || '')) return;
    setSaving(true);
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update', channelId, participantId, taskId: task.id,
          resolution: trimmed || undefined,
        }),
      });
      if (res.ok) onTaskUpdate();
    } catch (err) {
      console.error('Failed to save resolution:', err);
    } finally {
      setSaving(false);
    }
  }, [resolution, task, channelId, participantId, onTaskUpdate]);

  const handleFieldUpdate = useCallback(async (fields: { status?: string; priority?: string; assigneeId?: string }) => {
    setSaving(true);
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          channelId,
          participantId,
          taskId: task.id,
          ...fields,
        }),
      });
      if (res.ok) onTaskUpdate();
    } catch (err) {
      console.error('Failed to update task field:', err);
    } finally {
      setSaving(false);
    }
  }, [task.id, channelId, participantId, onTaskUpdate]);

  const getParticipantName = (id?: string) => {
    if (!id) return 'Unassigned';
    return participants.find(p => p.id === id)?.name || 'Unknown';
  };

  const statusConfig = {
    todo: { label: 'To Do', Icon: Circle, cls: 'text-white/80' },
    in_progress: { label: 'In Progress', Icon: Clock, cls: 'text-blue-400' },
    done: { label: 'Done', Icon: Check, cls: 'text-green-400' },
  };

  const priorityConfig = {
    high: { label: 'High', cls: 'text-red-400 bg-red-500/10 border-red-500/20' },
    normal: { label: 'Normal', cls: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
    low: { label: 'Low', cls: 'text-white/75 bg-white/[0.04] border-white/[0.10]' },
  };

  const sConf = statusConfig[task.status] ?? statusConfig.todo;
  const pConf = priorityConfig[task.priority] ?? priorityConfig.normal;

  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />

      {/* Pane */}
      <div className="task-detail-pane fixed right-0 top-0 bottom-0 z-50 w-[440px] bg-[#0b1625] border-l border-white/[0.08] flex flex-col shadow-[-24px_0_48px_rgba(0,0,0,0.4)]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-white/75 tabular-nums font-medium">
              {currentIndex + 1} / {allTasks.length}
            </span>
            <div className="flex gap-0.5">
              <button
                onClick={() => currentIndex > 0 && onNavigate(allTasks[currentIndex - 1])}
                disabled={currentIndex === 0}
                className="p-1 rounded hover:bg-white/[0.06] disabled:opacity-25 disabled:cursor-not-allowed transition-all"
                title="Previous task (↑)"
              >
                <ChevronUp className="w-3.5 h-3.5 text-white/75" />
              </button>
              <button
                onClick={() =>
                  currentIndex < allTasks.length - 1 && onNavigate(allTasks[currentIndex + 1])
                }
                disabled={currentIndex === allTasks.length - 1}
                className="p-1 rounded hover:bg-white/[0.06] disabled:opacity-25 disabled:cursor-not-allowed transition-all"
                title="Next task (↓)"
              >
                <ChevronDown className="w-3.5 h-3.5 text-white/75" />
              </button>
            </div>
            <span className="text-[10px] text-white/50 hidden sm:inline">ESC closes · ↑↓ navigates</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/[0.06] text-white/60 hover:text-white/90 transition-all"
            title="Close (Escape)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto sprint-board-scroll px-5 py-5 space-y-5">
          {/* Title */}
          <div>
            <label className="text-[10px] font-semibold text-white/60 uppercase tracking-widest">
              Title
            </label>
            <textarea
              ref={titleRef}
              value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={handleSave}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  titleRef.current?.blur();
                }
              }}
              rows={2}
              className="mt-2 w-full text-sm font-medium text-white/90 bg-white/[0.04] border border-white/[0.07] rounded-lg px-3 py-2.5 focus:outline-none focus:border-blue-500/40 focus:bg-white/[0.06] resize-none transition-all"
            />
          </div>

          {/* Meta grid — Status and Priority are interactive */}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold text-white/60 uppercase tracking-widest">Status</label>
              <div className="relative">
                <div className={`pointer-events-none absolute inset-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.12] text-xs ${sConf.cls}`}>
                  <sConf.Icon className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{sConf.label}</span>
                </div>
                <select
                  value={task.status}
                  onChange={e => handleFieldUpdate({ status: e.target.value })}
                  className="relative w-full h-[30px] opacity-0 cursor-pointer"
                  aria-label="Change status"
                >
                  <option value="todo">To Do</option>
                  <option value="in_progress">In Progress</option>
                  <option value="done">Done</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold text-white/60 uppercase tracking-widest">Priority</label>
              <div className="relative">
                <div className={`pointer-events-none absolute inset-0 px-2.5 py-1.5 rounded-lg border-2 text-xs font-medium ${pConf.cls}`}>
                  {pConf.label}
                </div>
                <select
                  value={task.priority}
                  onChange={e => handleFieldUpdate({ priority: e.target.value })}
                  className="relative w-full h-[30px] opacity-0 cursor-pointer"
                  aria-label="Change priority"
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold text-white/60 uppercase tracking-widest">Assignee</label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.10] text-xs text-white/85 overflow-hidden">
                  <User className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{getParticipantName(task.assigneeId)}</span>
                </div>
                <select
                  value={task.assigneeId || ''}
                  onChange={e => handleFieldUpdate({ assigneeId: e.target.value })}
                  className="relative w-full h-[30px] opacity-0 cursor-pointer"
                  aria-label="Change assignee"
                >
                  <option value="">Unassigned</option>
                  {participants.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-[10px] font-semibold text-white/60 uppercase tracking-widest">
              Description
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              onBlur={handleSave}
              placeholder="Add a description..."
              rows={5}
              className="mt-2 w-full text-sm text-white/85 bg-white/[0.04] border border-white/[0.10] rounded-lg px-3 py-2.5 focus:outline-none focus:border-blue-500/40 focus:bg-white/[0.06] resize-none placeholder-white/35 transition-all"
            />
          </div>

          {/* Notes — free-form progress log from the claimer */}
          <div>
            <label className="text-[10px] font-semibold text-white/60 uppercase tracking-widest">
              Notes <span className="text-white/40 normal-case font-normal">(progress log — what's been tried, what's blocked)</span>
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              onBlur={handleNotesSave}
              placeholder="What did you do on this task? Any blockers, partial progress, decisions made..."
              rows={4}
              className="mt-2 w-full text-sm text-white/85 bg-white/[0.04] border border-white/[0.10] rounded-lg px-3 py-2.5 focus:outline-none focus:border-blue-500/40 focus:bg-white/[0.06] resize-none placeholder-white/35 transition-all"
            />
          </div>

          {/* Resolution — final outcome, what was actually shipped */}
          <div>
            <label className="text-[10px] font-semibold text-white/60 uppercase tracking-widest">
              Resolution <span className="text-white/40 normal-case font-normal">(final outcome)</span>
            </label>
            <textarea
              value={resolution}
              onChange={e => setResolution(e.target.value)}
              onBlur={handleResolutionSave}
              placeholder="What did this ship as? Final commit, link, decision summary..."
              rows={3}
              className="mt-2 w-full text-sm text-white/85 bg-white/[0.04] border border-white/[0.10] rounded-lg px-3 py-2.5 focus:outline-none focus:border-blue-500/40 focus:bg-white/[0.06] resize-none placeholder-white/35 transition-all"
            />
          </div>

          {/* Tags */}
          {task.tags && task.tags.length > 0 && (
            <div>
              <label className="text-[10px] font-semibold text-white/60 uppercase tracking-widest">Tags</label>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {task.tags.map((tag, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 bg-purple-500/10 text-purple-400/70 border border-purple-500/15 rounded text-[11px] font-medium"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div className="text-[11px] text-white/60 space-y-1 pt-2 border-t border-white/[0.08]">
            <div>Created {fmt(task.createdAt)}</div>
            <div>Updated {fmt(task.updatedAt)}</div>
            {task.completedAt && <div>Completed {fmt(task.completedAt)}</div>}
            <div className="text-[10px] font-mono text-white/40 mt-1">{task.id}</div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-5 py-2.5 border-t border-white/[0.04] min-h-[36px]">
          {saving ? (
            <span className="text-[11px] text-white/75 animate-pulse">Saving…</span>
          ) : (
            <span className="text-[11px] text-white/50">Changes save on blur</span>
          )}
        </div>
      </div>
    </>
  );
}
