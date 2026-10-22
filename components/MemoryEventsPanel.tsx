'use client';

import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, Brain, Trash2, RefreshCw, Clock, Cpu, HardDrive } from 'lucide-react';

interface MemoryEvent {
  id: string;
  timestamp: string;
  type: 'earlyoom_kill' | 'ollama_idle_unload';
  severity: 'critical' | 'warning' | 'info';
  killedPid?: string;
  killedProcess?: string;
  memAvailPercent?: string;
  swapFreePercent?: string;
  memoryInfo?: {
    total: number;
    used: number;
    free: number;
    available: number;
  };
  model?: string;
  message: string;
}

interface MemoryInfo {
  totalMB: number;
  availableMB: number;
  freeMB: number;
  swapTotalMB: number;
  swapFreeMB: number;
}

interface MemoryEventsResponse {
  events: MemoryEvent[];
  count: number;
  memoryInfo: MemoryInfo | null;
}

interface MemoryEventsPanelProps {
  onEventCountChange?: (count: number) => void;
}

export function MemoryEventsPanel({ onEventCountChange }: MemoryEventsPanelProps) {
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [memoryInfo, setMemoryInfo] = useState<MemoryInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchEvents = useCallback(async () => {
    try {
      const response = await fetch('/api/memory/events');
      const data: MemoryEventsResponse = await response.json();
      setEvents(data.events || []);
      setMemoryInfo(data.memoryInfo);
      onEventCountChange?.(data.count);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [onEventCountChange]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchEvents, 30000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  const clearEvents = async () => {
    try {
      await fetch('/api/memory/events', { method: 'DELETE' });
      setEvents([]);
      onEventCountChange?.(0);
    } catch {
      // Silently fail
    }
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const getMemPercent = (info: MemoryInfo) => {
    if (!info.totalMB) return 0;
    return Math.round(((info.totalMB - info.availableMB) / info.totalMB) * 100);
  };

  const getSwapPercent = (info: MemoryInfo) => {
    if (!info.swapTotalMB) return 0;
    return Math.round(((info.swapTotalMB - info.swapFreeMB) / info.swapTotalMB) * 100);
  };

  const getBarColor = (percent: number) => {
    if (percent >= 90) return 'bg-red-500';
    if (percent >= 75) return 'bg-amber-500';
    if (percent >= 50) return 'bg-blue-400';
    return 'bg-emerald-400';
  };

  if (isLoading) {
    return (
      <div className="p-4 text-center text-muted text-sm">
        Loading memory events...
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Current Memory Status */}
      {memoryInfo && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white/[0.03] rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <Cpu className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-xs font-medium text-white/60">RAM</span>
              <span className="text-xs text-white/40 ml-auto">
                {memoryInfo.totalMB - memoryInfo.availableMB} / {memoryInfo.totalMB} MB
              </span>
            </div>
            <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${getBarColor(getMemPercent(memoryInfo))}`}
                style={{ width: `${getMemPercent(memoryInfo)}%` }}
              />
            </div>
            <div className="text-right mt-1">
              <span className={`text-xs font-mono ${getMemPercent(memoryInfo) >= 90 ? 'text-red-400' : 'text-white/50'}`}>
                {getMemPercent(memoryInfo)}%
              </span>
            </div>
          </div>

          <div className="bg-white/[0.03] rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <HardDrive className="w-3.5 h-3.5 text-purple-400" />
              <span className="text-xs font-medium text-white/60">Swap</span>
              <span className="text-xs text-white/40 ml-auto">
                {memoryInfo.swapTotalMB - memoryInfo.swapFreeMB} / {memoryInfo.swapTotalMB} MB
              </span>
            </div>
            <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${getBarColor(getSwapPercent(memoryInfo))}`}
                style={{ width: `${getSwapPercent(memoryInfo)}%` }}
              />
            </div>
            <div className="text-right mt-1">
              <span className={`text-xs font-mono ${getSwapPercent(memoryInfo) >= 90 ? 'text-red-400' : 'text-white/50'}`}>
                {getSwapPercent(memoryInfo)}%
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Events List */}
      {events.length === 0 ? (
        <div className="text-center py-4 text-muted text-sm">
          No memory events recorded. earlyoom is monitoring.
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-white/40">{events.length} event{events.length !== 1 ? 's' : ''}</span>
            <div className="flex items-center gap-2">
              <button
                onClick={fetchEvents}
                className="text-xs text-white/40 hover:text-white/60 transition-colors flex items-center gap-1"
                aria-label="Refresh events"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
              <button
                onClick={clearEvents}
                className="text-xs text-white/40 hover:text-red-400 transition-colors flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" />
                Clear
              </button>
            </div>
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto">
            {events.map((event) => (
              <div
                key={event.id}
                className={`rounded-lg p-3 border ${
                  event.severity === 'critical'
                    ? 'bg-red-500/[0.06] border-red-500/20'
                    : event.severity === 'warning'
                    ? 'bg-amber-500/[0.06] border-amber-500/20'
                    : 'bg-blue-500/[0.06] border-blue-500/20'
                }`}
              >
                <div className="flex items-start gap-2">
                  {event.type === 'earlyoom_kill' ? (
                    <AlertTriangle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                      event.severity === 'critical' ? 'text-red-400' : 'text-amber-400'
                    }`} />
                  ) : (
                    <Brain className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-400" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white/80">
                        {event.type === 'earlyoom_kill'
                          ? `Process killed: ${event.killedProcess || 'unknown'}`
                          : `Model unloaded: ${event.model || 'unknown'}`
                        }
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${
                        event.severity === 'critical'
                          ? 'bg-red-500/20 text-red-300'
                          : event.severity === 'warning'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-blue-500/20 text-blue-300'
                      }`}>
                        {event.severity}
                      </span>
                    </div>
                    <p className="text-xs text-white/50 mt-1">{event.message}</p>
                    <div className="flex items-center gap-3 mt-1.5 text-[11px] text-white/30">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatTime(event.timestamp)}
                      </span>
                      {event.killedPid && event.killedPid !== 'unknown' && (
                        <span>PID {event.killedPid}</span>
                      )}
                      {event.memAvailPercent && event.memAvailPercent !== 'unknown' && (
                        <span>Mem: {event.memAvailPercent}% free</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
