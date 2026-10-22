'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Brain, Shield, AlertTriangle, Info } from 'lucide-react';
import type { SystemsNavState } from './systems-types';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface MemoryEvent {
  id: string;
  timestamp: string;
  type: 'earlyoom_kill' | 'ollama_idle_unload';
  severity: 'critical' | 'warning' | 'info';
  killedProcess?: string;
  memAvailPercent?: string;
  model?: string;
  message: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ef4444',
  warning:  '#eab308',
  info:     '#71717a',
};

function SeverityIcon({ severity }: { severity: string }) {
  const color = SEVERITY_COLOR[severity] ?? '#71717a';
  if (severity === 'critical') return <AlertTriangle size={12} style={{ color, flexShrink: 0 }} />;
  if (severity === 'warning')  return <AlertTriangle size={12} style={{ color, flexShrink: 0 }} />;
  return <Info size={12} style={{ color, flexShrink: 0 }} />;
}

// ─── Event row ─────────────────────────────────────────────────────────────────

function EventRow({ event }: { event: MemoryEvent }) {
  const color = SEVERITY_COLOR[event.severity] ?? '#71717a';
  const subject = event.killedProcess || event.model || '';

  return (
    <div className="mew-row">
      <SeverityIcon severity={event.severity} />
      <div className="mew-row__body">
        <span className="mew-row__msg" style={{ color: 'rgba(228,228,231,0.85)' }}>
          {event.type === 'earlyoom_kill' ? (
            <>OOM killed <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{subject}</span></>
          ) : (
            <>Unloaded <span style={{ color: '#a78bfa', fontFamily: 'monospace' }}>{subject}</span></>
          )}
        </span>
        {event.memAvailPercent && !isNaN(parseFloat(event.memAvailPercent)) && (
          <span className="mew-row__mem" style={{ color }}>
            {parseFloat(event.memAvailPercent).toFixed(1)}% avail
          </span>
        )}
      </div>
      <span className="mew-row__time">{formatRelative(event.timestamp)}</span>
    </div>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────

interface MemoryEventWidgetProps {
  onNavigate?: (state: Partial<SystemsNavState>) => void;
}

export function MemoryEventWidget({ onNavigate }: MemoryEventWidgetProps) {
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [criticalCount, setCriticalCount] = useState(0);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/memory/events?limit=8');
      if (!res.ok) return;
      const data = await res.json();
      const evts: MemoryEvent[] = data.events ?? [];
      setEvents(evts.slice(0, 6));
      setCriticalCount(evts.filter((e) => e.severity === 'critical').length);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => clearInterval(id);
  }, [fetch_]);

  if (events.length === 0) return null;

  return (
    <div className="sov-panel">
      <div className="sov-panel__header">
        <span className="sov-panel__title">
          <Brain size={14} style={{ color: '#a855f7' }} />
          Memory
        </span>
        {criticalCount > 0 && (
          <span className="mew-crit-badge">{criticalCount} critical</span>
        )}
        {onNavigate && (
          <button
            className="sov-panel__link"
            onClick={() => onNavigate({ section: 'memory' })}
          >
            All events →
          </button>
        )}
      </div>
      <div className="sov-panel__body mew-body">
        {events.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}
      </div>
    </div>
  );
}
