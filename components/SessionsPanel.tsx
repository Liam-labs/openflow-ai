'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  ClaudeSession,
  SessionsResponse,
} from '@/lib/types';
import { useEventStreamContext } from '@/lib/contexts/EventStreamContext';
import {
  Loader2,
  RefreshCw,
  Users,
  AlertCircle,
  Circle,
  Check,
} from 'lucide-react';

interface SessionsPanelProps {
  refreshInterval?: number;
  onActiveSessionCountChange?: (count: number) => void;
}

export function SessionsPanel({ refreshInterval = 5000, onActiveSessionCountChange }: SessionsPanelProps) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const eventStream = useEventStreamContext();

  const fetchData = useCallback(async (showRefresh = false) => {
    if (showRefresh) setIsRefreshing(true);

    try {
      const sessionsRes = await fetch('/api/claude/sessions');
      const sessionsData: SessionsResponse = await sessionsRes.json();

      if (sessionsData.error) {
        setError(sessionsData.error);
      } else {
        setSessions(sessionsData.sessions);
        setError(null);
      }
    } catch (err) {
      setError('Failed to fetch sessions data');
      console.error('Sessions fetch error:', err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // Report active session count to parent
  useEffect(() => {
    const activeCount = sessions.filter(s => s.status === 'active' || s.status === 'busy').length;
    onActiveSessionCountChange?.(activeCount);
  }, [sessions, onActiveSessionCountChange]);

  // SSE: subscribe to sessions change events
  useEffect(() => {
    return eventStream.subscribe<{ sessions: ClaudeSession[] }>('sessions:change', (data) => {
      if (data?.sessions) {
        setSessions(data.sessions);
        setError(null);
      }
    });
  }, [eventStream]);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Fallback polling: only when SSE is disconnected (30s)
  useEffect(() => {
    if (eventStream.isSSE) return;
    if (refreshInterval <= 0) return;

    const interval = setInterval(() => fetchData(), 30000);
    return () => clearInterval(interval);
  }, [eventStream.isSSE, refreshInterval, fetchData]);

  // Generate unique key for a session (sessionId alone isn't unique when multiple sessions in same dir)
  const getSessionKey = (session: ClaudeSession) => `${session.sessionId}-${session.pid}`;

  // Toggle session selection
  const toggleSessionSelection = (sessionKey: string) => {
    setSelectedSessionIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(sessionKey)) {
        newSet.delete(sessionKey);
      } else {
        newSet.add(sessionKey);
      }
      return newSet;
    });
  };

  // Clear selection
  const clearSelection = () => {
    setSelectedSessionIds(new Set());
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
      </div>
    );
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'active': return <Circle className="w-3 h-3 fill-green-400 text-green-400" />;
      case 'busy': return <Circle className="w-3 h-3 fill-yellow-400 text-yellow-400" />;
      case 'idle': return <Circle className="w-3 h-3 fill-gray-400 text-gray-400" />;
      case 'offline': return <Circle className="w-3 h-3 fill-red-400 text-red-400" />;
      default: return <Circle className="w-3 h-3 fill-gray-400 text-gray-400" />;
    }
  };

  const getStatusLabel = (status: string) => {
    return status.charAt(0).toUpperCase() + status.slice(1);
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return date.toLocaleDateString();
  };

  const activeSessions = sessions.filter(s => s.status === 'active' || s.status === 'busy');

  return (
    <div className="sessions-panel">
      {/* Header */}
      <div className="pm2-header glass-card">
        <div className="pm2-header-title">
          <Users className="w-5 h-5 text-accent" />
          <h2>Claude Sessions</h2>
          <button
            className="pm2-refresh-btn"
            onClick={() => fetchData(true)}
            disabled={isRefreshing}
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="pm2-quick-stats">
          <div className="pm2-stat">
            <span className="pm2-stat-value text-green-400">{activeSessions.length}</span>
            <span className="pm2-stat-label">Active</span>
          </div>
          <div className="pm2-stat">
            <span className="pm2-stat-value text-blue-400">{sessions.length}</span>
            <span className="pm2-stat-label">Total</span>
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

      {/* Sessions List */}
      <div className="glass-card">
        <div className="pm2-section-header">
          <Users className="w-4 h-4 text-green-400" />
          <h3>Active Sessions</h3>
          <span className="text-sm text-muted ml-2">
            {selectedSessionIds.size > 0 && `(${selectedSessionIds.size} selected)`}
          </span>
        </div>

        {/* Selection Bar - shows when sessions selected */}
        {selectedSessionIds.size >= 1 && (
          <div className="p-3 border-b border-white/10 bg-accent/5 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <span>{selectedSessionIds.size} session{selectedSessionIds.size > 1 ? 's' : ''} selected</span>
            </div>
            <button
              onClick={clearSelection}
              className="px-3 py-1.5 text-sm text-muted hover:text-white transition-colors"
            >
              Clear
            </button>
          </div>
        )}

        {sessions.length === 0 ? (
          <div className="p-6 text-center text-muted">
            <Users className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No active sessions detected</p>
            <p className="text-sm mt-1">Start a Claude session to see it here</p>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {sessions.map((session) => {
              const sessionKey = getSessionKey(session);
              const isSelected = selectedSessionIds.has(sessionKey);
              return (
                <div
                  key={sessionKey}
                  className={`p-4 rounded-lg border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-accent/10 border-accent/40'
                      : 'bg-white/5 border-white/10 hover:bg-white/10'
                  }`}
                  onClick={() => toggleSessionSelection(sessionKey)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {/* Checkbox indicator */}
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                        isSelected
                          ? 'bg-accent border-accent'
                          : 'border-white/30'
                      }`}>
                        {isSelected && <Check className="w-3 h-3 text-white" />}
                      </div>
                      {getStatusIcon(session.status)}
                      <div>
                        <div className="font-medium">
                          {session.displayName || `Agent-${session.pid}`}
                        </div>
                        <div className="text-sm text-muted">
                          PID {session.pid} | {getStatusLabel(session.status)}
                        </div>
                      </div>
                    </div>
                    <div className="text-right text-sm text-muted">
                      <div>{formatTime(session.lastHeartbeat)}</div>
                      {session.currentTask && (
                        <div className="text-xs mt-1 max-w-48 truncate">{session.currentTask}</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
