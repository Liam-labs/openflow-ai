'use client';

import { useEffect, useState, useCallback } from 'react';
import { RalphLoop, LoopsResponse } from '@/lib/types';
import { LoopCard } from './LoopCard';
import { Loader2, RefreshCw, Repeat, History, AlertCircle, AlertTriangle } from 'lucide-react';

interface LoopsPanelProps {
  refreshInterval?: number;
  onActiveLoopCountChange?: (count: number) => void;
}

export function LoopsPanel({ refreshInterval = 2000, onActiveLoopCountChange }: LoopsPanelProps) {
  const [activeLoops, setActiveLoops] = useState<RalphLoop[]>([]);
  const [historyLoops, setHistoryLoops] = useState<RalphLoop[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);

  const fetchLoopsData = useCallback(async (showRefresh = false) => {
    if (showRefresh) setIsRefreshing(true);

    try {
      const response = await fetch('/api/claude/loops');
      const data: LoopsResponse = await response.json();

      if (data.error) {
        setError(data.error);
      } else {
        setActiveLoops(data.active);
        setHistoryLoops(data.history);
        setError(null);
      }
    } catch (err) {
      setError('Failed to fetch loops data');
      console.error('Loops fetch error:', err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  const handleCancelLoop = async (projectPath: string) => {
    try {
      const response = await fetch('/api/claude/loops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', project_path: projectPath }),
      });

      const result = await response.json();

      if (!result.success) {
        setError(result.error || 'Failed to cancel loop');
      } else {
        await fetchLoopsData();
      }
    } catch (err) {
      setError('Failed to cancel loop');
      console.error('Cancel loop error:', err);
    }
  };

  const handleSubmitInput = async (projectPath: string, response: string, selectedOption?: number) => {
    try {
      const res = await fetch('/api/claude/loops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submit_input',
          project_path: projectPath,
          input_response: response,
          selected_option: selectedOption,
        }),
      });

      const result = await res.json();

      if (!result.success) {
        setError(result.error || 'Failed to submit input');
      } else {
        await fetchLoopsData();
      }
    } catch (err) {
      setError('Failed to submit input');
      console.error('Submit input error:', err);
    }
  };

  // Count loops awaiting input
  const awaitingInputCount = activeLoops.filter(loop => loop.final_status === 'awaiting_input').length;

  // Report active loop count to parent
  useEffect(() => {
    onActiveLoopCountChange?.(activeLoops.length);
  }, [activeLoops.length, onActiveLoopCountChange]);

  useEffect(() => {
    fetchLoopsData();
  }, [fetchLoopsData]);

  useEffect(() => {
    if (refreshInterval <= 0) return;

    const interval = setInterval(() => fetchLoopsData(), refreshInterval);
    return () => clearInterval(interval);
  }, [refreshInterval, fetchLoopsData]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
      </div>
    );
  }

  const formatDuration = (loop: RalphLoop) => {
    const start = new Date(loop.started_at);
    // For history loops, use completed_at or last_heartbeat as the end time
    // Only use current time for actively running loops
    const isActive = loop.final_status === 'running' || loop.final_status === 'awaiting_input';
    const end = loop.completed_at
      ? new Date(loop.completed_at)
      : isActive
        ? new Date()
        : new Date(loop.last_heartbeat);
    const diff = Math.floor((end.getTime() - start.getTime()) / 1000);

    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
    const hours = Math.floor(diff / 3600);
    const mins = Math.floor((diff % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return 'text-green-400';
      case 'completed': return 'text-blue-400';
      case 'stuck': return 'text-yellow-400';
      case 'cancelled': return 'text-gray-400';
      case 'max_iterations': return 'text-orange-400';
      default: return 'text-gray-400';
    }
  };

  const getStatusBadge = (status: string) => {
    const color = getStatusColor(status);
    const label = status === 'max_iterations' ? 'Max Reached' : status.charAt(0).toUpperCase() + status.slice(1);
    return (
      <span className={`px-2 py-0.5 rounded text-xs font-medium ${color} bg-black/30`}>
        {label}
      </span>
    );
  };

  return (
    <div className="loops-panel">
      {/* Header */}
      <div className="pm2-header glass-card">
        <div className="pm2-header-title">
          <Repeat className="w-5 h-5 text-accent" />
          <h2>Ralph Loops</h2>
          {awaitingInputCount > 0 && (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-500/20 border border-amber-500/40 rounded-lg animate-pulse">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-medium text-amber-400">
                {awaitingInputCount} needs input
              </span>
            </div>
          )}
          <button
            className="pm2-refresh-btn"
            onClick={() => fetchLoopsData(true)}
            disabled={isRefreshing}
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="pm2-quick-stats">
          <div className="pm2-stat">
            <span className="pm2-stat-value text-green-400">{activeLoops.length}</span>
            <span className="pm2-stat-label">Active</span>
          </div>
          {awaitingInputCount > 0 && (
            <div className="pm2-stat">
              <span className="pm2-stat-value text-amber-400">{awaitingInputCount}</span>
              <span className="pm2-stat-label">Waiting</span>
            </div>
          )}
          <div className="pm2-stat">
            <span className="pm2-stat-value text-blue-400">{historyLoops.length}</span>
            <span className="pm2-stat-label">History</span>
          </div>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="pm2-error">
          <AlertCircle className="w-4 h-4" />
          {error}
          <button onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      {/* Active Loops */}
      <div className="glass-card">
        <div className="pm2-section-header">
          <Repeat className="w-4 h-4 text-green-400" />
          <h3>Active Loops</h3>
          <span className="text-muted text-sm">({activeLoops.length})</span>
        </div>

        {activeLoops.length === 0 ? (
          <div className="p-6 text-center text-muted">
            <Repeat className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No active loops</p>
            <p className="text-sm mt-1">Start a loop with <code className="bg-black/30 px-2 py-0.5 rounded">/ralph-loop</code></p>
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {activeLoops.map((loop) => (
              <LoopCard
                key={loop.session_id}
                loop={loop}
                onCancel={() => handleCancelLoop(loop.project_path)}
                onSubmitInput={handleSubmitInput}
              />
            ))}
          </div>
        )}
      </div>

      {/* History */}
      <div className="glass-card mt-4">
        <div className="pm2-section-header">
          <History className="w-4 h-4 text-blue-400" />
          <h3>History</h3>
          <span className="text-muted text-sm">({historyLoops.length})</span>
        </div>

        {historyLoops.length === 0 ? (
          <div className="p-4 text-center text-muted text-sm">
            No loop history yet
          </div>
        ) : (
          <div className="loops-history">
            <div className="loops-history-header">
              <div className="loops-cell loops-cell-project">Project</div>
              <div className="loops-cell loops-cell-status">Status</div>
              <div className="loops-cell loops-cell-duration">Duration</div>
              <div className="loops-cell loops-cell-time">Started</div>
            </div>
            <div className="loops-history-body">
              {historyLoops.map((loop) => (
                <div key={loop.session_id}>
                  <div
                    className="loops-history-row cursor-pointer hover:bg-white/5"
                    onClick={() => setExpandedHistory(expandedHistory === loop.session_id ? null : loop.session_id)}
                  >
                    <div className="loops-cell loops-cell-project">
                      <span className="font-medium">{loop.project_name}</span>
                    </div>
                    <div className="loops-cell loops-cell-status">
                      {getStatusBadge(loop.final_status)}
                    </div>
                    <div className="loops-cell loops-cell-duration">
                      {formatDuration(loop)}
                    </div>
                    <div className="loops-cell loops-cell-time text-muted">
                      {new Date(loop.started_at).toLocaleDateString()}
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {expandedHistory === loop.session_id && (
                    <div className="loops-expanded-details">
                      <div className="p-4 bg-black/20 border-t border-white/5">
                        <p className="text-sm text-muted mb-2">
                          <strong>Prompt:</strong> {loop.original_prompt.slice(0, 200)}
                          {loop.original_prompt.length > 200 && '...'}
                        </p>
                        <p className="text-sm text-muted">
                          <strong>Evaluator:</strong> {loop.evaluator_model} |{' '}
                          <strong>Screenshot URL:</strong> {loop.screenshot_url}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
