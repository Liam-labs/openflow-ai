'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  Cloud,
  ArrowLeft,
  Plus,
  Trash2,
  Lock,
  Globe,
  ExternalLink,
  RefreshCw,
  Loader2,
  Shield,
  ShieldOff,
  Radio,
  ChevronUp,
  AlertCircle,
  X,
  Wifi,
  WifiOff,
  Zap,
  Mail,
  UserPlus,
  Check,
  Network,
  Clock,
} from 'lucide-react';
import type {
  GatewayService,
  GatewayActionResponse,
  SessionDuration,
} from '@/lib/types';

// ─── Duration options ───────────────────────────────────────
const DURATION_OPTIONS: { value: SessionDuration; label: string }[] = [
  { value: '24h', label: '1 Day' },
  { value: '336h', label: '14 Days' },
  { value: '720h', label: '30 Days' },
];

function durationLabel(dur: SessionDuration | null | undefined): string {
  return DURATION_OPTIONS.find(o => o.value === dur)?.label ?? '1 Day';
}

// ─── Helpers ─────────────────────────────────────────────────
function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ─── IP validation ───────────────────────────────────────────
function isValidIpOrCidr(input: string): boolean {
  // IPv4 (with optional CIDR)
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}(\/([0-9]|[1-2]\d|3[0-2]))?$/;
  if (ipv4.test(input)) {
    return input.split('/')[0].split('.').every(p => parseInt(p, 10) <= 255);
  }
  // IPv6 (with optional CIDR prefix length)
  const ipv6 = /^[0-9a-fA-F:]{2,39}(\/([0-9]|[1-9]\d|1[0-1]\d|12[0-8]))?$/;
  return ipv6.test(input) && input.includes(':');
}

// ─── Toast system ────────────────────────────────────────────
interface Toast {
  id: string;
  message: string;
  type: 'error' | 'success' | 'info';
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-3 px-4 py-3 rounded-xl border backdrop-blur-xl shadow-2xl animate-[slideUp_300ms_cubic-bezier(0.16,1,0.3,1)] ${
            t.type === 'error'
              ? 'bg-red-950/80 border-red-500/30 text-red-200'
              : t.type === 'success'
              ? 'bg-emerald-950/80 border-emerald-500/30 text-emerald-200'
              : 'bg-sky-950/80 border-sky-500/30 text-sky-200'
          }`}
        >
          {t.type === 'error' && <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          {t.type === 'success' && <Zap className="w-4 h-4 mt-0.5 shrink-0" />}
          {t.type === 'info' && <Radio className="w-4 h-4 mt-0.5 shrink-0" />}
          <p className="text-sm flex-1">{t.message}</p>
          <button
            onClick={() => onDismiss(t.id)}
            className="text-white/40 hover:text-white/80 transition-colors shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Skeleton card ───────────────────────────────────────────
function SkeletonCard() {
  return (
    <div className="glass-card p-6 rounded-2xl border border-white/10">
      <div className="flex items-start justify-between mb-4">
        <div className="space-y-2 flex-1">
          <div className="h-5 w-32 rounded-lg skeleton" />
          <div className="h-4 w-20 rounded-lg skeleton" />
        </div>
        <div className="h-6 w-16 rounded-full skeleton" />
      </div>
      <div className="h-4 w-full rounded-lg skeleton mb-3" />
      <div className="flex items-center gap-2 mt-4">
        <div className="h-8 w-20 rounded-xl skeleton" />
        <div className="h-8 w-8 rounded-xl skeleton" />
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────
export default function GatewayPage() {
  const [services, setServices] = useState<GatewayService[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // Form state
  const [formOpen, setFormOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formPort, setFormPort] = useState('');
  const [formLocked, setFormLocked] = useState(false);
  const [formSessionDuration, setFormSessionDuration] = useState<SessionDuration>('24h');
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Email management
  const [emailsOpen, setEmailsOpen] = useState<string | null>(null); // service name
  const [emailInput, setEmailInput] = useState('');
  const [emailsDraft, setEmailsDraft] = useState<string[]>([]);
  const [emailsSaving, setEmailsSaving] = useState(false);

  // Duration change state
  const [durationSaving, setDurationSaving] = useState<string | null>(null); // service name

  // IP management
  const [ipsOpen, setIpsOpen] = useState<string | null>(null); // service name
  const [ipInput, setIpInput] = useState('');
  const [ipsDraft, setIpsDraft] = useState<string[]>([]);
  const [ipsSaving, setIpsSaving] = useState(false);

  // ── Toast helpers ────────────────────────────────────────
  const addToast = useCallback((message: string, type: Toast['type'] = 'error') => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── API helpers ──────────────────────────────────────────
  const apiCall = useCallback(
    async (body: Record<string, unknown>): Promise<GatewayActionResponse> => {
      const res = await fetch('/api/gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    },
    []
  );

  const fetchServices = useCallback(
    async (showRefresh = false) => {
      if (showRefresh) setRefreshing(true);
      try {
        const result = await apiCall({ action: 'list' });
        if (result.success && result.data && 'services' in result.data) {
          setServices(result.data.services);
          setLastUpdated(result.data.lastUpdated);
        } else {
          addToast(result.error || 'Failed to load services');
        }
      } catch {
        addToast('Could not reach the gateway API');
      } finally {
        setLoading(false);
        if (showRefresh) setRefreshing(false);
      }
    },
    [apiCall, addToast]
  );

  // ── Polling ──────────────────────────────────────────────
  useEffect(() => {
    fetchServices();
    const interval = setInterval(() => fetchServices(), 15000);
    return () => clearInterval(interval);
  }, [fetchServices]);

  // ── Expose handler ───────────────────────────────────────
  const handleExpose = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const name = formName.trim();
    const port = parseInt(formPort, 10);

    if (!name) {
      setFormError('Name is required');
      return;
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      setFormError('Only lowercase letters, numbers, and hyphens');
      return;
    }
    if (!port || port < 1 || port > 65535) {
      setFormError('Port must be 1-65535');
      return;
    }

    setFormSubmitting(true);
    try {
      const result = await apiCall({
        action: 'expose',
        name,
        port,
        locked: formLocked,
        ...(formLocked && { sessionDuration: formSessionDuration }),
      });
      if (result.success) {
        addToast(`${name} exposed on port ${port}`, 'success');
        setFormName('');
        setFormPort('');
        setFormLocked(false);
        setFormSessionDuration('24h');
        setFormOpen(false);
        fetchServices();
      } else {
        setFormError(result.error || 'Failed to expose service');
      }
    } catch {
      setFormError('Network error');
    } finally {
      setFormSubmitting(false);
    }
  };

  // ── Lock / Unlock ────────────────────────────────────────
  const handleToggleLock = async (service: GatewayService) => {
    const action = service.locked ? 'unlock' : 'lock';
    setActionLoading(service.name);
    try {
      const result = await apiCall({
        action,
        name: service.name,
        ...(action === 'lock' && { sessionDuration: '24h' as SessionDuration }),
      });
      if (result.success) {
        addToast(
          `${service.name} is now ${action === 'lock' ? 'locked' : 'public'}`,
          'success'
        );
        fetchServices();
      } else {
        addToast(result.error || `Failed to ${action} service`);
      }
    } catch {
      addToast(`Failed to ${action} service`);
    } finally {
      setActionLoading(null);
    }
  };

  // ── Remove ───────────────────────────────────────────────
  const handleRemove = async (name: string) => {
    setConfirmDelete(null);
    setActionLoading(name);
    try {
      const result = await apiCall({ action: 'remove', name });
      if (result.success) {
        addToast(`${name} removed`, 'success');
        fetchServices();
      } else {
        addToast(result.error || 'Failed to remove service');
      }
    } catch {
      addToast('Failed to remove service');
    } finally {
      setActionLoading(null);
    }
  };

  // ── Email management ─────────────────────────────────────
  const [emailsSyncing, setEmailsSyncing] = useState(false);

  const openEmailManager = useCallback(async (svc: GatewayService) => {
    setIpsOpen(null); // mutual exclusion
    setEmailsOpen(svc.name);
    setEmailsDraft(svc.allowedEmails ?? []);
    setEmailInput('');

    // Sync from Cloudflare Access to ensure list matches actual policy
    if (svc.locked && svc.accessAppId) {
      setEmailsSyncing(true);
      try {
        const result = await fetch('/api/gateway', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sync-emails', name: svc.name }),
        }).then(r => r.json()) as GatewayActionResponse;

        if (result.success && result.data && 'allowedEmails' in result.data) {
          setEmailsDraft((result.data as GatewayService).allowedEmails ?? []);
        }
      } catch {
        // Silently fall back to cached data
      } finally {
        setEmailsSyncing(false);
      }
    }
  }, []);

  const addEmailToDraft = useCallback(() => {
    const email = emailInput.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      addToast('Invalid email address', 'error');
      return;
    }
    if (emailsDraft.includes(email)) {
      addToast('Email already in list', 'info');
      return;
    }
    setEmailsDraft((prev) => [...prev, email]);
    setEmailInput('');
  }, [emailInput, emailsDraft, addToast]);

  const removeEmailFromDraft = useCallback((email: string) => {
    setEmailsDraft((prev) => prev.filter((e) => e !== email));
  }, []);

  const saveEmails = useCallback(async (name: string) => {
    if (emailsDraft.length === 0) {
      addToast('Must have at least one allowed email', 'error');
      return;
    }
    setEmailsSaving(true);
    try {
      const result = await apiCall({ action: 'set-emails', name, emails: emailsDraft });
      if (result.success) {
        addToast(`Access list updated for ${name}`, 'success');
        setEmailsOpen(null);
        fetchServices();
      } else {
        addToast(result.error || 'Failed to update emails');
      }
    } catch {
      addToast('Network error');
    } finally {
      setEmailsSaving(false);
    }
  }, [emailsDraft, apiCall, addToast, fetchServices]);

  // ── IP management ────────────────────────────────────────
  const openIpManager = useCallback((svc: GatewayService) => {
    setEmailsOpen(null); // mutual exclusion
    setIpsOpen(svc.name);
    setIpsDraft(svc.allowedIps ?? []);
    setIpInput('');
  }, []);

  const addIpToDraft = useCallback(() => {
    const ip = ipInput.trim();
    if (!ip) return;
    if (!isValidIpOrCidr(ip)) {
      addToast('Invalid IP address or CIDR range (e.g. 10.0.0.1 or 192.168.1.0/24)', 'error');
      return;
    }
    if (ipsDraft.includes(ip)) {
      addToast('IP already in list', 'info');
      return;
    }
    setIpsDraft(prev => [...prev, ip]);
    setIpInput('');
  }, [ipInput, ipsDraft, addToast]);

  const removeIpFromDraft = useCallback((ip: string) => {
    setIpsDraft(prev => prev.filter(i => i !== ip));
  }, []);

  const saveIps = useCallback(async (name: string) => {
    setIpsSaving(true);
    try {
      const result = await apiCall({ action: 'set-ips', name, ips: ipsDraft });
      if (result.success) {
        addToast(`Trusted IPs updated for ${name}`, 'success');
        setIpsOpen(null);
        fetchServices();
      } else {
        addToast(result.error || 'Failed to update IPs');
      }
    } catch {
      addToast('Network error');
    } finally {
      setIpsSaving(false);
    }
  }, [ipsDraft, apiCall, addToast, fetchServices]);

  // ── Duration change ──────────────────────────────────────
  const handleDurationChange = useCallback(async (name: string, duration: SessionDuration) => {
    setDurationSaving(name);
    try {
      const result = await apiCall({ action: 'set-duration', name, sessionDuration: duration });
      if (result.success) {
        addToast(`Session duration updated to ${durationLabel(duration)}`, 'success');
        fetchServices();
      } else {
        addToast(result.error || 'Failed to update session duration');
      }
    } catch {
      addToast('Failed to update session duration');
    } finally {
      setDurationSaving(null);
    }
  }, [apiCall, addToast, fetchServices]);

  // ── Derived stats ────────────────────────────────────────
  const totalCount = services.length;
  const onlineCount = services.filter((s) => s.status === 'active').length;
  const lockedCount = services.filter((s) => s.locked).length;

  // ── Focus name input when form opens ─────────────────────
  useEffect(() => {
    if (formOpen && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [formOpen]);

  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      {/* Background glow */}
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background:
            'radial-gradient(ellipse at 30% 20%, rgba(56,189,248,0.08) 0%, transparent 50%), radial-gradient(ellipse at 70% 80%, rgba(14,165,233,0.06) 0%, transparent 50%)',
        }}
      />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* ─── Header ────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-8">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <Link
              href="/operations"
              className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-sky-500/30 transition-all shrink-0"
              title="Back to Dashboard"
            >
              <ArrowLeft className="w-4 h-4 text-white/70" />
            </Link>
            <div className="p-2.5 rounded-xl bg-sky-500/20 border border-sky-500/30 shrink-0">
              <Cloud className="w-6 h-6 text-sky-400" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-white tracking-tight">WebGate</h1>
              <p className="text-sm text-white/50 truncate">
                Cloud Gateway &mdash; Expose local services via Cloudflare Tunnels
              </p>
            </div>
          </div>

          <button
            onClick={() => fetchServices(true)}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-sky-500/30 text-white/70 text-sm transition-all disabled:opacity-40 shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {/* ─── Stats Row ─────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-3 sm:gap-4 mb-6">
          <div className="glass-card px-4 py-3 rounded-2xl border border-white/10">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-sky-500/15">
                <Cloud className="w-4 h-4 text-sky-400" />
              </div>
              <div>
                <p className="text-xs text-white/40 uppercase tracking-wider font-medium">Services</p>
                <p className="text-xl font-bold text-white tabular-nums">
                  {loading ? <span className="inline-block w-6 h-5 skeleton rounded" /> : totalCount}
                </p>
              </div>
            </div>
          </div>

          <div className="glass-card px-4 py-3 rounded-2xl border border-white/10">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-green-500/15">
                <Wifi className="w-4 h-4 text-green-400" />
              </div>
              <div>
                <p className="text-xs text-white/40 uppercase tracking-wider font-medium">Online</p>
                <p className="text-xl font-bold text-white tabular-nums">
                  {loading ? <span className="inline-block w-6 h-5 skeleton rounded" /> : onlineCount}
                </p>
              </div>
            </div>
          </div>

          <div className="glass-card px-4 py-3 rounded-2xl border border-white/10">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-amber-500/15">
                <Shield className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <p className="text-xs text-white/40 uppercase tracking-wider font-medium">Locked</p>
                <p className="text-xl font-bold text-white tabular-nums">
                  {loading ? <span className="inline-block w-6 h-5 skeleton rounded" /> : lockedCount}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ─── Add New Service ────────────────────────────── */}
        <div className="mb-6">
          <button
            onClick={() => setFormOpen(!formOpen)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              formOpen
                ? 'bg-sky-500/20 border border-sky-500/40 text-sky-300'
                : 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:border-sky-500/30 hover:text-sky-300'
            }`}
          >
            {formOpen ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {formOpen ? 'Close' : 'Expose New Service'}
          </button>

          {formOpen && (
            <div className="mt-3 glass-card p-5 rounded-2xl border border-white/10 animate-[slideDown_250ms_cubic-bezier(0.16,1,0.3,1)]">
              <form onSubmit={handleExpose} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_auto] gap-3 items-end">
                  {/* Name */}
                  <div>
                    <label className="block text-xs text-white/50 mb-1.5 font-medium uppercase tracking-wider">
                      Service Name
                    </label>
                    <input
                      ref={nameInputRef}
                      type="text"
                      value={formName}
                      onChange={(e) => {
                        setFormName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                        setFormError(null);
                      }}
                      placeholder="my-service"
                      className="glass-input rounded-xl text-sm"
                      disabled={formSubmitting}
                    />
                  </div>

                  {/* Port */}
                  <div>
                    <label className="block text-xs text-white/50 mb-1.5 font-medium uppercase tracking-wider">
                      Port
                    </label>
                    <input
                      type="number"
                      value={formPort}
                      onChange={(e) => {
                        setFormPort(e.target.value);
                        setFormError(null);
                      }}
                      placeholder="3000"
                      min={1}
                      max={65535}
                      className="glass-input rounded-xl text-sm"
                      disabled={formSubmitting}
                    />
                  </div>

                  {/* Lock toggle + duration + submit */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setFormLocked(!formLocked)}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm border transition-all ${
                        formLocked
                          ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                          : 'bg-white/5 border-white/10 text-white/50 hover:bg-white/10'
                      }`}
                      title={formLocked ? 'Cloudflare Access enabled' : 'Public (no auth)'}
                    >
                      {formLocked ? (
                        <Lock className="w-4 h-4" />
                      ) : (
                        <Globe className="w-4 h-4" />
                      )}
                      {formLocked ? 'Locked' : 'Public'}
                    </button>

                    {formLocked && (
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-amber-400/60" />
                        <select
                          value={formSessionDuration}
                          onChange={(e) => setFormSessionDuration(e.target.value as SessionDuration)}
                          className="glass-input rounded-lg text-xs py-1.5 px-2 pr-6 text-amber-300 border-amber-500/20 bg-amber-500/10 cursor-pointer"
                          disabled={formSubmitting}
                        >
                          {DURATION_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={formSubmitting || !formName || !formPort}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-sky-500/20 border border-sky-500/30 text-sky-300 hover:bg-sky-500/30 hover:border-sky-500/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {formSubmitting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Zap className="w-4 h-4" />
                      )}
                      Expose
                    </button>
                  </div>
                </div>

                {formError && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-950/50 border border-red-500/20 text-red-300 text-sm">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {formError}
                  </div>
                )}
              </form>
            </div>
          )}
        </div>

        {/* ─── Loading State ─────────────────────────────── */}
        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {/* ─── Empty State ───────────────────────────────── */}
        {!loading && services.length === 0 && (
          <div className="glass-card p-12 rounded-2xl border border-white/10 text-center">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mb-5">
              <WifiOff className="w-8 h-8 text-sky-400/50" />
            </div>
            <h2 className="text-lg font-semibold text-white/80 mb-2">No services exposed</h2>
            <p className="text-sm text-white/40 max-w-md mx-auto mb-6">
              Expose a local service through your Cloudflare Tunnel to make it accessible from the internet.
            </p>
            <button
              onClick={() => {
                setFormOpen(true);
              }}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-sky-500/20 border border-sky-500/30 text-sky-300 hover:bg-sky-500/30 hover:border-sky-500/50 transition-all"
            >
              <Plus className="w-4 h-4" />
              Expose your first service
            </button>
          </div>
        )}

        {/* ─── Service Cards Grid ────────────────────────── */}
        {!loading && services.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {services.map((svc, index) => {
              const isOnline = svc.status === 'active';
              const isError = svc.status === 'error';
              const isCurrentAction = actionLoading === svc.name;

              return (
                <div
                  key={svc.name}
                  className="glass-card p-5 rounded-2xl border border-white/10 flex flex-col"
                  style={{ animationDelay: `${index * 60}ms` }}
                >
                  {/* Top row: name + status */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-semibold text-white truncate">{svc.name}</h3>
                      <p className="text-sm text-white/40 tabular-nums mt-0.5">Port {svc.port}</p>
                    </div>

                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium shrink-0 ml-3 ${
                        isOnline
                          ? 'bg-green-500/15 text-green-400 border border-green-500/20'
                          : isError
                          ? 'bg-red-500/15 text-red-400 border border-red-500/20'
                          : 'bg-white/5 text-white/40 border border-white/10'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          isOnline
                            ? 'bg-green-400 shadow-[0_0_6px_rgba(34,197,94,0.6)]'
                            : isError
                            ? 'bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.6)]'
                            : 'bg-white/30'
                        }`}
                      />
                      {isOnline ? 'Online' : isError ? 'Error' : 'Offline'}
                    </span>
                  </div>

                  {/* URL */}
                  <a
                    href={svc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-sky-400 hover:text-sky-300 transition-colors mb-3 truncate group"
                  >
                    <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" />
                    <span className="truncate">{svc.url.replace(/^https?:\/\//, '')}</span>
                  </a>

                  {/* Auth badge + created date */}
                  <div className="flex items-center gap-2 mb-4">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-medium ${
                        svc.locked
                          ? 'bg-amber-500/12 text-amber-400 border border-amber-500/20'
                          : 'bg-emerald-500/12 text-emerald-400 border border-emerald-500/20'
                      }`}
                    >
                      {svc.locked ? (
                        <Lock className="w-3 h-3" />
                      ) : (
                        <Globe className="w-3 h-3" />
                      )}
                      {svc.locked ? 'Locked' : 'Public'}
                    </span>

                    <span className="text-xs text-white/30 ml-auto">
                      {relativeTime(svc.createdAt)}
                    </span>
                  </div>

                  {/* Session duration (locked services only) */}
                  {svc.locked && (
                    <div className="flex items-center gap-2 mb-3">
                      <Clock className="w-3.5 h-3.5 text-sky-400/50 shrink-0" />
                      <span className="text-xs text-white/40">Session:</span>
                      <select
                        value={svc.sessionDuration ?? '24h'}
                        onChange={(e) => handleDurationChange(svc.name, e.target.value as SessionDuration)}
                        disabled={durationSaving === svc.name}
                        className="glass-input rounded-lg text-xs py-1 px-2 pr-6 text-white/70 border-white/10 bg-white/5 cursor-pointer disabled:opacity-40"
                      >
                        {DURATION_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                      {durationSaving === svc.name && (
                        <Loader2 className="w-3 h-3 animate-spin text-sky-400/50" />
                      )}
                    </div>
                  )}

                  {/* Email access panel (locked services only) */}
                  {svc.locked && emailsOpen === svc.name && (
                    <div className="mt-3 p-3 rounded-xl bg-white/[0.03] border border-amber-500/20 animate-[slideDown_200ms_ease-out]">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-medium text-amber-400/80 flex items-center gap-1.5">
                          <Mail className="w-3 h-3" />
                          Allowed Emails
                        </p>
                        {emailsSyncing && (
                          <span className="flex items-center gap-1 text-xs text-white/30">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Syncing from Cloudflare…
                          </span>
                        )}
                      </div>

                      {/* Current list */}
                      <div className="space-y-1 mb-2 max-h-28 overflow-y-auto">
                        {emailsSyncing ? (
                          <p className="text-xs text-white/30 italic">Loading from Cloudflare Access…</p>
                        ) : emailsDraft.length === 0 ? (
                          <p className="text-xs text-white/30 italic">No emails — add one below</p>
                        ) : (
                          emailsDraft.map((email) => (
                            <div key={email} className="flex items-center justify-between gap-2 px-2 py-1 rounded-lg bg-white/5">
                              <span className="text-xs text-white/70 truncate">{email}</span>
                              <button
                                onClick={() => removeEmailFromDraft(email)}
                                className="text-white/30 hover:text-red-400 transition-colors shrink-0"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))
                        )}
                      </div>

                      {/* Add email input */}
                      <div className="flex gap-1.5 mb-2">
                        <input
                          type="email"
                          value={emailInput}
                          onChange={(e) => setEmailInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addEmailToDraft())}
                          placeholder="add@email.com"
                          className="glass-input rounded-lg text-xs flex-1 py-1.5 px-2"
                        />
                        <button
                          onClick={addEmailToDraft}
                          className="p-1.5 rounded-lg bg-amber-500/15 border border-amber-500/25 text-amber-400 hover:bg-amber-500/25 transition-all"
                          title="Add email"
                        >
                          <UserPlus className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Save / Cancel */}
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => saveEmails(svc.name)}
                          disabled={emailsSaving || emailsDraft.length === 0}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:bg-amber-500/30 transition-all disabled:opacity-40"
                        >
                          {emailsSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                          Save
                        </button>
                        <button
                          onClick={() => setEmailsOpen(null)}
                          className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 text-white/50 hover:bg-white/10 transition-all"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* IP access panel (locked services only) */}
                  {svc.locked && ipsOpen === svc.name && (
                    <div className="mt-3 p-3 rounded-xl bg-white/[0.03] border border-violet-500/20 animate-[slideDown_200ms_ease-out]">
                      <p className="text-xs font-medium text-violet-400/80 mb-2 flex items-center gap-1.5">
                        <Network className="w-3 h-3" />
                        Trusted IP Addresses
                      </p>

                      {/* Current list */}
                      <div className="space-y-1 mb-2 max-h-28 overflow-y-auto">
                        {ipsDraft.length === 0 ? (
                          <p className="text-xs text-white/30 italic">No trusted IPs — all traffic goes through Cloudflare Access</p>
                        ) : (
                          ipsDraft.map((ip) => (
                            <div key={ip} className="flex items-center justify-between gap-2 px-2 py-1 rounded-lg bg-white/5">
                              <span className="text-xs text-white/70 font-mono truncate">{ip}</span>
                              <button
                                onClick={() => removeIpFromDraft(ip)}
                                className="text-white/30 hover:text-red-400 transition-colors shrink-0"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))
                        )}
                      </div>

                      {/* Add IP input */}
                      <div className="flex gap-1.5 mb-2">
                        <input
                          type="text"
                          value={ipInput}
                          onChange={(e) => setIpInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addIpToDraft())}
                          placeholder="192.168.1.0/24 or 10.0.0.1"
                          className="glass-input rounded-lg text-xs flex-1 py-1.5 px-2 font-mono"
                        />
                        <button
                          onClick={addIpToDraft}
                          className="p-1.5 rounded-lg bg-violet-500/15 border border-violet-500/25 text-violet-400 hover:bg-violet-500/25 transition-all"
                          title="Add IP"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Save / Cancel */}
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => saveIps(svc.name)}
                          disabled={ipsSaving}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-500/20 border border-violet-500/30 text-violet-300 hover:bg-violet-500/30 transition-all disabled:opacity-40"
                        >
                          {ipsSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                          Save
                        </button>
                        <button
                          onClick={() => setIpsOpen(null)}
                          className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 text-white/50 hover:bg-white/10 transition-all"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-2 mt-auto pt-3 border-t border-white/5">
                    <button
                      onClick={() => handleToggleLock(svc)}
                      disabled={isCurrentAction}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all disabled:opacity-40 ${
                        svc.locked
                          ? 'bg-white/5 border-white/10 text-white/60 hover:bg-emerald-500/10 hover:border-emerald-500/20 hover:text-emerald-400'
                          : 'bg-white/5 border-white/10 text-white/60 hover:bg-amber-500/10 hover:border-amber-500/20 hover:text-amber-400'
                      }`}
                      title={svc.locked ? 'Make public' : 'Enable Cloudflare Access'}
                    >
                      {isCurrentAction ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : svc.locked ? (
                        <ShieldOff className="w-3.5 h-3.5" />
                      ) : (
                        <Shield className="w-3.5 h-3.5" />
                      )}
                      {svc.locked ? 'Unlock' : 'Lock'}
                    </button>

                    {/* Manage emails button (locked services only) */}
                    {svc.locked && (
                      <button
                        onClick={() => emailsOpen === svc.name ? setEmailsOpen(null) : openEmailManager(svc)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                          emailsOpen === svc.name
                            ? 'bg-amber-500/20 border-amber-500/30 text-amber-300'
                            : 'bg-white/5 border-white/10 text-white/60 hover:bg-amber-500/10 hover:border-amber-500/20 hover:text-amber-400'
                        }`}
                        title="Manage allowed emails"
                      >
                        <Mail className="w-3.5 h-3.5" />
                        {(svc.allowedEmails?.length ?? 0) > 0
                          ? `${svc.allowedEmails!.length} email${svc.allowedEmails!.length !== 1 ? 's' : ''}`
                          : 'Emails'}
                      </button>
                    )}

                    {/* Manage trusted IPs button (locked services only) */}
                    {svc.locked && (
                      <button
                        onClick={() => ipsOpen === svc.name ? setIpsOpen(null) : openIpManager(svc)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                          ipsOpen === svc.name
                            ? 'bg-violet-500/20 border-violet-500/30 text-violet-300'
                            : 'bg-white/5 border-white/10 text-white/60 hover:bg-violet-500/10 hover:border-violet-500/20 hover:text-violet-400'
                        }`}
                        title="Manage trusted IP addresses"
                      >
                        <Network className="w-3.5 h-3.5" />
                        {(svc.allowedIps?.length ?? 0) > 0
                          ? `${svc.allowedIps!.length} IP${svc.allowedIps!.length !== 1 ? 's' : ''}`
                          : 'IPs'}
                      </button>
                    )}

                    <div className="ml-auto relative">
                      {confirmDelete === svc.name ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-red-400">Remove?</span>
                          <button
                            onClick={() => handleRemove(svc.name)}
                            className="px-2 py-1 rounded-lg text-xs font-medium bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 transition-all"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="px-2 py-1 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/50 hover:bg-white/10 transition-all"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(svc.name)}
                          disabled={isCurrentAction}
                          className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-40"
                          title="Remove service"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ─── Footer ────────────────────────────────────── */}
        {lastUpdated && !loading && (
          <p className="text-center text-white/25 text-xs mt-8">
            Last updated {relativeTime(lastUpdated)}
          </p>
        )}
      </div>

      {/* Toast container */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {/* Keyframe for toast slide-up and form slide-down */}
      <style jsx global>{`
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(12px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
