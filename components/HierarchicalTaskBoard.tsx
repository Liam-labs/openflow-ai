'use client';

/**
 * HierarchicalTaskBoard - Sprint -> Phase -> Task hierarchy view
 *
 * Features:
 * - Accordion layout for sprints and phases
 * - Progress bars at sprint and phase levels
 * - Drag-drop tasks between phases
 * - Create sprint/phase modals
 * - Automatic progress calculation
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { TaskDetailPane } from './TaskDetailPane';
import { CommandPalette } from './CommandPalette';
import {
  ChevronDown,
  Plus,
  Calendar,
  Target,
  Layers,
  MoreVertical,
  Trash2,
  Play,
  CheckCircle2,
  Archive,
  FileText,
  FileCheck,
  Loader2,
  X,
  FolderOpen,
} from 'lucide-react';
import type {
  CollabTask,
  CollabSprint,
  CollabPhase,
  CollabParticipant,
  CollabTaskStatus,
  FeatureDoc,
} from '@/lib/types';
import { TaskColumn } from './TaskColumn';
import { CreateSprintModal } from './modals/CreateSprintModal';
import { CreatePhaseModal } from './modals/CreatePhaseModal';

import { getDevflowHome } from '@/lib/home-dir';
interface HierarchicalTaskBoardProps {
  channelId: string;
  participantId: string;
  participants: CollabParticipant[];
  isTeamLead?: boolean;
  onDiscussTask?: (task: CollabTask) => void;
}

interface SprintProgress {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  todoTasks: number;
  percentComplete: number;
  phaseProgress: Array<{
    phaseId: string;
    phaseName: string;
    completed: number;
    total: number;
    percent: number;
  }>;
}

export function HierarchicalTaskBoard({
  channelId,
  participantId,
  participants,
  isTeamLead = false,
  onDiscussTask,
}: HierarchicalTaskBoardProps) {
  const [tasks, setTasks] = useState<CollabTask[]>([]);
  const [sprints, setSprints] = useState<CollabSprint[]>([]);
  const [phases, setPhases] = useState<CollabPhase[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal states
  const [showCreateSprint, setShowCreateSprint] = useState(false);
  const [showCreatePhase, setShowCreatePhase] = useState(false);
  const [selectedSprintForPhase, setSelectedSprintForPhase] = useState<string | null>(null);

  // Delete confirmation
  const [confirmDeleteSprintId, setConfirmDeleteSprintId] = useState<string | null>(null);

  // Feature docs state
  const [featureDocs, setFeatureDocs] = useState<FeatureDoc[]>([]);
  const [showDocs, setShowDocs] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);

  // Expansion states (stored in localStorage)
  const [expandedSprints, setExpandedSprints] = useState<Set<string>>(new Set());
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());

  // Task detail pane + command palette
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectedTask = selectedTaskId ? (tasks.find(t => t.id === selectedTaskId) ?? null) : null;
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // One-time filter: collapse completed sprints on initial load
  const hasFilteredCompleted = useRef(false);

  // Cmd+K / Ctrl+K → open command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Load expansion state from localStorage
  useEffect(() => {
    const savedSprints = localStorage.getItem(`taskboard-expanded-sprints-${channelId}`);
    const savedPhases = localStorage.getItem(`taskboard-expanded-phases-${channelId}`);

    if (savedSprints) {
      setExpandedSprints(new Set(JSON.parse(savedSprints)));
    }
    if (savedPhases) {
      setExpandedPhases(new Set(JSON.parse(savedPhases)));
    }
  }, [channelId]);

  // Save expansion state to localStorage
  const toggleSprint = (sprintId: string) => {
    setExpandedSprints(prev => {
      const next = new Set(prev);
      if (next.has(sprintId)) {
        next.delete(sprintId);
      } else {
        next.add(sprintId);
      }
      localStorage.setItem(`taskboard-expanded-sprints-${channelId}`, JSON.stringify([...next]));
      return next;
    });
  };

  const togglePhase = (phaseId: string) => {
    setExpandedPhases(prev => {
      const next = new Set(prev);
      if (next.has(phaseId)) {
        next.delete(phaseId);
      } else {
        next.add(phaseId);
      }
      localStorage.setItem(`taskboard-expanded-phases-${channelId}`, JSON.stringify([...next]));
      return next;
    });
  };

  // Fetch all data
  const fetchData = useCallback(async (showLoading = false) => {
    if (!channelId) return;

    try {
      if (showLoading) setLoading(true);
      const res = await fetch(`/api/collab/tasks?channelId=${channelId}&includeHierarchy=true`);

      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
        setSprints(data.sprints || []);
        setPhases(data.phases || []);
        setError(null);

        // Auto-expand active sprint on first load
        if (data.sprints && data.sprints.length > 0 && expandedSprints.size === 0) {
          const activeSprint = data.sprints.find((s: CollabSprint) => s.status === 'active');
          if (activeSprint) {
            setExpandedSprints(new Set([activeSprint.id]));
          }
        }

        // One-time: collapse completed sprints on initial load
        if (!hasFilteredCompleted.current && data.sprints && data.sprints.length > 0) {
          hasFilteredCompleted.current = true;
          const completedIds = new Set(
            data.sprints
              .filter((s: CollabSprint) => s.status === 'completed')
              .map((s: CollabSprint) => s.id)
          );
          if (completedIds.size > 0) {
            setExpandedSprints(prev => {
              const filtered = new Set([...prev].filter(id => !completedIds.has(id)));
              localStorage.setItem(`taskboard-expanded-sprints-${channelId}`, JSON.stringify([...filtered]));
              return filtered;
            });
          }
        }
      } else {
        setError('Failed to load task board data');
      }
    } catch (err) {
      console.error('Failed to fetch task board:', err);
      setError('Failed to load task board');
    } finally {
      setLoading(false);
    }
  }, [channelId, expandedSprints.size]);

  // Fetch feature docs for this channel
  const fetchFeatureDocs = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/feature-docs?channelId=${channelId}`);
      if (res.ok) {
        const data = await res.json();
        setFeatureDocs(data.docs || []);
      }
    } catch (err) {
      console.error('Failed to fetch feature docs:', err);
    }
  }, [channelId]);

  // Generate feature doc from completed sprints + optionally archive
  const handleGenerateAndArchive = async (clearSprints: boolean) => {
    setGenerating(true);
    setConfirmArchive(false);
    try {
      const res = await fetch('/api/feature-docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate',
          channelId,
          clearSprints,
        }),
      });

      const data = await res.json();
      if (data.success && data.doc) {
        setFeatureDocs(prev => [data.doc, ...prev]);
        setShowDocs(true);
        setExpandedDocId(data.doc.id);
        if (clearSprints) {
          await fetchData(true);
        }
      } else {
        setError(data.error || 'Failed to generate summary');
        setTimeout(() => setError(null), 4000);
      }
    } catch (err) {
      console.error('Failed to generate feature doc:', err);
      setError('Failed to generate feature summary');
      setTimeout(() => setError(null), 4000);
    } finally {
      setGenerating(false);
    }
  };

  // Delete a feature doc
  const handleDeleteDoc = async (docId: string) => {
    try {
      const res = await fetch('/api/feature-docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', docId }),
      });
      if (res.ok) {
        setFeatureDocs(prev => prev.filter(d => d.id !== docId));
        if (expandedDocId === docId) setExpandedDocId(null);
      }
    } catch (err) {
      console.error('Failed to delete feature doc:', err);
    }
  };

  // Initial fetch and polling
  useEffect(() => {
    fetchData(true);
    fetchFeatureDocs();
    const interval = setInterval(() => fetchData(false), 5000);
    return () => clearInterval(interval);
  }, [fetchData, fetchFeatureDocs]);

  // Format date as 'Apr 27' — faster to scan than locale default
  const formatSprintDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // Calculate sprint progress
  const calculateSprintProgress = (sprint: CollabSprint): SprintProgress => {
    const sprintPhases = phases.filter(p => p.sprintId === sprint.id);
    const sprintTasks = tasks.filter(t => t.sprintId === sprint.id);

    const completed = sprintTasks.filter(t => t.status === 'done').length;
    const inProgress = sprintTasks.filter(t => t.status === 'in_progress').length;
    const todo = sprintTasks.filter(t => t.status === 'todo').length;
    const total = sprintTasks.length;

    const phaseProgress = sprintPhases.map(phase => {
      const phaseTasks = tasks.filter(t => t.phaseId === phase.id);
      const phaseCompleted = phaseTasks.filter(t => t.status === 'done').length;
      return {
        phaseId: phase.id,
        phaseName: phase.name,
        completed: phaseCompleted,
        total: phaseTasks.length,
        percent: phaseTasks.length > 0 ? Math.round((phaseCompleted / phaseTasks.length) * 100) : 0,
      };
    });

    return {
      totalTasks: total,
      completedTasks: completed,
      inProgressTasks: inProgress,
      todoTasks: todo,
      percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
      phaseProgress,
    };
  };

  // Calculate phase progress
  const calculatePhaseProgress = (phase: CollabPhase) => {
    const phaseTasks = tasks.filter(t => t.phaseId === phase.id);
    const completed = phaseTasks.filter(t => t.status === 'done').length;
    const total = phaseTasks.length;
    return {
      completed,
      total,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  };

  // Get tasks for a specific phase and status
  const getTasksForPhaseAndStatus = (phaseId: string, status: CollabTaskStatus) => {
    return tasks.filter(t => t.phaseId === phaseId && t.status === status);
  };


  // Handle task status change (drag-drop)
  const handleTaskStatusChange = async (taskId: string, newStatus: CollabTaskStatus) => {
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          channelId,
          participantId,
          taskId,
          status: newStatus,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.task) {
          setTasks(prev => prev.map(t => t.id === taskId ? data.task : t));
        }
      }
    } catch (err) {
      console.error('Failed to update task:', err);
    }
  };

  // Activate sprint
  const handleActivateSprint = async (sprintId: string) => {
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-sprint',
          channelId,
          sprintId,
          updates: { status: 'active' },
        }),
      });

      if (res.ok) {
        await fetchData();
      }
    } catch (err) {
      console.error('Failed to activate sprint:', err);
    }
  };

  // Complete sprint
  const handleCompleteSprint = async (sprintId: string) => {
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-sprint',
          channelId,
          sprintId,
          updates: { status: 'completed' },
        }),
      });

      if (res.ok) {
        await fetchData();
      }
    } catch (err) {
      console.error('Failed to complete sprint:', err);
    }
  };

  // Delete sprint
  const handleDeleteSprint = async (sprintId: string) => {
    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete-sprint',
          channelId,
          participantId,
          sprintId,
        }),
      });

      if (res.ok) {
        setConfirmDeleteSprintId(null);
        await fetchData();
      }
    } catch (err) {
      console.error('Failed to delete sprint:', err);
    }
  };

  // Sprint state chip: hollow dot = planned, accent dot = active, grey dot = completed
  const renderSprintStatus = (status: CollabSprint['status']) => (
    <span className={`sb-chip sb-chip--${status}`}>{status}</span>
  );

  if (error) {
    return (
      <div className="sb mg-scope">
        <div className="sb-state sb-state--error" role="alert">
          <div className="sb-ic"><Target /></div>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sb mg-scope">
      {/* Header */}
      <div className="sb-head">
        <h2 className="sb-title">
          <span className="sb-ic"><Layers aria-hidden="true" /></span>
          Sprint Board
        </h2>
        <div className="sb-actions">
          {/* Feature Docs toggle */}
          {featureDocs.length > 0 && (
            <button
              type="button"
              onClick={() => setShowDocs(prev => !prev)}
              aria-pressed={showDocs}
              className={`mg-btn mg-btn--ghost`}
              style={showDocs ? { borderColor: 'var(--accent-soft)', background: 'var(--selected)' } : undefined}
            >
              <FileText aria-hidden="true" />
              Docs
              <span className="sb-badge">{featureDocs.length}</span>
            </button>
          )}

          {/* Close & Summarize button */}
          {sprints.some(s => s.status === 'completed') && (
            <button
              type="button"
              onClick={() => setConfirmArchive(true)}
              disabled={generating}
              className="mg-btn mg-btn--ghost"
            >
              {generating ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Archive aria-hidden="true" />}
              {generating ? 'Generating…' : 'Close & Summarize'}
            </button>
          )}

          <button type="button" onClick={() => setShowCreateSprint(true)} className="mg-btn">
            <Plus aria-hidden="true" />
            New Sprint
          </button>
        </div>
      </div>

      {/* Skeleton Loading State */}
      {loading && sprints.length === 0 && (
        <div className="space-y-4" aria-hidden="true">
          {[0, 1, 2].map(i => (
            <div key={i} className="sb-skel" style={{ opacity: 1 - i * 0.2 }} />
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && sprints.length === 0 && (
        <div className="sb-state">
          <div className="sb-ic"><Target aria-hidden="true" /></div>
          <h3>No sprints yet</h3>
          <p>Create your first sprint to organize work into phases and track progress across your team.</p>
          <button type="button" onClick={() => setShowCreateSprint(true)} className="mg-btn">
            <Plus aria-hidden="true" />
            Create First Sprint
          </button>
        </div>
      )}

      {/* Sprints */}
      {sprints
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(sprint => {
          const progress = calculateSprintProgress(sprint);
          const sprintPhases = phases
            .filter(p => p.sprintId === sprint.id)
            .sort((a, b) => a.sortOrder - b.sortOrder);
          const isExpanded = expandedSprints.has(sprint.id);
          const donePct = progress.totalTasks > 0 ? (progress.completedTasks / progress.totalTasks) * 100 : 0;
          const doingPct = progress.totalTasks > 0 ? (progress.inProgressTasks / progress.totalTasks) * 100 : 0;

          return (
            <section key={sprint.id} className={`sb-sprint sb-sprint--${sprint.status}`} aria-label={sprint.name}>
              {/* Sprint Header */}
              <div className="sb-sh">
                <div className="sb-sh-top">
                  <button
                    type="button"
                    onClick={() => toggleSprint(sprint.id)}
                    aria-expanded={isExpanded}
                    className="sb-toggle"
                  >
                    <ChevronDown className="sb-chev" aria-hidden="true" />
                    <span style={{ minWidth: 0 }}>
                      <span className="sb-name">{sprint.name}</span>
                      {sprint.description && <span className="sb-desc-s">{sprint.description}</span>}
                    </span>
                  </button>

                  <div className="sb-side">
                    {renderSprintStatus(sprint.status)}

                    {/* Sprint Actions Menu (opens on hover or keyboard focus) */}
                    <div className="sb-menu-host">
                      <button type="button" className="sb-iconbtn" aria-label={`Actions for ${sprint.name}`} aria-haspopup="menu">
                        <MoreVertical aria-hidden="true" />
                      </button>
                      <div className="sb-menu" role="menu">
                        {sprint.status !== 'active' && (
                          <button type="button" role="menuitem" onClick={() => handleActivateSprint(sprint.id)} className="sb-mi">
                            <Play aria-hidden="true" />
                            Activate Sprint
                          </button>
                        )}
                        {sprint.status === 'active' && (
                          <button type="button" role="menuitem" onClick={() => handleCompleteSprint(sprint.id)} className="sb-mi">
                            <CheckCircle2 aria-hidden="true" />
                            Complete Sprint
                          </button>
                        )}
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setSelectedSprintForPhase(sprint.id);
                            setShowCreatePhase(true);
                          }}
                          className="sb-mi"
                        >
                          <Plus aria-hidden="true" />
                          Add Phase
                        </button>
                        <div className="sb-sep" />
                        {confirmDeleteSprintId === sprint.id ? (
                          <div className="sb-confirm">
                            <p>Delete sprint, phases &amp; tasks?</p>
                            <div>
                              <button type="button" onClick={() => handleDeleteSprint(sprint.id)} className="mg-btn mg-btn--danger" style={{ minHeight: 34, padding: '0 12px' }}>
                                Delete
                              </button>
                              <button type="button" onClick={() => setConfirmDeleteSprintId(null)} className="mg-btn mg-btn--ghost" style={{ minHeight: 34, padding: '0 12px' }}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button type="button" role="menuitem" onClick={() => setConfirmDeleteSprintId(sprint.id)} className="sb-mi sb-mi--danger">
                            <Trash2 aria-hidden="true" />
                            Delete Sprint
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Sprint metadata: dates and task tally */}
                <div className="sb-meta">
                  {(sprint.startDate || sprint.endDate) && (
                    <span>
                      <Calendar aria-hidden="true" />
                      {sprint.startDate && formatSprintDate(sprint.startDate)}
                      {sprint.startDate && sprint.endDate && '–'}
                      {sprint.endDate && formatSprintDate(sprint.endDate)}
                    </span>
                  )}
                  <span className="sb-tally" title={`${progress.completedTasks} done · ${progress.inProgressTasks} in progress · ${progress.todoTasks} to do`}>
                    <b>{progress.completedTasks}</b>/{progress.totalTasks} tasks
                  </span>
                  {progress.inProgressTasks > 0 && <span>{progress.inProgressTasks} in progress</span>}
                </div>

                {/* One bar: done in accent, in progress as the pale segment after it */}
                <div className="sb-prog">
                  <div
                    className="sb-bar"
                    role="progressbar"
                    aria-label={`${sprint.name} progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress.percentComplete}
                  >
                    <i className="d" style={{ width: `${donePct}%` }} />
                    <i className="w" style={{ width: `${doingPct}%` }} />
                  </div>
                  <span className="sb-pct">{progress.percentComplete}%</span>
                </div>
              </div>

              {/* Sprint Content (Phases) */}
              <AnimatePresence initial={false}>
                {isExpanded && (
                <motion.div
                  key="sprint-content"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden"
                >
                <div className="sb-body">
                  {sprintPhases.length === 0 ? (
                    <div className="sb-nophase">
                      <p>No phases in this sprint yet.</p>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSprintForPhase(sprint.id);
                          setShowCreatePhase(true);
                        }}
                        className="mg-btn mg-btn--ghost"
                      >
                        <Plus aria-hidden="true" />
                        Add First Phase
                      </button>
                    </div>
                  ) : (
                    sprintPhases.map(phase => {
                      const phaseProgress = calculatePhaseProgress(phase);
                      const isPhaseExpanded = expandedPhases.has(phase.id);

                      return (
                        <div key={phase.id} className={`sb-phase${isPhaseExpanded ? ' sb-phase--open' : ''}`}>
                          {/* Phase Header */}
                          <button
                            type="button"
                            onClick={() => togglePhase(phase.id)}
                            aria-expanded={isPhaseExpanded}
                            className="sb-ph"
                          >
                            <ChevronDown className="sb-chev" aria-hidden="true" />
                            <span className="sb-ph-main">
                              <span className="sb-ph-name">
                                {phase.name}
                                {phaseProgress.total > 0 && phaseProgress.percent === 100 && <CheckCircle2 aria-label="Phase complete" />}
                              </span>
                              {phase.description && <span className="sb-ph-desc">{phase.description}</span>}
                            </span>
                            <span className="sb-ph-stat">
                              <span><b>{phaseProgress.completed}</b>/{phaseProgress.total}</span>
                              <span className="sb-bar sb-bar--sm" aria-hidden="true">
                                <i className="d" style={{ width: `${phaseProgress.percent}%` }} />
                              </span>
                              <span className="sb-pct sb-pct--sm">{phaseProgress.percent}%</span>
                            </span>
                          </button>

                          {/* Phase Content (Task Lanes) */}
                          <AnimatePresence initial={false}>
                            {isPhaseExpanded && (
                            <motion.div
                              key="phase-content"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                              className="overflow-hidden"
                            >
                              <div className="sb-lanes">
                                {([
                                  ['To Do', 'todo'],
                                  ['In Progress', 'in_progress'],
                                  ['Done', 'done'],
                                ] as Array<[string, CollabTaskStatus]>).map(([title, status]) => (
                                  <TaskColumn
                                    key={status}
                                    title={title}
                                    status={status}
                                    tasks={getTasksForPhaseAndStatus(phase.id, status)}
                                    channelId={channelId}
                                    participantId={participantId}
                                    participants={participants}
                                    onTaskStatusChange={handleTaskStatusChange}
                                    onTaskUpdate={fetchData}
                                    onDiscussTask={onDiscussTask}
                                    onTaskClick={task => setSelectedTaskId(task.id)}
                                    sprintId={sprint.id}
                                    phaseId={phase.id}
                                  />
                                ))}
                              </div>
                            </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })
                  )}
                </div>
                </motion.div>
                )}
              </AnimatePresence>
            </section>
          );
        })}

      {/* Feature Docs Panel */}
      {showDocs && featureDocs.length > 0 && (
        <div className="sb-docs">
          <div className="sb-docs-head">
            <h3>
              <FileText aria-hidden="true" />
              Feature Documentation
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button
                type="button"
                onClick={() => {
                  // Open the sprint summaries directory in Windows Explorer
                  const exportDir = featureDocs.find(d => d.exportPath)?.exportPath;
                  const dirPath = exportDir
                    ? exportDir.substring(0, exportDir.lastIndexOf('/'))
                    : undefined;
                  fetch('/api/folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: dirPath || `${getDevflowHome()}/docs/sprint-summaries` }),
                  });
                }}
                className="sb-iconbtn"
                title="Open folder in Explorer"
                aria-label="Open folder in Explorer"
              >
                <FolderOpen aria-hidden="true" />
              </button>
              <button type="button" onClick={() => setShowDocs(false)} className="sb-iconbtn" aria-label="Close documentation">
                <X aria-hidden="true" />
              </button>
            </div>
          </div>

          <div>
            {featureDocs.map(doc => {
              const isExpanded = expandedDocId === doc.id;
              return (
                <div key={doc.id} className="sb-doc">
                  <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                    <button
                      type="button"
                      onClick={() => setExpandedDocId(isExpanded ? null : doc.id)}
                      aria-expanded={isExpanded}
                      className="sb-doc-row"
                    >
                      <ChevronDown className="sb-chev" aria-hidden="true" style={{ transform: isExpanded ? undefined : 'rotate(-90deg)', marginTop: 2 }} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span className="sb-doc-title">
                          <span>{doc.title}</span>
                          {doc.exportPath && (
                            <span className="sb-tag" title={`Exported to ${doc.exportPath}`} style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <FileCheck aria-hidden="true" style={{ width: 12, height: 12 }} />
                              .md
                            </span>
                          )}
                        </span>
                        <span className="sb-doc-meta">
                          <span>{new Date(doc.generatedAt).toLocaleDateString()}</span>
                          <span>{doc.taskCount} tasks</span>
                          <span>{doc.sprintNames.join(', ')}</span>
                          {doc.exportPath && (
                            <span className="font-mono truncate max-w-[150px]" title={doc.exportPath}>
                              {doc.exportPath.split('/').slice(-2).join('/')}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteDoc(doc.id)}
                      className="sb-iconbtn"
                      style={{ margin: '8px 10px 0 0' }}
                      title="Delete document"
                      aria-label={`Delete ${doc.title}`}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>

                  <AnimatePresence initial={false}>
                    {isExpanded && (
                      <motion.div
                        key="doc-content"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="sb-md">
                          {doc.content.split('\n').map((line, i) => {
                            if (line.startsWith('# ')) return <h1 key={i}>{line.slice(2)}</h1>;
                            if (line.startsWith('## ')) return <h2 key={i}>{line.slice(3)}</h2>;
                            if (line.startsWith('### ')) return <h3 key={i}>{line.slice(4)}</h3>;
                            if (line.startsWith('- **')) {
                              const boldEnd = line.indexOf('**', 4);
                              if (boldEnd > 0) {
                                return (
                                  <div key={i} className="li">
                                    <span>
                                      <strong>{line.slice(4, boldEnd)}</strong>
                                      {line.slice(boldEnd + 2)}
                                    </span>
                                  </div>
                                );
                              }
                            }
                            if (line.startsWith('- ')) {
                              return (
                                <div key={i} className="li">
                                  <span>{line.slice(2)}</span>
                                </div>
                              );
                            }
                            if (line.trim() === '') return <div key={i} style={{ height: 8 }} />;
                            return <p key={i}>{line}</p>;
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Archive Confirmation Dialog */}
      {confirmArchive && (
        <div className="sb-scrim" onClick={() => setConfirmArchive(false)}>
          <div className="sb-dialog" role="dialog" aria-modal="true" aria-labelledby="sb-archive-title" onClick={e => e.stopPropagation()}>
            <h3 id="sb-archive-title">
              <Archive aria-hidden="true" />
              Close &amp; Summarize
            </h3>
            <p>
              {sprints.filter(s => s.status === 'completed').length} completed sprint(s) will be summarized into a Feature Doc.{' '}
              <strong>Archive</strong> also removes them from the board.
            </p>
            <div className="sb-dialog-actions">
              <button type="button" onClick={() => setConfirmArchive(false)} className="mg-btn mg-btn--ghost">
                Cancel
              </button>
              <button type="button" onClick={() => handleGenerateAndArchive(false)} disabled={generating} className="mg-btn mg-btn--ghost">
                Doc only
              </button>
              <button type="button" onClick={() => handleGenerateAndArchive(true)} disabled={generating} className="mg-btn">
                {generating ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    Working…
                  </>
                ) : (
                  'Archive'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {showCreateSprint && (
        <CreateSprintModal
          channelId={channelId}
          participantId={participantId}
          onClose={() => setShowCreateSprint(false)}
          onSuccess={() => {
            setShowCreateSprint(false);
            fetchData();
          }}
        />
      )}

      {showCreatePhase && selectedSprintForPhase && (
        <CreatePhaseModal
          channelId={channelId}
          participantId={participantId}
          sprintId={selectedSprintForPhase}
          onClose={() => {
            setShowCreatePhase(false);
            setSelectedSprintForPhase(null);
          }}
          onSuccess={() => {
            setShowCreatePhase(false);
            setSelectedSprintForPhase(null);
            fetchData();
          }}
        />
      )}

      {/* Task Detail Pane — slide-in from right */}
      {selectedTask && (
        <TaskDetailPane
          task={selectedTask}
          allTasks={tasks}
          participants={participants}
          channelId={channelId}
          participantId={participantId}
          onClose={() => setSelectedTaskId(null)}
          onTaskUpdate={fetchData}
          onNavigate={task => setSelectedTaskId(task.id)}
        />
      )}

      {/* Command Palette — Cmd+K */}
      {commandPaletteOpen && (
        <CommandPalette
          tasks={tasks}
          onSelectTask={task => { setSelectedTaskId(task.id); }}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}
    </div>
  );
}
