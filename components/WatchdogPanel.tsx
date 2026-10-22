'use client';

import { useEffect, useState, useCallback } from 'react';
import { useEventStream } from '@/lib/contexts/EventStreamContext';
import type { WatchdogEvent, WatchdogState } from '@/lib/types';
import {
  Eye,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  RotateCw,
  Shield,
  Pause,
} from 'lucide-react';

interface WatchdogPanelProps {
  onServiceCountChange?: (count: number) => void;
  onEventCountChange?: (count: number) => void;
}

interface WatchdogSSEData {
  event?: WatchdogEvent;
  states?: WatchdogState[];
  timestamp?: string;
}

export function WatchdogPanel({ onServiceCountChange, onEventCountChange }: WatchdogPanelProps) {
  const [states, setStates] = useState<WatchdogState[]>([]);
  const [events, setEvents] = useState<WatchdogEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // SSE subscription for real-time watchdog events
  const { data: sseData } = useEventStream<WatchdogSSEData>('watchdog:event', {
    fallbackUrl: undefined,
    fallbackInterval: 0,
  });

  // Process SSE updates
  useEffect(() => {
    if (!sseData) return;

    if (sseData.states) {
      setStates(sseData.states);
    }

    if (sseData.event) {
      setEvents(prev => {
        const updated = [...prev, sseData.event!];
        // Keep last 50 events
        return updated.slice(-50);
      });
    }
  }, [sseData]);

  // Initial fetch
  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'watchdog.status' }),
      });
      // This endpoint needs auth - fallback to just showing SSE data
      if (!response.ok) {
        setIsLoading(false);
        return;
      }
      const data = await response.json();
      if (data.success && data.data) {
        setStates(data.data.services || []);
        setEvents(data.data.recentEvents || []);
      }
    } catch {
      // API may require auth - that's fine, SSE will still work
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Report counts to parent
  useEffect(() => {
    onServiceCountChange?.(states.filter(s => s.enabled).length);
  }, [states, onServiceCountChange]);

  useEffect(() => {
    onEventCountChange?.(events.length);
  }, [events, onEventCountChange]);

  const getEventIcon = (type: WatchdogEvent['eventType']) => {
    switch (type) {
      case 'restart_attempt': return <RotateCw className="w-3.5 h-3.5 text-blue-400" />;
      case 'restart_success': return <CheckCircle className="w-3.5 h-3.5 text-green-400" />;
      case 'restart_failed': return <XCircle className="w-3.5 h-3.5 text-red-400" />;
      case 'cooldown_started': return <Pause className="w-3.5 h-3.5 text-amber-400" />;
      case 'cooldown_ended': return <RefreshCw className="w-3.5 h-3.5 text-green-400" />;
      case 'port_conflict': return <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />;
      case 'circuit_broken': return <AlertTriangle className="w-3.5 h-3.5 text-red-400" />;
    }
  };

  const getEventColor = (type: WatchdogEvent['eventType']): string => {
    switch (type) {
      case 'restart_attempt': return 'border-blue-500/20 bg-blue-500/5';
      case 'restart_success': return 'border-green-500/20 bg-green-500/5';
      case 'restart_failed': return 'border-red-500/20 bg-red-500/5';
      case 'cooldown_started': return 'border-amber-500/20 bg-amber-500/5';
      case 'cooldown_ended': return 'border-green-500/20 bg-green-500/5';
      case 'port_conflict': return 'border-amber-500/20 bg-amber-500/5';
      case 'circuit_broken': return 'border-red-500/20 bg-red-500/5';
    }
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const formatRelative = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  };

  if (isLoading) {
    return (
      <div className="p-4 text-center text-muted text-sm">
        Loading watchdog status...
      </div>
    );
  }

  // Show monitored services summary
  const enabledStates = states.filter(s => s.enabled);
  const inCooldown = enabledStates.filter(s => s.cooldownUntil && new Date(s.cooldownUntil).getTime() > Date.now());
  const recentEvents = [...events].reverse().slice(0, 20); // Most recent first

  return (
    <div className="p-3 space-y-3">
      {/* Monitored Services Summary */}
      {enabledStates.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {enabledStates.map(state => {
            const isInCooldown = state.cooldownUntil && new Date(state.cooldownUntil).getTime() > Date.now();
            const statusColor = isInCooldown
              ? 'text-amber-400 bg-amber-400/10 border-amber-400/25'
              : state.lastCheckStatus === 'online'
                ? 'text-green-400 bg-green-400/10 border-green-400/25'
                : state.lastCheckStatus === 'offline'
                  ? 'text-red-400 bg-red-400/10 border-red-400/25'
                  : 'text-white/50 bg-white/5 border-white/10';

            return (
              <div
                key={state.projectId}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${statusColor}`}
                title={isInCooldown
                  ? `In cooldown until ${formatTime(state.cooldownUntil!)}`
                  : `${state.restartCount} restart(s), last check: ${state.lastCheckStatus || 'pending'}`
                }
              >
                {isInCooldown ? (
                  <Clock className="w-3 h-3" />
                ) : state.lastCheckStatus === 'online' ? (
                  <Shield className="w-3 h-3" />
                ) : (
                  <Eye className="w-3 h-3" />
                )}
                <span>{state.projectId.replace(/-service$/, '')}</span>
                {state.restartCount > 0 && (
                  <span className="opacity-60">{state.restartCount}x</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {enabledStates.length === 0 && events.length === 0 && (
        <div className="text-center text-muted text-sm py-4">
          <Shield className="w-5 h-5 mx-auto mb-2 opacity-40" />
          <p>No services have watchdog enabled.</p>
          <p className="mt-1 text-xs opacity-60">
            Add <code className="bg-black/30 px-1 rounded">watchdog.enabled: true</code> to a service&apos;s server config in projects.json
          </p>
        </div>
      )}

      {/* Cooldown Warnings */}
      {inCooldown.length > 0 && (
        <div className="space-y-1">
          {inCooldown.map(state => (
            <div key={state.projectId} className="flex items-center gap-2 text-xs text-amber-400 bg-amber-400/5 border border-amber-400/15 rounded px-2.5 py-1.5">
              <Clock className="w-3.5 h-3.5 flex-shrink-0" />
              <span>
                <strong>{state.projectId}</strong> in cooldown until {formatTime(state.cooldownUntil!)} ({state.restartCount} restarts)
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Recent Events Log */}
      {recentEvents.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs text-muted uppercase tracking-wider font-semibold px-1 mb-1.5">
            Recent Events
          </div>
          {recentEvents.map(event => (
            <div
              key={event.id}
              className={`flex items-start gap-2 text-xs rounded px-2.5 py-1.5 border ${getEventColor(event.eventType)}`}
            >
              <span className="flex-shrink-0 mt-0.5">{getEventIcon(event.eventType)}</span>
              <div className="flex-1 min-w-0">
                <span className="font-medium text-white/80">{event.projectName}</span>
                <span className="text-white/50 ml-1.5">{event.message}</span>
              </div>
              <span className="text-white/30 flex-shrink-0 whitespace-nowrap" title={event.timestamp}>
                {formatRelative(event.timestamp)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
