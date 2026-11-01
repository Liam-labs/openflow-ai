'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X,
  Check,
  AlertTriangle,
  XCircle,
  Minus,
  RefreshCw,
  Loader2,
  Play,
  ChevronDown,
  ChevronRight,
  Monitor,
  Terminal,
  Wifi,
  ArrowRight,
} from 'lucide-react';

// ─── Types (mirrors wizard route) ────────────────────────────────────────────

interface WizardFix {
  instructions: string;
  commands: string[];
  automatable?: string;
}

interface WizardCheckResult {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
  fix: WizardFix | null;
}

interface WizardGroup {
  id: string;
  label: string;
  items: WizardCheckResult[];
}

interface WizardSummary {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
}

interface WizardResponse {
  success: boolean;
  supported?: boolean;
  unsupportedReason?: string;
  backend: 'api' | 'max';
  groups: WizardGroup[];
  allPassed: boolean;
  summary: WizardSummary;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface SetupWizardModalProps {
  initialBackend: 'api' | 'max';
  onClose: () => void;
}

// ─── Status icon ─────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: WizardCheckResult['status'] }) {
  if (status === 'pass') return <Check className="w-4 h-4 text-green-400 flex-shrink-0" />;
  if (status === 'fail') return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
  if (status === 'warn') return <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0" />;
  return <Minus className="w-4 h-4 text-white/20 flex-shrink-0" />;
}

// ─── Group icon ───────────────────────────────────────────────────────────────

function GroupIcon({ id }: { id: string }) {
  if (id === 'wsl') return <Terminal className="w-4 h-4 text-blue-400" />;
  if (id === 'windows') return <Monitor className="w-4 h-4 text-purple-400" />;
  return <Wifi className="w-4 h-4 text-cyan-400" />;
}

// ─── Individual check row ─────────────────────────────────────────────────────

function CheckRow({ item, onAutoFixed }: { item: WizardCheckResult; onAutoFixed: () => void }) {
  const [expanded, setExpanded] = useState(item.status === 'fail');
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<{ success: boolean; output?: string; error?: string } | null>(null);

  const hasFix = item.fix !== null;
  const isSkipped = item.status === 'skip';
  const skipReason = isSkipped ? item.detail : undefined;

  const handleFix = useCallback(async () => {
    if (!item.fix?.automatable || fixing) return;
    setFixing(true);
    setFixResult(null);
    try {
      const res = await fetch('/api/computer-use/wizard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: item.fix.automatable }),
      });
      const data = await res.json() as { success: boolean; output?: string; error?: string };
      setFixResult(data);
      // Auto re-run checks after a successful fix so the user sees the status flip
      // without having to find the footer "Re-run checks" button.
      if (data.success) {
        setTimeout(() => onAutoFixed(), 800);
      }
    } catch (err) {
      setFixResult({ success: false, error: (err as Error).message });
    } finally {
      setFixing(false);
    }
  }, [item.fix, fixing, onAutoFixed]);

  return (
    <div className={`rounded-lg transition-colors ${isSkipped ? 'opacity-60' : ''}`}>
      <div
        className={`flex items-center gap-3 px-3 py-2 rounded-lg ${
          hasFix && !isSkipped ? 'cursor-pointer hover:bg-white/5' : ''
        }`}
        onClick={() => hasFix && !isSkipped && setExpanded(v => !v)}
        role={hasFix && !isSkipped ? 'button' : undefined}
        aria-expanded={hasFix && !isSkipped ? expanded : undefined}
        title={skipReason ? `Skipped: ${skipReason}` : undefined}
      >
        <StatusIcon status={item.status} />
        <div className="flex-1 min-w-0">
          <span className="text-sm text-white/90">{item.label}</span>
          <span className={`ml-2 text-xs ${
            item.status === 'pass' ? 'text-white/50' :
            item.status === 'fail' ? 'text-red-400/80' :
            item.status === 'warn' ? 'text-yellow-400/80' :
            'text-white/40'
          }`}>{item.detail}</span>
        </div>
        {hasFix && !isSkipped && (
          <ChevronDown className={`w-3.5 h-3.5 text-white/40 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        )}
      </div>

      {/* Expanded fix section */}
      {expanded && item.fix && !isSkipped && (
        <div className="ml-7 mr-3 mb-2 p-3 bg-black/30 rounded-lg border border-white/[0.06]">
          <p className="text-xs text-white/60 mb-2">{item.fix.instructions}</p>
          <div className="space-y-1 mb-3">
            {item.fix.commands.map((cmd, i) => (
              <code key={i} className="block text-xs font-mono text-amber-300/80 bg-black/40 px-2 py-1 rounded">
                {cmd}
              </code>
            ))}
          </div>
          {item.fix.automatable && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleFix}
                disabled={fixing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-blue-500/20 text-blue-300 border border-blue-500/20 hover:bg-blue-500/30 transition-colors disabled:opacity-50"
              >
                {fixing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {fixing ? 'Running...' : 'Auto-fix'}
              </button>
              {fixResult && (
                <span className={`text-xs ${fixResult.success ? 'text-green-400' : 'text-red-400'}`}>
                  {fixResult.success ? '✓ Done' : `✗ ${fixResult.error ?? 'Failed'}`}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Group card ────────────────────────────────────────────────────────────────

function GroupCard({ group, onAutoFixed }: { group: WizardGroup; onAutoFixed: () => void }) {
  const failed = group.items.filter(i => i.status === 'fail').length;
  const warned = group.items.filter(i => i.status === 'warn').length;
  const passed = group.items.filter(i => i.status === 'pass').length;
  // Auto-collapse green groups so failures get the user's attention first.
  const [collapsed, setCollapsed] = useState(failed === 0 && warned === 0);

  return (
    <div className="glass-card p-0 overflow-hidden">
      <button
        onClick={() => setCollapsed(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-left"
      >
        <GroupIcon id={group.id} />
        <span className="flex-1 text-sm font-medium text-white/90">{group.label}</span>
        <div className="flex items-center gap-2 text-xs">
          {failed > 0 && <span className="text-red-400">{failed} failed</span>}
          {warned > 0 && <span className="text-yellow-400">{warned} warning{warned !== 1 ? 's' : ''}</span>}
          {failed === 0 && warned === 0 && <span className="text-green-400">{passed} passed</span>}
        </div>
        {collapsed
          ? <ChevronRight className="w-4 h-4 text-white/40 flex-shrink-0" />
          : <ChevronDown className="w-4 h-4 text-white/40 flex-shrink-0" />
        }
      </button>
      {!collapsed && (
        <div className="px-2 pb-2 space-y-0.5">
          {group.items.map(item => (
            <CheckRow key={item.id} item={item} onAutoFixed={onAutoFixed} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main modal ────────────────────────────────────────────────────────────────

export function SetupWizardModal({ initialBackend, onClose }: SetupWizardModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WizardResponse | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const runChecks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/computer-use/wizard');
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json() as WizardResponse;
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    runChecks();
  }, [runChecks]);

  // Esc closes the modal — backdrop click already does, but keyboard users get stuck without this.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Move focus into the modal when it opens so Tab cycles inside.
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  const summary = result?.summary;
  const allPassed = result?.allPassed ?? false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative glass-card w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06] flex-shrink-0">
          <div className="p-1.5 rounded-lg bg-blue-500/15 border border-blue-500/20">
            <Monitor className="w-4 h-4 text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-white">Computer Use Setup Wizard</h2>
            <p className="text-xs text-white/40 mt-0.5">
              Backend: <span className={initialBackend === 'max' ? 'text-purple-400' : 'text-blue-400'}>
                {initialBackend === 'max' ? 'MAX (Claude CLI)' : 'API Key'}
              </span>
            </p>
          </div>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            aria-label="Close setup wizard"
            className="p-1.5 rounded-lg hover:bg-white/10 text-white/50 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Intro — orients first-run users on what this wizard does. */}
        <div className="px-5 py-3 border-b border-white/[0.06] flex-shrink-0">
          <p className="text-xs text-white/60 leading-relaxed">
            This wizard checks whether this computer can provide desktop control and which parts it needs.
          </p>
        </div>

        {/* Summary bar */}
        {summary && !loading && result?.supported !== false && (
          <div className="flex items-center gap-4 px-5 py-3 border-b border-white/[0.06] bg-black/20 flex-shrink-0">
            {allPassed ? (
              <div className="flex items-center gap-2 text-green-400">
                <Check className="w-4 h-4" />
                <span className="text-sm font-medium">All checks passed — ready to use</span>
              </div>
            ) : (
              <>
                <span className="text-xs text-white/50">{summary.total} check{summary.total !== 1 ? 's' : ''}</span>
                {summary.passed > 0 && (
                  <span className="flex items-center gap-1 text-xs text-green-400">
                    <Check className="w-3 h-3" /> {summary.passed} passed
                  </span>
                )}
                {summary.failed > 0 && (
                  <span className="flex items-center gap-1 text-xs text-red-400">
                    <XCircle className="w-3 h-3" /> {summary.failed} failed
                  </span>
                )}
                {summary.warnings > 0 && (
                  <span className="flex items-center gap-1 text-xs text-yellow-400">
                    <AlertTriangle className="w-3 h-3" /> {summary.warnings} warning{summary.warnings !== 1 ? 's' : ''}
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
              <p className="text-sm text-white/60">Checking this computer…</p>
              <p className="text-xs text-white/40">Up to 30 seconds. Each check times out individually.</p>
            </div>
          )}

          {error && !loading && (
            <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20">
              <XCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-red-400 font-medium">Could not run checks</p>
                <p className="text-xs text-white/60 mt-1 break-words">{error}</p>
                <button
                  onClick={runChecks}
                  className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/25 transition-colors"
                >
                  <RefreshCw className="w-3 h-3" /> Try again
                </button>
              </div>
            </div>
          )}

          {result?.supported === false && !loading && <div role="status" className="p-4 rounded-xl border border-white/10"><h3 className="text-sm font-medium text-white mb-2">Desktop setup is not available on this server</h3><p className="text-sm text-white/70">{result.unsupportedReason}</p></div>}
          {result && !loading && result.groups.map(group => (
            <GroupCard key={group.id} group={group} onAutoFixed={runChecks} />
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-white/[0.06] flex-shrink-0 bg-black/20">
          <button
            onClick={runChecks}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-white/5 hover:bg-white/10 text-white/70 hover:text-white border border-white/10 transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Re-run checks
          </button>
          {allPassed ? (
            <button
              onClick={onClose}
              className="flex items-center gap-2 px-4 py-1.5 text-sm font-semibold rounded-lg bg-green-500/90 hover:bg-green-500 text-white border border-green-400/30 transition-all shadow-[0_0_18px_rgba(34,197,94,0.35)] hover:shadow-[0_0_24px_rgba(34,197,94,0.5)]"
            >
              Done
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm rounded-lg bg-white/10 hover:bg-white/15 text-white/80 hover:text-white border border-white/10 transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
