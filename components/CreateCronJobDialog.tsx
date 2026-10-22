'use client';

import { useState } from 'react';
import {
  X,
  Plus,
  Terminal,
  Globe,
  Send,
  Clock,
  ChevronDown,
  Loader2,
} from 'lucide-react';

interface CreateCronJobDialogProps {
  onClose: () => void;
  onCreated: () => void;
}

type JobType = 'shell' | 'tmux-send' | 'api-call';
type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

const JOB_TYPES: { value: JobType; label: string; icon: typeof Terminal; description: string }[] = [
  { value: 'shell', label: 'Shell', icon: Terminal, description: 'Run a shell command' },
  { value: 'tmux-send', label: 'Tmux', icon: Send, description: 'Send text to a tmux session' },
  { value: 'api-call', label: 'API Call', icon: Globe, description: 'Call an HTTP endpoint' },
];

const SCHEDULE_PRESETS = [
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Every day at midnight', value: '0 0 * * *' },
  { label: 'Every day at noon', value: '0 12 * * *' },
  { label: 'Every Monday at 9am', value: '0 9 * * 1' },
  { label: 'Custom', value: '' },
];

const API_METHODS: ApiMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

export function CreateCronJobDialog({ onClose, onCreated }: CreateCronJobDialogProps) {
  const [name, setName] = useState('');
  const [schedulePreset, setSchedulePreset] = useState('*/15 * * * *');
  const [customSchedule, setCustomSchedule] = useState('');
  const [jobType, setJobType] = useState<JobType>('shell');
  const [command, setCommand] = useState('');
  const [tmuxTarget, setTmuxTarget] = useState('');
  const [tmuxText, setTmuxText] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [apiMethod, setApiMethod] = useState<ApiMethod>('GET');
  const [apiHeaders, setApiHeaders] = useState('');
  const [apiBody, setApiBody] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const schedule = schedulePreset === '' ? customSchedule : schedulePreset;

  const validate = () => {
    if (!name.trim()) return 'Job name is required.';
    if (!schedule.trim()) return 'Schedule is required.';
    if (jobType === 'shell' && !command.trim()) return 'Command is required for shell jobs.';
    if (jobType === 'tmux-send') {
      if (!tmuxTarget.trim()) return 'Tmux target is required (e.g. session:window.pane).';
      if (!tmuxText.trim()) return 'Text to send is required.';
    }
    if (jobType === 'api-call' && !apiUrl.trim()) return 'API URL is required.';
    return '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setSubmitting(true);

    const payload: Record<string, unknown> = {
      action: 'create',
      name: name.trim(),
      schedule: schedule.trim(),
      jobType,
    };

    if (jobType === 'shell') {
      payload.command = command.trim();
    } else if (jobType === 'tmux-send') {
      payload.tmuxTarget = tmuxTarget.trim();
      payload.tmuxText = tmuxText.trim();
    } else if (jobType === 'api-call') {
      payload.apiUrl = apiUrl.trim();
      payload.apiMethod = apiMethod;
      if (apiHeaders.trim()) payload.apiHeaders = apiHeaders.trim();
      if (apiBody.trim()) payload.apiBody = apiBody.trim();
    }

    try {
      const res = await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || 'Failed to create job.');
      } else {
        onCreated();
        onClose();
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative w-full max-w-md glass-card border border-white/10 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-indigo-400" />
            <h2 className="text-sm font-semibold text-white/90">New Cron Job</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-white/60 mb-1">
              Job Name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Daily cleanup"
              className="w-full px-3 py-1.5 text-sm bg-black/30 border border-white/10 rounded-lg text-white/90 placeholder-white/25 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
            />
          </div>

          {/* Schedule */}
          <div>
            <label className="block text-xs font-medium text-white/60 mb-1">
              Schedule
            </label>
            <div className="relative">
              <select
                value={schedulePreset}
                onChange={e => setSchedulePreset(e.target.value)}
                className="w-full px-3 py-1.5 text-sm bg-black/30 border border-white/10 rounded-lg text-white/80 appearance-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors pr-8"
              >
                {SCHEDULE_PRESETS.map(p => (
                  <option key={p.value || 'custom'} value={p.value}>{p.label}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30 pointer-events-none" />
            </div>
            {schedulePreset === '' ? (
              <input
                type="text"
                value={customSchedule}
                onChange={e => setCustomSchedule(e.target.value)}
                placeholder="e.g. 0 9 * * 1-5"
                className="mt-2 w-full px-3 py-1.5 text-sm bg-black/30 border border-white/10 rounded-lg text-white/90 placeholder-white/25 font-mono focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
              />
            ) : (
              <p className="mt-1 text-[10px] text-white/30 font-mono">{schedulePreset}</p>
            )}
          </div>

          {/* Job Type */}
          <div>
            <label className="block text-xs font-medium text-white/60 mb-1.5">
              Job Type
            </label>
            <div className="grid grid-cols-3 gap-2">
              {JOB_TYPES.map(type => {
                const Icon = type.icon;
                const isSelected = jobType === type.value;
                return (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => setJobType(type.value)}
                    className={`flex flex-col items-center gap-1 py-2 px-1 rounded-lg border text-center transition-colors ${
                      isSelected
                        ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-300'
                        : 'border-white/8 bg-white/[0.03] text-white/40 hover:border-white/15 hover:text-white/60'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="text-[11px] font-medium">{type.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Type-specific fields */}
          {jobType === 'shell' && (
            <div>
              <label className="block text-xs font-medium text-white/60 mb-1">
                Command
              </label>
              <textarea
                value={command}
                onChange={e => setCommand(e.target.value)}
                placeholder="e.g. /home/user/scripts/cleanup.sh"
                rows={2}
                className="w-full px-3 py-1.5 text-sm bg-black/30 border border-white/10 rounded-lg text-white/90 placeholder-white/25 font-mono resize-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
              />
            </div>
          )}

          {jobType === 'tmux-send' && (
            <>
              <div>
                <label className="block text-xs font-medium text-white/60 mb-1">
                  Tmux Target
                </label>
                <input
                  type="text"
                  value={tmuxTarget}
                  onChange={e => setTmuxTarget(e.target.value)}
                  placeholder="e.g. main:0.0"
                  className="w-full px-3 py-1.5 text-sm bg-black/30 border border-white/10 rounded-lg text-white/90 placeholder-white/25 font-mono focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                />
                <p className="mt-0.5 text-[10px] text-white/30">session:window.pane format</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-white/60 mb-1">
                  Text to Send
                </label>
                <textarea
                  value={tmuxText}
                  onChange={e => setTmuxText(e.target.value)}
                  placeholder="e.g. npm run check"
                  rows={2}
                  className="w-full px-3 py-1.5 text-sm bg-black/30 border border-white/10 rounded-lg text-white/90 placeholder-white/25 font-mono resize-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                />
              </div>
            </>
          )}

          {jobType === 'api-call' && (
            <>
              <div className="flex gap-2">
                <div className="w-28 flex-shrink-0">
                  <label className="block text-xs font-medium text-white/60 mb-1">
                    Method
                  </label>
                  <div className="relative">
                    <select
                      value={apiMethod}
                      onChange={e => setApiMethod(e.target.value as ApiMethod)}
                      className="w-full px-2 py-1.5 text-sm bg-black/30 border border-white/10 rounded-lg text-white/80 appearance-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors pr-6"
                    >
                      {API_METHODS.map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-white/30 pointer-events-none" />
                  </div>
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-white/60 mb-1">
                    URL
                  </label>
                  <input
                    type="text"
                    value={apiUrl}
                    onChange={e => setApiUrl(e.target.value)}
                    placeholder="http://localhost:3000/api/health"
                    className="w-full px-3 py-1.5 text-sm bg-black/30 border border-white/10 rounded-lg text-white/90 placeholder-white/25 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-white/60 mb-1">
                  Headers <span className="text-white/30 font-normal">(optional, JSON)</span>
                </label>
                <textarea
                  value={apiHeaders}
                  onChange={e => setApiHeaders(e.target.value)}
                  placeholder={'{"Authorization": "Bearer token"}'}
                  rows={2}
                  className="w-full px-3 py-1.5 text-sm bg-black/30 border border-white/10 rounded-lg text-white/90 placeholder-white/25 font-mono resize-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                />
              </div>
              {(apiMethod === 'POST' || apiMethod === 'PUT' || apiMethod === 'PATCH') && (
                <div>
                  <label className="block text-xs font-medium text-white/60 mb-1">
                    Body <span className="text-white/30 font-normal">(optional, JSON)</span>
                  </label>
                  <textarea
                    value={apiBody}
                    onChange={e => setApiBody(e.target.value)}
                    placeholder='{"key": "value"}'
                    rows={2}
                    className="w-full px-3 py-1.5 text-sm bg-black/30 border border-white/10 rounded-lg text-white/90 placeholder-white/25 font-mono resize-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                  />
                </div>
              )}
            </>
          )}

          {/* Error */}
          {error && (
            <p className="text-xs text-red-400 bg-red-400/5 border border-red-400/15 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-white/50 hover:text-white/80 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-indigo-500/80 hover:bg-indigo-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Plus className="w-3.5 h-3.5" />
              }
              {submitting ? 'Creating...' : 'Create Job'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
