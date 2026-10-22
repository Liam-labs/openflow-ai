'use client';

/**
 * TaskColumn - Kanban column for tasks with drag-drop support
 */

import React, { useState, useRef } from 'react';
import { Plus, User, Trash2, MessageSquare, Copy, CheckCheck } from 'lucide-react';
import type { CollabTask, CollabTaskStatus, CollabTaskPriority, CollabParticipant } from '@/lib/types';

interface TaskColumnProps {
  title: string;
  status: CollabTaskStatus;
  tasks: CollabTask[];
  channelId: string;
  participantId: string;
  participants: CollabParticipant[];
  onTaskStatusChange: (taskId: string, newStatus: CollabTaskStatus) => void;
  onTaskUpdate: () => void;
  onDiscussTask?: (task: CollabTask) => void;
  onTaskClick?: (task: CollabTask) => void;
  sprintId?: string;
  phaseId?: string;
}

export function TaskColumn({
  title,
  status,
  tasks,
  channelId,
  participantId,
  participants,
  onTaskStatusChange,
  onTaskUpdate,
  onDiscussTask,
  onTaskClick,
  sprintId,
  phaseId,
}: TaskColumnProps) {
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState<CollabTaskPriority>('normal');
  const [dragOver, setDragOver] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);

  // Inline title editing
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Copy task text to clipboard
  const handleCopyTask = async (task: CollabTask) => {
    const text = task.description ? `${task.title}\n${task.description}` : task.title;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTaskId(task.id);
      setTimeout(() => setCopiedTaskId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Save inline title edit
  const handleTitleSave = async (taskId: string) => {
    const trimmed = editTitle.trim();
    setEditingTaskId(null);
    if (!trimmed || trimmed === tasks.find(t => t.id === taskId)?.title) return;
    try {
      await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          channelId,
          participantId,
          taskId,
          title: trimmed,
        }),
      });
      onTaskUpdate();
    } catch (err) {
      console.error('Failed to update title:', err);
    }
  };

  // Create task
  const handleCreateTask = async () => {
    if (!newTaskTitle.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          channelId,
          participantId,
          title: newTaskTitle,
          priority: newTaskPriority,
          sprintId,
          phaseId,
        }),
      });
      if (res.ok) {
        setNewTaskTitle('');
        setNewTaskPriority('normal');
        setShowAddTask(false);
        onTaskUpdate();
      }
    } catch (err) {
      console.error('Failed to create task:', err);
    } finally {
      setCreating(false);
    }
  };

  // Claim task
  const handleClaimTask = async (taskId: string) => {
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim', channelId, participantId, taskId }),
      });
      if (res.ok) onTaskUpdate();
    } catch (err) {
      console.error('Failed to claim task:', err);
    }
  };

  // Complete task
  const handleCompleteTask = async (taskId: string) => {
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete', channelId, participantId, taskId }),
      });
      if (res.ok) onTaskUpdate();
    } catch (err) {
      console.error('Failed to complete task:', err);
    }
  };

  // Delete task
  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Delete this task?')) return;
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', channelId, participantId, taskId }),
      });
      if (res.ok) {
        onTaskUpdate();
      } else {
        const body = await res.json().catch(() => null);
        const msg = body?.error || `${res.status} ${res.statusText}`;
        // eslint-disable-next-line no-alert
        alert(`Delete failed: ${msg}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Drag handlers — disabled while editing a title
  const handleDragStart = (e: React.DragEvent, task: CollabTask) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('taskId', task.id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const taskId = e.dataTransfer.getData('taskId');
    if (taskId) onTaskStatusChange(taskId, status);
  };

  // Participant helpers
  const getParticipantName = (id?: string) => {
    if (!id) return 'Unassigned';
    return participants.find(p => p.id === id)?.name || 'Unknown';
  };

  // Task state is a shape, not a colour (Midnight Glass: closed status vocabulary).
  const StatusMark = () => (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.5" opacity={status === 'todo' ? 1 : 0.35} />
      {status === 'in_progress' && (
        <path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
      {status === 'done' && (
        <>
          <circle cx="8" cy="8" r="6.2" fill="currentColor" opacity="0.2" stroke="currentColor" strokeWidth="1.5" />
          <path d="m5.2 8.3 1.9 1.9 3.7-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );

  // Priority is bars (1 low, 2 normal, 3 high) with a text label for assistive tech.
  const priorityLevel = (priority: CollabTaskPriority) => (priority === 'high' ? 3 : priority === 'low' ? 1 : 2);
  const priorityLabel = (priority: CollabTaskPriority) => (priority === 'high' ? 'High' : priority === 'low' ? 'Low' : 'Normal');

  const laneClass = { todo: 'sb-lane--todo', in_progress: 'sb-lane--doing', done: 'sb-lane--done' }[status];

  return (
    <div className={`sb-lane ${laneClass}${dragOver ? ' sb-lane--over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Lane header */}
      <div className="sb-lh">
        <StatusMark />
        <h4 style={{ margin: 0, font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit' }}>{title}</h4>
        <span className="sb-n">{tasks.length}</span>
        {/* Add-task button present on ALL lanes */}
        <button
          type="button"
          onClick={() => setShowAddTask(!showAddTask)}
          className="sb-add"
          title="Add task"
          aria-label={`Add task to ${title}`}
          aria-expanded={showAddTask}
        >
          <Plus />
        </button>
      </div>

      {/* Add Task Form: available on all lanes, status defaults to the lane's status */}
      {showAddTask && (
        <div className="sb-form">
          <input
            type="text"
            placeholder="Task title…"
            aria-label="Task title"
            value={newTaskTitle}
            onChange={e => setNewTaskTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) handleCreateTask();
              if (e.key === 'Escape') { setShowAddTask(false); setNewTaskTitle(''); }
            }}
            className="sb-input"
            autoFocus
          />
          <div className="sb-form-row">
            <div className="sb-seg" role="radiogroup" aria-label="Priority">
              {(['low', 'normal', 'high'] as CollabTaskPriority[]).map(p => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={newTaskPriority === p}
                  onClick={() => setNewTaskPriority(p)}
                >
                  {priorityLabel(p)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleCreateTask}
              disabled={!newTaskTitle.trim() || creating}
              className="mg-btn"
              style={{ marginLeft: 'auto' }}
            >
              {creating ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={() => { setShowAddTask(false); setNewTaskTitle(''); }}
              className="mg-btn mg-btn--ghost"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Tasks */}
      <div className="sb-stack">
        {tasks.length === 0 && !showAddTask && <div className="sb-empty">No tasks</div>}

        {tasks.map((task, index) => {
          const isAssignedToMe = task.assigneeId === participantId;
          const canClaim = !task.assigneeId && status === 'todo';
          const canComplete = isAssignedToMe && status === 'in_progress';
          const assigneeName = getParticipantName(task.assigneeId);
          const isEditing = editingTaskId === task.id;
          const level = priorityLevel(task.priority);

          return (
            <div
              key={task.id}
              draggable={!isEditing}
              onDragStart={!isEditing ? e => handleDragStart(e, task) : undefined}
              /* Clicking anywhere on the card opens the detail pane,
                 unless the user is mid-edit on the inline title input */
              onClick={(!isEditing && onTaskClick) ? () => onTaskClick(task) : undefined}
              className={`sb-card${status === 'in_progress' ? ' sb-card--doing' : ''}`}
              style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
            >
              {/* Hover toolbar: all stopPropagation so they do not trigger the card click */}
              <div className="sb-tool">
                {onDiscussTask && (
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); onDiscussTask(task); }}
                    title="Discuss in channel"
                    aria-label="Discuss in channel"
                  >
                    <MessageSquare />
                  </button>
                )}
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); handleCopyTask(task); }}
                  title="Copy task text"
                  aria-label="Copy task text"
                  className={copiedTaskId === task.id ? 'ok' : undefined}
                >
                  {copiedTaskId === task.id ? <CheckCheck /> : <Copy />}
                  {copiedTaskId === task.id && 'Copied'}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={e => { e.stopPropagation(); handleDeleteTask(task.id); }}
                  title="Delete task"
                  aria-label="Delete task"
                >
                  <Trash2 />
                </button>
              </div>

              <div className="sb-card-top">
                {/* Inline-editable title */}
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    autoFocus
                    value={editTitle}
                    aria-label="Task title"
                    onChange={e => setEditTitle(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleTitleSave(task.id);
                      if (e.key === 'Escape') setEditingTaskId(null);
                    }}
                    onBlur={() => handleTitleSave(task.id)}
                    className="sb-edit"
                    /* stopPropagation so clicking into the edit input doesn't trigger card onClick */
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <h5
                    className="sb-card-title"
                    /* stopPropagation: title click starts inline edit, not detail pane */
                    onClick={e => { e.stopPropagation(); setEditingTaskId(task.id); setEditTitle(task.title); }}
                    title="Click to edit title. Click elsewhere on the card to open details."
                  >
                    {task.title}
                  </h5>
                )}
              </div>

              {task.description && <p className="sb-desc">{task.description}</p>}

              <div className="sb-foot">
                <div className="sb-who">
                  {task.assigneeId ? (
                    <span className="sb-av" aria-hidden="true">{assigneeName.charAt(0).toUpperCase()}</span>
                  ) : (
                    <span className="sb-av sb-av--none" aria-hidden="true"><User /></span>
                  )}
                  <span>{assigneeName}</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
                  {canClaim && (
                    <button
                      type="button"
                      className="sb-go"
                      onClick={e => { e.stopPropagation(); handleClaimTask(task.id); }}
                    >
                      <User />
                      Claim
                    </button>
                  )}
                  {canComplete && (
                    <button
                      type="button"
                      className="sb-go sb-go--solid"
                      onClick={e => { e.stopPropagation(); handleCompleteTask(task.id); }}
                    >
                      Complete
                    </button>
                  )}
                  <span
                    className={`sb-prio${level === 3 ? ' sb-prio--high' : ''}`}
                    role="img"
                    aria-label={`${priorityLabel(task.priority)} priority`}
                    title={`${priorityLabel(task.priority)} priority`}
                  >
                    {[1, 2, 3].map(n => <i key={n} className={n <= level ? 'on' : undefined} />)}
                  </span>
                </div>
              </div>

              {task.tags && task.tags.length > 0 && (
                <div className="sb-tags">
                  {task.tags.map((tag, idx) => (
                    <span key={idx} className="sb-tag">{tag}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
