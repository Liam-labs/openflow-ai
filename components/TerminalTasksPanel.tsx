'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { TerminalTask, TerminalTaskModel, TerminalTaskEngine, TerminalTaskStatus, TerminalModelInfo } from '@/lib/types';
import { useEventStreamContext } from '@/lib/contexts/EventStreamContext';
import {
  Loader2,
  RefreshCw,
  Terminal,
  Play,
  Square,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Zap,
  Sparkles,
  Brain,
  Settings2,
  Copy,
  Check,
  X,
} from 'lucide-react';

interface TerminalTasksPanelProps {
  onTaskCountChange?: (count: number) => void;
  onRunningCountChange?: (count: number) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<TerminalTaskStatus, { label: string; color: string; bg: string; border: string; dot: string }> = {
  pending:   { label: 'Pending',   color: 'text-yellow-400', bg: 'bg-yellow-400/10', border: 'border-yellow-400/25', dot: 'bg-yellow-400' },
  running:   { label: 'Running',   color: 'text-blue-400',   bg: 'bg-blue-400/10',   border: 'border-blue-400/25',   dot: 'bg-blue-400' },
  completed: { label: 'Completed', color: 'text-green-400',  bg: 'bg-green-400/10',  border: 'border-green-400/25',  dot: 'bg-green-400' },
  failed:    { label: 'Failed',    color: 'text-red-400',    bg: 'bg-red-400/10',    border: 'border-red-400/25',    dot: 'bg-red-400' },
  timeout:   { label: 'Timeout',   color: 'text-amber-400',  bg: 'bg-amber-400/10',  border: 'border-amber-400/25',  dot: 'bg-amber-400' },
  cancelled: { label: 'Cancelled', color: 'text-gray-400',   bg: 'bg-gray-400/10',   border: 'border-gray-400/25',   dot: 'bg-gray-400' },
};

const MODEL_CONFIG: Record<TerminalTaskModel, { label: string; sublabel: string; icon: React.ReactNode; color: string; bg: string; border: string; ring: string }> = {
  haiku:  { label: 'Haiku',  sublabel: 'Fast & cheap',    icon: <Zap className="w-3.5 h-3.5" />,      color: 'text-sky-400',    bg: 'bg-sky-400/10',    border: 'border-sky-400/30',    ring: 'ring-sky-400/20' },
  sonnet: { label: 'Sonnet', sublabel: 'Balanced',        icon: <Sparkles className="w-3.5 h-3.5" />,  color: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30', ring: 'ring-emerald-400/20' },
  opus:   { label: 'Opus',   sublabel: 'Most capable',    icon: <Brain className="w-3.5 h-3.5" />,     color: 'text-purple-400', bg: 'bg-purple-400/10', border: 'border-purple-400/30', ring: 'ring-purple-400/20' },
};

const ENGINE_CONFIG: Record<TerminalTaskEngine, { label: string; color: string; bg: string; border: string }> = {
  claude: { label: 'Claude', color: 'text-orange-400', bg: 'bg-orange-400/10', border: 'border-orange-400/30' },
  gemini: { label: 'Gemini', color: 'text-blue-400',   bg: 'bg-blue-400/10',   border: 'border-blue-400/30' },
  ollama: { label: 'Ollama', color: 'text-teal-400',   bg: 'bg-teal-400/10',   border: 'border-teal-400/30' },
  grok:   { label: 'Grok',   color: 'text-rose-400',   bg: 'bg-rose-400/10',   border: 'border-rose-400/30' },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: TerminalTaskStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${cfg.color} ${cfg.bg} border ${cfg.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${status === 'running' ? 'animate-pulse' : ''}`} />
      {cfg.label}
    </span>
  );
}

function ModelBadge({ model }: { model: TerminalTaskModel }) {
  const cfg = MODEL_CONFIG[model];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cfg.color} ${cfg.bg} border ${cfg.border}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function EngineBadge({ engine, ollamaModel }: { engine: TerminalTaskEngine; ollamaModel?: string }) {
  const cfg = ENGINE_CONFIG[engine] || ENGINE_CONFIG.claude;
  const label = engine === 'ollama' && ollamaModel ? ollamaModel : cfg.label;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cfg.color} ${cfg.bg} border ${cfg.border}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Task Card
// ---------------------------------------------------------------------------

function TaskCard({ task, onCancel }: { task: TerminalTask; onCancel: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  const canCancel = task.status === 'pending' || task.status === 'running';
  const isTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'timeout' || task.status === 'cancelled';
  const hasOutput = task.output && task.output.length > 0;
  const hasError = task.error && task.error.length > 0;

  // Auto-expand running tasks
  useEffect(() => {
    if (task.status === 'running' && hasOutput) {
      setExpanded(true);
    }
  }, [task.status, hasOutput]);

  // Auto-scroll output while running
  useEffect(() => {
    if (task.status === 'running' && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [task.output, task.status]);

  const handleCopyOutput = async () => {
    const text = task.output || task.error || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  };

  // Timing display
  let timingText = '';
  if (task.status === 'running' && task.startedAt) {
    timingText = `started ${timeAgo(task.startedAt)}`;
  } else if (isTerminal && task.durationMs != null) {
    timingText = `completed in ${formatDuration(task.durationMs)}`;
  } else if (task.status === 'pending') {
    timingText = `queued ${timeAgo(task.createdAt)}`;
  }

  // Prompt needs truncation?
  const promptTruncated = task.prompt.length > 180;
  const displayPrompt = promptExpanded ? task.prompt : task.prompt.slice(0, 180);

  return (
    <div
      className={`rounded-lg border transition-all duration-200 ${
        task.status === 'running'
          ? 'bg-blue-400/5 border-blue-400/20 shadow-[0_0_15px_rgba(59,130,246,0.08)]'
          : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.05]'
      }`}
    >
      {/* Card header */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            {/* Status + model badges */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <StatusBadge status={task.status} />
              <EngineBadge engine={task.engine || 'claude'} ollamaModel={task.ollamaModel} />
              {task.engine === 'claude' || !task.engine ? <ModelBadge model={task.model} /> : null}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Timing */}
            {timingText && (
              <span className="text-xs text-white/40 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {timingText}
              </span>
            )}
            {/* Cancel button */}
            {canCancel && (
              <button
                onClick={(e) => { e.stopPropagation(); onCancel(task.id); }}
                className="p-1.5 rounded-md text-red-400/70 hover:text-red-400 hover:bg-red-400/10 border border-transparent hover:border-red-400/20 transition-all"
                title="Cancel task"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Prompt text */}
        <div className="mt-3">
          <p className={`text-sm text-white/80 leading-relaxed ${!promptExpanded ? 'line-clamp-2' : ''}`}>
            {displayPrompt}
            {promptTruncated && !promptExpanded && '...'}
          </p>
          {promptTruncated && (
            <button
              onClick={() => setPromptExpanded(!promptExpanded)}
              className="text-xs text-accent/70 hover:text-accent mt-1 transition-colors"
            >
              {promptExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>

        {/* Working directory */}
        {task.workingDirectory && (
          <div className="mt-2 text-xs text-white/30 font-mono truncate" title={task.workingDirectory}>
            {task.workingDirectory}
          </div>
        )}
      </div>

      {/* Output section */}
      {(hasOutput || hasError) && (
        <div className="border-t border-white/5">
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center justify-between px-4 py-2 text-xs text-white/40 hover:text-white/60 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Output
              {hasOutput && (
                <span className="text-white/20">
                  ({task.output.length > 1000
                    ? `${(task.output.length / 1024).toFixed(1)}KB`
                    : `${task.output.length} chars`
                  })
                </span>
              )}
            </span>
            {expanded && (
              <button
                onClick={(e) => { e.stopPropagation(); handleCopyOutput(); }}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-white/30 hover:text-white/60 hover:bg-white/5 transition-all"
                title="Copy output"
              >
                {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            )}
          </button>

          {expanded && (
            <div className="px-4 pb-4">
              {hasError && (
                <pre className="text-xs text-red-400/90 bg-red-400/5 border border-red-400/10 rounded-lg p-3 mb-2 overflow-x-auto max-h-40 font-mono whitespace-pre-wrap break-words">
                  {task.error}
                </pre>
              )}
              {hasOutput && (
                <pre
                  ref={outputRef}
                  className={`text-xs text-white/70 bg-black/40 border border-white/5 rounded-lg p-3 overflow-auto max-h-80 font-mono whitespace-pre-wrap break-words ${
                    task.status === 'running' ? 'scroll-smooth' : ''
                  }`}
                >
                  {task.output}
                  {task.status === 'running' && (
                    <span className="inline-block w-2 h-3.5 bg-blue-400/60 animate-pulse ml-0.5 rounded-sm align-text-bottom" />
                  )}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

export function TerminalTasksPanel({ onTaskCountChange, onRunningCountChange }: TerminalTasksPanelProps) {
  // -- Data state --
  const [tasks, setTasks] = useState<TerminalTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventStream = useEventStreamContext();

  // -- Form state --
  const [prompt, setPrompt] = useState('');
  const [engine, setEngine] = useState<TerminalTaskEngine>('claude');
  const [model, setModel] = useState<TerminalTaskModel>('sonnet');
  const [ollamaModel, setOllamaModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // -- Model registry --
  const [availableModels, setAvailableModels] = useState<TerminalModelInfo[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  const adjustTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => adjustTextarea(), [prompt, adjustTextarea]);

  // ------------------------------------------------------------------
  // Fetching
  // ------------------------------------------------------------------

  const hasRunningTasks = tasks.some(t => t.status === 'running' || t.status === 'pending');

  const fetchTasks = useCallback(async (showRefresh = false) => {
    if (showRefresh) setIsRefreshing(true);
    try {
      const res = await fetch('/api/terminal-tasks');
      const data = await res.json();
      if (data.success) {
        setTasks(data.tasks ?? []);
        setError(null);
      } else {
        setError(data.error ?? 'Failed to fetch tasks');
      }
    } catch (err) {
      setError('Failed to connect to task server');
      console.error('Terminal tasks fetch error:', err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // Report count to parent
  useEffect(() => {
    onTaskCountChange?.(tasks.length);
  }, [tasks.length, onTaskCountChange]);

  // Report running count to parent
  const runningTaskCount = tasks.filter(t => t.status === 'running' || t.status === 'pending').length;
  useEffect(() => {
    onRunningCountChange?.(runningTaskCount);
  }, [runningTaskCount, onRunningCountChange]);

  // Initial fetch
  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // Fetch available models
  useEffect(() => {
    fetch('/api/terminal-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'models' }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.success && data.models) {
          setAvailableModels(data.models);
          // Auto-select first Ollama model if available
          const firstOllama = data.models.find((m: TerminalModelInfo) => m.engine === 'ollama' && m.available);
          if (firstOllama) setOllamaModel(firstOllama.model);
        }
      })
      .catch(() => { /* ignore */ });
  }, []);

  // SSE: subscribe to terminal task status updates
  useEffect(() => {
    return eventStream.subscribe<{ tasks: TerminalTask[] }>('terminal:status', (data) => {
      if (data?.tasks) {
        setTasks(data.tasks);
        setError(null);
      }
    });
  }, [eventStream]);

  // Fallback polling: only when SSE is disconnected (30s)
  // When SSE is active, server pushes task updates via terminal:status events
  useEffect(() => {
    if (eventStream.isSSE) return;

    const interval = setInterval(
      () => fetchTasks(),
      hasRunningTasks ? 5000 : 30000,
    );
    return () => clearInterval(interval);
  }, [eventStream.isSSE, hasRunningTasks, fetchTasks]);

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  const handleSubmit = async () => {
    if (!prompt.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const body: Record<string, unknown> = {
        action: 'submit',
        prompt: prompt.trim(),
        engine,
        model,
      };
      if (engine === 'ollama' && ollamaModel) body.ollamaModel = ollamaModel;
      if (systemPrompt.trim()) body.systemPrompt = systemPrompt.trim();

      const res = await fetch('/api/terminal-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.success) {
        setPrompt('');
        setSystemPrompt('');
        setShowAdvanced(false);
        await fetchTasks();
      } else {
        setSubmitError(data.error ?? 'Failed to submit task');
      }
    } catch (err) {
      setSubmitError('Network error submitting task');
      console.error('Submit error:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = async (taskId: string) => {
    try {
      const res = await fetch('/api/terminal-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', taskId }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? 'Failed to cancel task');
      }
      await fetchTasks();
    } catch (err) {
      setError('Failed to cancel task');
      console.error('Cancel error:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
      </div>
    );
  }

  const runningCount = tasks.filter(t => t.status === 'running').length;
  const completedCount = tasks.filter(t => t.status === 'completed').length;
  const failedCount = tasks.filter(t => t.status === 'failed' || t.status === 'timeout').length;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Quick stats bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-xs">
          {runningCount > 0 && (
            <span className="text-blue-400 font-medium">{runningCount} running</span>
          )}
          <span className="text-green-400/70">{completedCount} completed</span>
          {failedCount > 0 && (
            <span className="text-red-400/70">{failedCount} failed</span>
          )}
          <span className="text-white/30">{tasks.length} total</span>
        </div>
        <button
          className="pm2-refresh-btn"
          onClick={() => fetchTasks(true)}
          disabled={isRefreshing}
          title="Refresh tasks"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Global error */}
      {error && (
        <div className="pm2-error">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
          <button onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Submit Form                                                      */}
      {/* ---------------------------------------------------------------- */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Cpu className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-semibold">New Task</h3>
        </div>

        {/* Engine selector */}
        <div className="flex items-center gap-1 mb-3 p-1 bg-black/20 rounded-lg border border-white/5">
          {(Object.keys(ENGINE_CONFIG) as TerminalTaskEngine[]).map((e) => {
            const cfg = ENGINE_CONFIG[e];
            const active = engine === e;
            const engineModels = availableModels.filter(m => m.engine === e);
            const isAvailable = engineModels.length === 0 || engineModels.some(m => m.available);
            return (
              <button
                key={e}
                onClick={() => setEngine(e)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150 ${
                  active
                    ? `${cfg.color} ${cfg.bg} border ${cfg.border}`
                    : 'text-white/40 hover:text-white/60 border border-transparent'
                } ${!isAvailable ? 'opacity-40' : ''}`}
                disabled={isSubmitting || !isAvailable}
                title={!isAvailable ? `${cfg.label} not available` : undefined}
              >
                {cfg.label}
                {!isAvailable && <span className="w-1.5 h-1.5 rounded-full bg-red-400/60" />}
              </button>
            );
          })}
        </div>

        {/* Prompt */}
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            engine === 'claude' ? 'Describe the task for Claude... (Ctrl+Enter to submit)' :
            engine === 'gemini' ? 'Describe the task for Gemini... (Ctrl+Enter to submit)' :
            'Describe the task for Ollama... (Ctrl+Enter to submit)'
          }
          className="glass-input resize-none min-h-[72px] max-h-[200px] leading-relaxed"
          rows={2}
          disabled={isSubmitting}
        />

        {/* Model selector - Claude only */}
        {engine === 'claude' && (
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {(Object.keys(MODEL_CONFIG) as TerminalTaskModel[]).map((m) => {
              const cfg = MODEL_CONFIG[m];
              const active = model === m;
              return (
                <button
                  key={m}
                  onClick={() => setModel(m)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all duration-150 ${
                    active
                      ? `${cfg.color} ${cfg.bg} ${cfg.border} shadow-sm ring-1 ${cfg.ring}`
                      : 'text-white/40 bg-white/[0.03] border-white/10 hover:text-white/60 hover:bg-white/[0.06] hover:border-white/15'
                  }`}
                  disabled={isSubmitting}
                >
                  {cfg.icon}
                  <span>{cfg.label}</span>
                  <span className={`${active ? 'opacity-60' : 'opacity-40'}`}>{cfg.sublabel}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Ollama model selector */}
        {engine === 'ollama' && (
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {availableModels
              .filter(m => m.engine === 'ollama' && m.available)
              .map((m) => {
                const active = ollamaModel === m.model;
                return (
                  <button
                    key={m.model}
                    onClick={() => setOllamaModel(m.model)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all duration-150 ${
                      active
                        ? 'text-teal-400 bg-teal-400/10 border-teal-400/30 shadow-sm ring-1 ring-teal-400/20'
                        : 'text-white/40 bg-white/[0.03] border-white/10 hover:text-white/60 hover:bg-white/[0.06] hover:border-white/15'
                    }`}
                    disabled={isSubmitting}
                  >
                    <span>{m.displayName}</span>
                    {m.size && <span className="opacity-50">{m.size}</span>}
                  </button>
                );
              })}
            {availableModels.filter(m => m.engine === 'ollama' && m.available).length === 0 && (
              <span className="text-xs text-white/30">No Ollama models installed</span>
            )}
          </div>
        )}

        {/* Advanced toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1.5 mt-3 text-xs text-white/30 hover:text-white/50 transition-colors"
        >
          <Settings2 className="w-3 h-3" />
          Advanced
          {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>

        {/* Advanced section */}
        {showAdvanced && (
          <div className="mt-3 p-3 bg-black/20 border border-white/5 rounded-lg">
            <label className="block text-xs text-white/40 mb-1.5">System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Optional system instructions..."
              className="glass-input resize-none text-sm min-h-[56px] max-h-[120px]"
              rows={2}
              disabled={isSubmitting}
            />
          </div>
        )}

        {/* Submit error */}
        {submitError && (
          <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg bg-red-400/10 border border-red-400/20 text-red-400 text-xs">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{submitError}</span>
            <button onClick={() => setSubmitError(null)} className="ml-auto hover:text-red-300" aria-label="Dismiss error">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Submit button */}
        <div className="flex justify-end mt-4">
          <button
            onClick={handleSubmit}
            disabled={!prompt.trim() || isSubmitting}
            className="glass-button primary flex items-center gap-2 px-5 py-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isSubmitting ? 'Submitting...' : 'Run Task'}
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Task List                                                        */}
      {/* ---------------------------------------------------------------- */}
      <div className="glass-card">
        <div className="pm2-section-header">
          <Terminal className="w-4 h-4 text-accent" />
          <h3 className="text-[0.9rem] font-semibold">Tasks</h3>
          <span className="text-muted text-sm">({tasks.length})</span>
        </div>

        {tasks.length === 0 ? (
          <div className="p-8 text-center text-muted">
            <Terminal className="w-8 h-8 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No tasks yet</p>
            <p className="text-xs mt-1.5 text-white/30">
              Write a prompt above to submit a task to Claude, Gemini, or Ollama
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} onCancel={handleCancel} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
