'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Bell, X, CheckCheck, AlertCircle, AlertTriangle, Info, ChevronRight } from 'lucide-react';

interface Alert {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'info';
  message?: string;
  source?: string;
  createdAt: string;
  acknowledgedAt?: string;
}

interface AlertsResponse {
  alerts: Alert[];
  unacknowledgedCount: number;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const SEVERITY_CONFIG = {
  critical: {
    icon: AlertCircle,
    label: 'Critical',
    dot: 'ap-dot-critical',
    row: 'ap-row-critical',
    badge: 'ap-badge-critical',
  },
  high: {
    icon: AlertTriangle,
    label: 'High',
    dot: 'ap-dot-high',
    row: 'ap-row-high',
    badge: 'ap-badge-high',
  },
  medium: {
    icon: AlertTriangle,
    label: 'Medium',
    dot: 'ap-dot-medium',
    row: 'ap-row-medium',
    badge: 'ap-badge-medium',
  },
  info: {
    icon: Info,
    label: 'Info',
    dot: 'ap-dot-info',
    row: 'ap-row-info',
    badge: 'ap-badge-info',
  },
};

export function AlertsPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unacknowledgedCount, setUnacknowledgedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dismissing, setDismissing] = useState<Set<string>>(new Set());
  const wrapperRef = useRef<HTMLDivElement>(null);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch('/api/alerts?acknowledged=false&limit=20');
      if (!res.ok) return;
      const data: AlertsResponse = await res.json();
      setAlerts(data.alerts);
      setUnacknowledgedCount(data.unacknowledgedCount);
    } catch {
      // silent
    }
  }, []);

  // Initial fetch + 30s poll
  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 30000);
    return () => clearInterval(interval);
  }, [fetchAlerts]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleOpen = async () => {
    setIsOpen(prev => !prev);
    if (!isOpen) {
      setLoading(true);
      await fetchAlerts();
      setLoading(false);
    }
  };

  const dismiss = async (id: string) => {
    setDismissing(prev => new Set(prev).add(id));
    try {
      await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge', id }),
      });
      await fetchAlerts();
    } finally {
      setDismissing(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const dismissAll = async () => {
    try {
      await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge', all: true }),
      });
      await fetchAlerts();
    } catch {
      // silent
    }
  };

  const hasCritical = alerts.some(a => a.severity === 'critical');

  return (
    <div className="relative ap-wrapper" ref={wrapperRef}>
      {/* Bell button */}
      <button
        onClick={handleOpen}
        className={`action-button-pill ap-bell-btn ${isOpen ? 'bg-white/15 text-white border-white/20' : ''} ${hasCritical ? 'ap-bell-critical' : unacknowledgedCount > 0 ? 'text-amber-400/80' : 'text-white/40'}`}
        aria-label={`Alerts${unacknowledgedCount > 0 ? ` (${unacknowledgedCount} unacknowledged)` : ''}`}
        title="System Alerts"
      >
        <Bell className="w-4 h-4" />
        {unacknowledgedCount > 0 && (
          <span className={`ap-badge ${hasCritical ? 'ap-badge-critical-pulse' : 'ap-badge-default'}`} aria-hidden="true">
            {unacknowledgedCount > 9 ? '9+' : unacknowledgedCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div className="ap-panel" role="dialog" aria-label="System alerts">
          {/* Header */}
          <div className="ap-panel-header">
            <div className="flex items-center gap-2">
              <Bell className="w-3.5 h-3.5 text-white/60" />
              <span className="text-xs font-semibold text-white/80 tracking-wide uppercase">
                Alerts
              </span>
              {unacknowledgedCount > 0 && (
                <span className="ap-count-chip">{unacknowledgedCount}</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {alerts.length > 0 && (
                <button
                  onClick={dismissAll}
                  className="ap-clear-btn"
                  title="Dismiss all"
                >
                  <CheckCheck className="w-3 h-3" />
                  <span>Clear all</span>
                </button>
              )}
              <button
                onClick={() => setIsOpen(false)}
                className="ap-close-btn"
                aria-label="Close alerts panel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="ap-panel-body">
            {loading ? (
              <div className="ap-empty">
                <div className="ap-spinner" />
              </div>
            ) : alerts.length === 0 ? (
              <div className="ap-empty">
                <div className="ap-empty-icon">
                  <Bell className="w-5 h-5 text-white/20" />
                </div>
                <p className="ap-empty-text">No active alerts</p>
              </div>
            ) : (
              <ul className="ap-list" role="list">
                {alerts.map(alert => {
                  const cfg = SEVERITY_CONFIG[alert.severity];
                  const Icon = cfg.icon;
                  const isDismissing = dismissing.has(alert.id);
                  return (
                    <li key={alert.id} className={`ap-row ${cfg.row} ${isDismissing ? 'ap-row-dismissing' : ''}`}>
                      <div className={`ap-sev-dot ${cfg.dot}`} />
                      <div className="ap-row-content">
                        <div className="ap-row-top">
                          <Icon className="w-3 h-3 ap-row-icon flex-shrink-0" />
                          <span className="ap-row-title">{alert.title}</span>
                          <span className={`ap-sev-badge ${cfg.badge}`}>{cfg.label}</span>
                        </div>
                        {alert.message && (
                          <p className="ap-row-msg">{alert.message}</p>
                        )}
                        <div className="ap-row-meta">
                          {alert.source && (
                            <>
                              <span className="ap-row-source">{alert.source}</span>
                              <ChevronRight className="w-2.5 h-2.5 text-white/20" />
                            </>
                          )}
                          <span className="ap-row-time">{timeAgo(alert.createdAt)}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => dismiss(alert.id)}
                        disabled={isDismissing}
                        className="ap-dismiss-btn"
                        aria-label={`Dismiss alert: ${alert.title}`}
                        title="Dismiss"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
