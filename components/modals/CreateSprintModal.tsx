'use client';

/**
 * CreateSprintModal - Modal for creating new sprints
 */

import React, { useState } from 'react';
import { X, Calendar, Target } from 'lucide-react';

interface CreateSprintModalProps {
  channelId: string;
  participantId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function CreateSprintModal({ channelId, participantId, onClose, onSuccess }: CreateSprintModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setCreating(true);
    setError(null);

    try {
      const res = await fetch('/api/collab/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'create-sprint',
          channelId,
          participantId,
          name: name.trim(),
          description: description.trim() || undefined,
          startDate: startDate ? new Date(startDate).toISOString() : undefined,
          endDate: endDate ? new Date(endDate).toISOString() : undefined,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          onSuccess();
        } else {
          setError(data.error || 'Failed to create sprint');
        }
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create sprint');
      }
    } catch (err) {
      console.error('Failed to create sprint:', err);
      setError('Network error');
    } finally {
      setCreating(false);
    }
  };

  // Generate default dates (2 weeks from today)
  const getDefaultDates = () => {
    const today = new Date();
    const twoWeeksLater = new Date(today);
    twoWeeksLater.setDate(today.getDate() + 14);

    return {
      start: today.toISOString().split('T')[0],
      end: twoWeeksLater.toISOString().split('T')[0],
    };
  };

  const defaultDates = getDefaultDates();

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[#0a1628] rounded-2xl border border-white/[0.08] shadow-[0_24px_80px_-20px_rgba(0,0,0,0.6)] w-full max-w-md"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-gradient-to-r from-blue-500/[0.06] to-transparent">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/15 rounded-xl">
              <Target className="w-5 h-5 text-blue-400" />
            </div>
            <h2 className="text-lg font-semibold text-white/90">Create Sprint</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-4 h-4 text-muted" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/25 rounded-xl text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Sprint Name */}
          <div>
            <label htmlFor="sprint-name" className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">
              Sprint Name <span className="text-red-400">*</span>
            </label>
            <input
              id="sprint-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., Sprint 1: Core Features"
              className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-purple-500/30 transition-colors"
              autoFocus
              required
            />
            <p className="text-[11px] text-muted mt-1.5">
              Tip: Use format &ldquo;Sprint N: Brief Description&rdquo;
            </p>
          </div>

          {/* Description */}
          <div>
            <label htmlFor="sprint-description" className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">
              Description
            </label>
            <textarea
              id="sprint-description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What will be accomplished in this sprint?"
              className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-purple-500/30 transition-colors resize-none"
              rows={3}
            />
          </div>

          {/* Date Range */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="sprint-start-date" className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">
                Start Date
              </label>
              <input
                id="sprint-start-date"
                type="date"
                value={startDate || defaultDates.start}
                onChange={e => setStartDate(e.target.value)}
                className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/30 transition-colors"
              />
            </div>
            <div>
              <label htmlFor="sprint-end-date" className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">
                End Date
              </label>
              <input
                id="sprint-end-date"
                type="date"
                value={endDate || defaultDates.end}
                onChange={e => setEndDate(e.target.value)}
                className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/30 transition-colors"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-white/[0.04] hover:bg-white/[0.08] text-white/50 rounded-xl font-medium transition-colors text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || creating}
              className="px-4 py-2 bg-purple-500/15 hover:bg-purple-500/25 text-purple-400 border border-purple-500/20 rounded-xl font-medium transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 text-sm"
            >
              {creating ? 'Creating...' : 'Create Sprint'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
