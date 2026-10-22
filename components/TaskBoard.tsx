'use client';

/**
 * TaskBoard - Kanban-style task board for collaboration channels
 *
 * Features:
 * - Create, claim, complete tasks
 * - Three columns: Todo, In Progress, Done
 * - Real-time updates via polling
 * - Integration with activity status
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Check,
  Circle,
  Clock,
  Loader2,
  X,
  User,
  GripVertical,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Filter,
  Edit2,
  Trash2,
  Tag,
} from 'lucide-react';
import type {
  CollabTask,
  CollabTaskStatus,
  CollabTaskPriority,
  CollabParticipant,
} from '@/lib/types';

interface TaskBoardProps {
  channelId: string;
  participantId: string;
  participants: CollabParticipant[];
  compact?: boolean;
}

export function TaskBoard({ channelId, participantId, participants, compact = false }: TaskBoardProps) {
  const [tasks, setTasks] = useState<CollabTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDescription, setNewTaskDescription] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState<CollabTaskPriority>('normal');
  
  // Edit Modal State
  const [editingTask, setEditingTask] = useState<CollabTask | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPriority, setEditPriority] = useState<CollabTaskPriority>('normal');

  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draggedTask, setDraggedTask] = useState<CollabTask | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<CollabTaskStatus | null>(null);

  // Filters
  const [filterAssignee, setFilterAssignee] = useState<string>('all');
  const [filterPriority, setFilterPriority] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);

  // Fetch tasks
  const fetchTasks = useCallback(async () => {
    if (!channelId) return;

    try {
      const res = await fetch(`/api/collab/tasks?channelId=${channelId}`);
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
        setError(null);
      }
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
      setError('Failed to load tasks');
    }
  }, [channelId]);

  // Initial fetch and polling
  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 5000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  // Create task
  const handleCreateTask = async () => {
    if (!newTaskTitle.trim()) return;

    setLoading(true);
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          channelId,
          participantId,
          title: newTaskTitle.trim(),
          description: newTaskDescription.trim(),
          priority: newTaskPriority,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.task) {
          setTasks(prev => [...prev, data.task]);
        }
        setNewTaskTitle('');
        setNewTaskDescription('');
        setNewTaskPriority('normal');
        setShowAddTask(false);
      }
    } catch (err) {
      console.error('Failed to create task:', err);
    } finally {
      setLoading(false);
    }
  };

  // Update task
  const handleUpdateTask = async () => {
    if (!editingTask || !editTitle.trim()) return;

    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          channelId,
          participantId,
          taskId: editingTask.id,
          title: editTitle.trim(),
          description: editDescription.trim(),
          priority: editPriority,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.task) {
          setTasks(prev => prev.map(t => t.id === editingTask.id ? data.task : t));
        }
        setEditingTask(null);
      }
    } catch (err) {
      console.error('Failed to update task:', err);
    }
  };

  // Open Edit Modal
  const openEditModal = (task: CollabTask) => {
    setEditingTask(task);
    setEditTitle(task.title);
    setEditDescription(task.description || '');
    setEditPriority(task.priority);
  };

  // Claim task
  const handleClaimTask = async (taskId: string) => {
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'claim',
          channelId,
          participantId,
          taskId,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.task) {
          setTasks(prev => prev.map(t => t.id === taskId ? data.task : t));

          // Update activity status to 'working'
          await fetch('/api/collab', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'heartbeat',
              channelId,
              participantId,
              status: 'online',
            }),
          });
        }
      }
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
        body: JSON.stringify({
          action: 'complete',
          channelId,
          participantId,
          taskId,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.task) {
          setTasks(prev => prev.map(t => t.id === taskId ? data.task : t));
        }
      }
    } catch (err) {
      console.error('Failed to complete task:', err);
    }
  };

  // Unclaim task
  const handleUnclaimTask = async (taskId: string) => {
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'unclaim',
          channelId,
          participantId,
          taskId,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.task) {
          setTasks(prev => prev.map(t => t.id === taskId ? data.task : t));
        }
      }
    } catch (err) {
      console.error('Failed to unclaim task:', err);
    }
  };

  // Delete task (creator only)
  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Are you sure you want to delete this task?')) return;

    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          channelId,
          participantId,
          taskId,
        }),
      });

      if (res.ok) {
        setTasks(prev => prev.filter(t => t.id !== taskId));
        if (editingTask?.id === taskId) setEditingTask(null);
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

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, task: CollabTask) => {
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  };

  const handleDragEnd = () => {
    setDraggedTask(null);
    setDragOverColumn(null);
  };

  const handleDragOver = (e: React.DragEvent, status: CollabTaskStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(status);
  };

  const handleDragLeave = () => {
    setDragOverColumn(null);
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: CollabTaskStatus) => {
    e.preventDefault();
    setDragOverColumn(null);

    if (!draggedTask) return;

    // Calculate new sort order (add to end of column)
    const columnTasks = tasks.filter(t => t.status === targetStatus);
    const maxSortOrder = columnTasks.reduce((max, t) => Math.max(max, t.sortOrder ?? 0), 0);
    const newSortOrder = maxSortOrder + 1;

    // Optimistic update
    setTasks(prev => prev.map(t =>
      t.id === draggedTask.id
        ? { ...t, status: targetStatus, sortOrder: newSortOrder }
        : t
    ));

    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reorder',
          channelId,
          participantId,
          taskId: draggedTask.id,
          sortOrder: newSortOrder,
          targetStatus,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.task) {
          setTasks(prev => prev.map(t => t.id === draggedTask.id ? data.task : t));
        }
      } else {
        // Revert on failure
        fetchTasks();
      }
    } catch (err) {
      console.error('Failed to reorder task:', err);
      fetchTasks();
    }

    setDraggedTask(null);
  };

  // Get participant name by ID
  const getParticipantName = (pId: string): string => {
    const p = participants.find(p => p.id === pId);
    return p?.name || 'Unknown';
  };

  // Get participant color by ID
  const getParticipantColor = (pId: string): string => {
    const p = participants.find(p => p.id === pId);
    return p?.color || '#8B5CF6';
  };

  // Apply filters
  const applyFilters = (taskList: CollabTask[]) => {
    return taskList.filter(t => {
      // Assignee filter
      if (filterAssignee !== 'all') {
        if (filterAssignee === 'mine' && t.assigneeId !== participantId) return false;
        if (filterAssignee === 'unassigned' && t.assigneeId) return false;
        if (filterAssignee !== 'mine' && filterAssignee !== 'unassigned' && t.assigneeId !== filterAssignee) return false;
      }
      // Priority filter
      if (filterPriority !== 'all' && t.priority !== filterPriority) return false;
      return true;
    });
  };

  const hasActiveFilters = filterAssignee !== 'all' || filterPriority !== 'all';

  // Group tasks by status (with filters applied)
  const todoTasks = applyFilters(tasks.filter(t => t.status === 'todo'));
  const inProgressTasks = applyFilters(tasks.filter(t => t.status === 'in_progress'));
  const doneTasks = applyFilters(tasks.filter(t => t.status === 'done'));

  // Priority colors
  const priorityColors: Record<CollabTaskPriority, string> = {
    high: 'text-red-400 bg-red-500/20',
    normal: 'text-blue-400 bg-blue-500/20',
    low: 'text-gray-400 bg-gray-500/20',
  };

  // Task card component
  const TaskCard = ({ task }: { task: CollabTask }) => {
    const isAssignedToMe = task.assigneeId === participantId;
    const isMyTask = task.createdBy === participantId;
    const isDragging = draggedTask?.id === task.id;

    return (
      <div
        draggable
        onDragStart={(e) => handleDragStart(e, task)}
        onDragEnd={handleDragEnd}
        className={`group p-3 rounded-lg border transition-all cursor-grab active:cursor-grabbing ${
          isDragging ? 'opacity-50 scale-95' : ''
        } ${
          task.status === 'done'
            ? 'bg-green-500/5 border-green-500/20'
            : task.status === 'in_progress'
            ? 'bg-purple-500/5 border-purple-500/20'
            : 'bg-white/5 border-white/10 hover:border-white/20'
        }`}
      >
        <div className="flex items-start gap-2">
          <GripVertical className="w-4 h-4 text-white/30 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${priorityColors[task.priority]}`}>
                {task.priority}
              </span>
              <div className="flex items-center gap-1">
                {task.status === 'done' && (
                  <Check className="w-3 h-3 text-green-400" />
                )}
                {isMyTask && (
                  <button 
                    onClick={(e) => { e.stopPropagation(); openEditModal(task); }}
                    className="p-1 rounded hover:bg-white/10 text-muted hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Edit2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
            <p className={`text-sm font-medium ${task.status === 'done' ? 'line-through text-muted' : ''}`}>
              {task.title}
            </p>
            {task.description && (
              <p className="text-xs text-muted mt-1 line-clamp-2">
                {task.description}
              </p>
            )}
            
            {task.assigneeId && (
              <div className="flex items-center gap-1 mt-2 text-xs text-muted">
                <div
                  className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold"
                  style={{ backgroundColor: getParticipantColor(task.assigneeId) }}
                >
                  {getParticipantName(task.assigneeId).charAt(0)}
                </div>
                <span>{getParticipantName(task.assigneeId)}</span>
              </div>
            )}
            {/* Tags display */}
            {task.tags && task.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {task.tags.map((tag, idx) => (
                  <span
                    key={idx}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] bg-blue-500/20 text-blue-400"
                  >
                    <Tag className="w-2.5 h-2.5" />
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-1 mt-2 pt-2 border-t border-white/5">
          {task.status === 'todo' && (
            <button
              onClick={() => handleClaimTask(task.id)}
              className="flex-1 px-2 py-1 rounded text-xs bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors"
            >
              Claim
            </button>
          )}
          {task.status === 'in_progress' && isAssignedToMe && (
            <>
              <button
                onClick={() => handleCompleteTask(task.id)}
                className="flex-1 px-2 py-1 rounded text-xs bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors"
              >
                Complete
              </button>
              <button
                onClick={() => handleUnclaimTask(task.id)}
                className="px-2 py-1 rounded text-xs bg-white/10 text-muted hover:bg-white/20 transition-colors"
              >
                Drop
              </button>
            </>
          )}
          {/* Delete button removed from card, moved to Edit Modal or kept here as fallback */}
          {isMyTask && !editingTask && (
            <button
              onClick={() => handleDeleteTask(task.id)}
              className="px-2 py-1 rounded text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
              title="Delete task"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    );
  };

  if (compact) {
    // Compact view for sidebar
    return (
      <div className="border-t border-white/10 mt-4 pt-4">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center justify-between text-xs font-medium text-muted uppercase tracking-wider mb-2 hover:text-white transition-colors"
        >
          <span className="flex items-center gap-2">
            <Circle className="w-3 h-3" />
            Tasks ({tasks.length})
          </span>
          {collapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        </button>

        {!collapsed && (
          <div className="space-y-2">
            {/* Quick stats */}
            <div className="flex gap-2 text-xs">
              <span className="px-2 py-1 rounded bg-white/5">
                <span className="text-muted">Todo:</span> {todoTasks.length}
              </span>
              <span className="px-2 py-1 rounded bg-purple-500/10 text-purple-400">
                <span className="text-muted">Active:</span> {inProgressTasks.length}
              </span>
              <span className="px-2 py-1 rounded bg-green-500/10 text-green-400">
                <span className="text-muted">Done:</span> {doneTasks.length}
              </span>
            </div>

            {/* My active tasks */}
            {inProgressTasks.filter(t => t.assigneeId === participantId).length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-muted uppercase">Your Tasks</div>
                {inProgressTasks
                  .filter(t => t.assigneeId === participantId)
                  .map(task => (
                    <div
                      key={task.id}
                      className="flex items-center gap-2 px-2 py-1 rounded bg-purple-500/10 text-sm"
                    >
                      <Clock className="w-3 h-3 text-purple-400" />
                      <span className="truncate flex-1">{task.title}</span>
                      <button
                        onClick={() => handleCompleteTask(task.id)}
                        className="p-1 rounded hover:bg-green-500/20 text-green-400"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
              </div>
            )}

            {/* Add task button */}
            <button
              onClick={() => setShowAddTask(true)}
              className="w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs bg-white/5 hover:bg-white/10 text-muted hover:text-white transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Task
            </button>
          </div>
        )}
      </div>
    );
  }

  // Full view
  return (
    <div className="h-full flex flex-col relative">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <h3 className="font-semibold flex items-center gap-2">
          <Circle className="w-4 h-4 text-purple-400" />
          Task Board
        </h3>
        <button
          onClick={() => setShowAddTask(true)}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Task
        </button>
      </div>

      {/* Add task form */}
      {showAddTask && (
        <div className="p-4 border-b border-white/10 bg-purple-500/5">
          <input
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateTask()}
            placeholder="Task title..."
            className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-sm placeholder-white/40 focus:outline-none focus:border-purple-500/50 mb-2"
            autoFocus
          />
          <textarea
            value={newTaskDescription}
            onChange={(e) => setNewTaskDescription(e.target.value)}
            placeholder="Description (optional)..."
            className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-sm placeholder-white/40 focus:outline-none focus:border-purple-500/50 mb-2 min-h-[80px]"
          />
          <div className="flex items-center gap-2">
            <select
              value={newTaskPriority}
              onChange={(e) => setNewTaskPriority(e.target.value as CollabTaskPriority)}
              className="px-2 py-1 bg-black/40 border border-white/10 rounded text-sm focus:outline-none"
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
            <div className="flex-1" />
            <button
              onClick={() => {
                setShowAddTask(false);
                setNewTaskTitle('');
                setNewTaskDescription('');
              }}
              className="px-3 py-1.5 rounded text-sm bg-white/5 hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateTask}
              disabled={!newTaskTitle.trim() || loading}
              className="px-3 py-1.5 rounded text-sm bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Edit Task Modal */}
      {editingTask && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-[#0f172a] border border-white/10 rounded-xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <h4 className="font-semibold flex items-center gap-2">
                <Edit2 className="w-4 h-4 text-purple-400" />
                Edit Task
              </h4>
              <button onClick={() => setEditingTask(null)} className="p-1 rounded hover:bg-white/10 text-muted" aria-label="Cancel editing">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label htmlFor="task-edit-title" className="text-xs text-muted uppercase mb-1 block">Title</label>
                <input
                  id="task-edit-title"
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-purple-500/50"
                />
              </div>
              <div>
                <label htmlFor="task-edit-description" className="text-xs text-muted uppercase mb-1 block">Description</label>
                <textarea
                  id="task-edit-description"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-purple-500/50 min-h-[100px]"
                />
              </div>
              <div>
                <label htmlFor="task-edit-priority" className="text-xs text-muted uppercase mb-1 block">Priority</label>
                <select
                  id="task-edit-priority"
                  value={editPriority}
                  onChange={(e) => setEditPriority(e.target.value as CollabTaskPriority)}
                  className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-sm focus:outline-none"
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>
            <div className="px-4 py-3 bg-white/5 border-t border-white/10 flex justify-between gap-2">
              <button
                onClick={() => handleDeleteTask(editingTask.id)}
                className="px-3 py-1.5 rounded text-sm bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditingTask(null)}
                  className="px-3 py-1.5 rounded text-sm bg-white/5 hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpdateTask}
                  disabled={!editTitle.trim()}
                  className="px-3 py-1.5 rounded text-sm bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors"
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="px-4 py-2 bg-red-500/10 text-red-400 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Filter bar */}
      <div className="px-4 py-2 border-b border-white/10 flex items-center gap-3">
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
            hasActiveFilters ? 'bg-purple-500/20 text-purple-400' : 'bg-white/5 text-muted hover:text-white'
          }`}
        >
          <Filter className="w-3 h-3" />
          Filter
          {hasActiveFilters && (
            <span className="ml-1 px-1.5 py-0.5 bg-purple-500/30 rounded-full text-[10px]">
              {(filterAssignee !== 'all' ? 1 : 0) + (filterPriority !== 'all' ? 1 : 0)}
            </span>
          )}
        </button>

        {showFilters && (
          <>
            <select
              value={filterAssignee}
              onChange={(e) => setFilterAssignee(e.target.value)}
              className="px-2 py-1 bg-black/40 border border-white/10 rounded text-xs focus:outline-none focus:border-purple-500/50"
            >
              <option value="all">All Assignees</option>
              <option value="mine">My Tasks</option>
              <option value="unassigned">Unassigned</option>
              {participants.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>

            <select
              value={filterPriority}
              onChange={(e) => setFilterPriority(e.target.value)}
              className="px-2 py-1 bg-black/40 border border-white/10 rounded text-xs focus:outline-none focus:border-purple-500/50"
            >
              <option value="all">All Priorities</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>

            {hasActiveFilters && (
              <button
                onClick={() => {
                  setFilterAssignee('all');
                  setFilterPriority('all');
                }}
                className="text-xs text-muted hover:text-white flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                Clear
              </button>
            )}
          </>
        )}

        {hasActiveFilters && !showFilters && (
          <span className="text-xs text-muted">
            Showing {todoTasks.length + inProgressTasks.length + doneTasks.length} of {tasks.length} tasks
          </span>
        )}
      </div>

      {/* Kanban columns */}
      <div className="flex-1 overflow-x-auto p-4">
        <div className="flex gap-4 min-h-full">
          {/* Todo column */}
          <div
            className={`flex-1 min-w-[250px] rounded-lg transition-colors ${
              dragOverColumn === 'todo' ? 'bg-white/5 ring-2 ring-white/20' : ''
            }`}
            onDragOver={(e) => handleDragOver(e, 'todo')}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, 'todo')}
          >
            <div className="flex items-center gap-2 mb-3 text-sm font-medium text-muted">
              <Circle className="w-4 h-4" />
              Todo ({todoTasks.length})
            </div>
            <div className="space-y-2 min-h-[100px]">
              {todoTasks.map(task => (
                <TaskCard key={task.id} task={task} />
              ))}
              {todoTasks.length === 0 && !dragOverColumn && (
                <div className="text-center py-8 text-muted text-sm opacity-50">
                  No tasks
                </div>
              )}
              {dragOverColumn === 'todo' && (
                <div className="border-2 border-dashed border-white/20 rounded-lg p-4 text-center text-muted text-sm">
                  Drop here
                </div>
              )}
            </div>
          </div>

          {/* In Progress column */}
          <div
            className={`flex-1 min-w-[250px] rounded-lg transition-colors ${
              dragOverColumn === 'in_progress' ? 'bg-purple-500/10 ring-2 ring-purple-500/30' : ''
            }`}
            onDragOver={(e) => handleDragOver(e, 'in_progress')}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, 'in_progress')}
          >
            <div className="flex items-center gap-2 mb-3 text-sm font-medium text-purple-400">
              <Clock className="w-4 h-4" />
              In Progress ({inProgressTasks.length})
            </div>
            <div className="space-y-2 min-h-[100px]">
              {inProgressTasks.map(task => (
                <TaskCard key={task.id} task={task} />
              ))}
              {inProgressTasks.length === 0 && !dragOverColumn && (
                <div className="text-center py-8 text-muted text-sm opacity-50">
                  No active tasks
                </div>
              )}
              {dragOverColumn === 'in_progress' && (
                <div className="border-2 border-dashed border-purple-500/30 rounded-lg p-4 text-center text-purple-400 text-sm">
                  Drop to claim
                </div>
              )}
            </div>
          </div>

          {/* Done column */}
          <div
            className={`flex-1 min-w-[250px] rounded-lg transition-colors ${
              dragOverColumn === 'done' ? 'bg-green-500/10 ring-2 ring-green-500/30' : ''
            }`}
            onDragOver={(e) => handleDragOver(e, 'done')}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, 'done')}
          >
            <div className="flex items-center gap-2 mb-3 text-sm font-medium text-green-400">
              <Check className="w-4 h-4" />
              Done ({doneTasks.length})
            </div>
            <div className="space-y-2 min-h-[100px]">
              {doneTasks.slice(0, 10).map(task => (
                <TaskCard key={task.id} task={task} />
              ))}
              {doneTasks.length > 10 && (
                <div className="text-center py-2 text-muted text-xs">
                  +{doneTasks.length - 10} more completed
                </div>
              )}
              {doneTasks.length === 0 && !dragOverColumn && (
                <div className="text-center py-8 text-muted text-sm opacity-50">
                  No completed tasks
                </div>
              )}
              {dragOverColumn === 'done' && (
                <div className="border-2 border-dashed border-green-500/30 rounded-lg p-4 text-center text-green-400 text-sm">
                  Drop to complete
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
