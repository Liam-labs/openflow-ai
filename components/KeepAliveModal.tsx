'use client';

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Activity, X, Clock, RefreshCw, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react';

interface KeepAliveModalProps {
  participant: {
    id: string;
    name: string;
    color?: string;
    type: string;
  };
  channelId: string;
  agentId?: string;
  onClose: () => void;
  onStarted?: () => void;
  onStopped?: () => void;
}

interface KeepAliveStatus {
  active: boolean;
  goal?: string;
  duration?: string;
  interval?: string;
  selfEvolving?: boolean;
  startedAt?: string;
  expiresAt?: string;
  lastPingedAt?: string;
  nextPingAt?: string;
}

const DURATION_OPTIONS = [
  { value: '1h', label: '1 hour' },
  { value: '2h', label: '2 hours' },
  { value: '4h', label: '4 hours' },
  { value: '8h', label: '8 hours' },
  { value: 'indefinite', label: 'Indefinite' },
];

const INTERVAL_OPTIONS = [
  { value: '5m', label: 'Every 5 min' },
  { value: '10m', label: 'Every 10 min' },
  { value: '15m', label: 'Every 15 min' },
  { value: '30m', label: 'Every 30 min' },
  { value: '1h', label: 'Every hour' },
];

function formatTimeRemaining(isoAt: string, _now: number): string {
  const now = Date.now();
  const target = new Date(isoAt).getTime();
  const diffMs = target - now;

  if (diffMs <= 0) return 'Expired';

  const totalSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  if (minutes > 0) return `${minutes}m ${seconds}s remaining`;
  return `${seconds}s remaining`;
}

function formatCountdown(isoAt: string, _now: number): string {
  const now = Date.now();
  const target = new Date(isoAt).getTime();
  const diffMs = target - now;

  if (diffMs <= 0) return 'now';

  const totalSec = Math.floor(diffMs / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;

  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatRelativeTime(isoAt: string): string {
  const diffMs = Date.now() - new Date(isoAt).getTime();
  if (diffMs < 0) return 'just now';
  const totalSec = Math.floor(diffMs / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const minutes = Math.floor(totalSec / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function formatElapsed(startedAt: string): string {
  const now = Date.now();
  const started = new Date(startedAt).getTime();
  const diffMs = now - started;

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function KeepAliveModal({
  participant,
  channelId,
  agentId,
  onClose,
  onStarted,
  onStopped,
}: KeepAliveModalProps) {
  const [status, setStatus] = useState<KeepAliveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(Date.now());

  // Form state
  const [goal, setGoal] = useState('');
  const [duration, setDuration] = useState('4h');
  const [interval, setPingInterval] = useState('15m');
  const [selfEvolving, setSelfEvolving] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/keep-alive?channelId=${channelId}&agentId=${agentId}`);
      const data = await res.json();

      if (data.success && data.active) {
        const cfg = data.config;
        setStatus({
          active: true,
          goal: cfg?.goal,
          duration: cfg?.duration,
          interval: cfg?.interval,
          selfEvolving: cfg?.selfEvolving,
          startedAt: cfg?.startedAt,
          expiresAt: cfg?.expiresAt,
          lastPingedAt: cfg?.lastPingedAt,
          nextPingAt: data.nextPingAt,
        });
        setGoal(cfg?.goal ?? '');
        setDuration(cfg?.duration ?? '4h');
        setPingInterval(cfg?.interval ?? '15m');
        setSelfEvolving(cfg?.selfEvolving ?? false);
      } else {
        setStatus({ active: false });
      }
    } catch {
      setStatus({ active: false });
    } finally {
      setLoading(false);
    }
  }, [channelId, agentId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Real-time 1s tick for countdown displays
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const handleStart = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/keep-alive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'start',
          channelId,
          agentId,
          goal,
          duration,
          interval,
          selfEvolving,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to start keep-alive');
      }
      await fetchStatus();
      onStarted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start keep-alive');
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/keep-alive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'stop',
          channelId,
          agentId,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to stop keep-alive');
      }
      await fetchStatus();
      onStopped?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop keep-alive');
    } finally {
      setActionLoading(false);
    }
  };

  const handleUpdate = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/keep-alive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'update',
          channelId,
          agentId,
          goal,
          duration,
          interval,
          selfEvolving,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to update keep-alive');
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update keep-alive');
    } finally {
      setActionLoading(false);
    }
  };

  if (typeof document === 'undefined') return null;

  const isActive = status?.active ?? false;

  const modalContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-[#0f1d32]/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl overflow-hidden">

        {/* Active pulse bar */}
        {isActive && (
          <div className="h-0.5 w-full bg-gradient-to-r from-green-500/0 via-green-500 to-green-500/0 animate-pulse" />
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className={`p-1.5 rounded-lg ${isActive ? 'bg-green-500/20' : 'bg-purple-500/20'}`}>
              <Activity className={`w-4 h-4 ${isActive ? 'text-green-400' : 'text-purple-400'}`} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Keep Alive</h2>
              <p className="text-xs text-white/50">{participant.name}</p>
            </div>
            {isActive && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-500/15 border border-green-500/25 text-green-400 text-xs font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                Active
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-white/40 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">

          {/* Loading state */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
            </div>
          ) : (
            <>
              {/* Active status panel */}
              {isActive && status?.startedAt && (
                <div className="rounded-lg bg-green-500/10 border border-green-500/20 overflow-hidden">
                  {/* Top row: countdown to expiry + elapsed */}
                  <div className="flex items-center justify-between px-3 py-2.5">
                    <div className="flex items-center gap-2 text-green-400 text-xs">
                      <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                      {status.expiresAt ? (
                        <span>
                          <span className="font-semibold tabular-nums">{formatTimeRemaining(status.expiresAt, tick)}</span>
                        </span>
                      ) : (
                        <span>Running</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-white/35 text-xs">
                      <Clock className="w-3 h-3" />
                      <span>started {formatElapsed(status.startedAt)} ago</span>
                    </div>
                  </div>
                  {/* Ping row */}
                  <div className="flex items-center justify-between px-3 py-2 bg-black/20 border-t border-green-500/10">
                    <div className="flex items-center gap-1.5 text-white/35 text-xs">
                      <Activity className="w-3 h-3" />
                      <span>Last ping: {status.lastPingedAt ? formatRelativeTime(status.lastPingedAt) : 'not yet'}</span>
                    </div>
                    {status.nextPingAt && (
                      <div className="flex items-center gap-1 text-white/35 text-xs font-mono">
                        <span className="text-white/20">next</span>
                        <span className="text-white/55 tabular-nums">{formatCountdown(status.nextPingAt, tick)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Goal textarea */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-white/60 uppercase tracking-wide">
                  Objective
                </label>
                <textarea
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="Describe the work objective... This becomes the agent's roadmap."
                  rows={4}
                  className="w-full bg-white/5 border border-white/10 text-white rounded-lg px-3 py-2 text-sm resize-y min-h-[100px] placeholder:text-white/30 focus:outline-none focus:border-purple-500/50 focus:bg-white/8 transition-colors"
                />
              </div>

              {/* Duration + Interval row */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-white/60 uppercase tracking-wide">
                    Duration
                  </label>
                  <select
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500/50 transition-colors appearance-none cursor-pointer"
                  >
                    {DURATION_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value} className="bg-[#0f1d32]">
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-white/60 uppercase tracking-wide">
                    Ping Interval
                  </label>
                  <select
                    value={interval}
                    onChange={(e) => setPingInterval(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500/50 transition-colors appearance-none cursor-pointer"
                  >
                    {INTERVAL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value} className="bg-[#0f1d32]">
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Self-Evolving toggle */}
              <div className="flex items-start justify-between gap-4 p-3 rounded-lg bg-white/3 border border-white/8">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-white">Self-Evolving Mode</p>
                  <p className="text-xs text-white/40">
                    Agent will autonomously escalate to researchers when blocked
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={selfEvolving}
                  onClick={() => setSelfEvolving(!selfEvolving)}
                  className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50 ${
                    selfEvolving ? 'bg-purple-500' : 'bg-white/10'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 left-0 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                      selfEvolving ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>

              {/* Error */}
              {error && (
                <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  <p className="text-xs text-red-300">{error}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && (
          <div className="flex items-center gap-2 px-5 py-4 border-t border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-sm text-white/50 hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>

            <div className="flex-1" />

            {isActive ? (
              <>
                <button
                  type="button"
                  onClick={handleUpdate}
                  disabled={actionLoading}
                  className="px-3 py-1.5 rounded-lg text-sm bg-white/10 hover:bg-white/15 text-white/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  {actionLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  Update
                </button>
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={actionLoading}
                  className="px-3 py-1.5 rounded-lg text-sm bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  {actionLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Activity className="w-3.5 h-3.5" />
                  )}
                  Stop Keep Alive
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                disabled={actionLoading}
                className="px-3 py-1.5 rounded-lg text-sm bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {actionLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Activity className="w-3.5 h-3.5" />
                )}
                Start Keep Alive
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
