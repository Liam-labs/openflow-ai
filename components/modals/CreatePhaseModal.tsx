'use client';

/**
 * CreatePhaseModal - Modal for creating new phases within a sprint
 */

import React, { useState } from 'react';
import { X, Layers, Check } from 'lucide-react';

interface CreatePhaseModalProps {
  channelId: string;
  participantId: string;
  sprintId: string;
  onClose: () => void;
  onSuccess: () => void;
}

const PHASE_COLORS = [
  { name: 'Blue', value: '#3B82F6', label: 'Auth/Security' },
  { name: 'Green', value: '#10B981', label: 'Data/Backend' },
  { name: 'Amber', value: '#F59E0B', label: 'UI/Frontend' },
  { name: 'Purple', value: '#8B5CF6', label: 'Integration/API' },
  { name: 'Pink', value: '#EC4899', label: 'Testing/QA' },
  { name: 'Indigo', value: '#6366F1', label: 'Docs/DevOps' },
  { name: 'Cyan', value: '#06B6D4', label: 'Other' },
];

export function CreatePhaseModal({
  channelId,
  participantId,
  sprintId,
  onClose,
  onSuccess,
}: CreatePhaseModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(PHASE_COLORS[0].value);
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
          action: 'create-phase',
          channelId,
          participantId,
          sprintId,
          name: name.trim(),
          description: description.trim() || undefined,
          color,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          onSuccess();
        } else {
          setError(data.error || 'Failed to create phase');
        }
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create phase');
      }
    } catch (err) {
      console.error('Failed to create phase:', err);
      setError('Network error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[#0a1628] rounded-2xl border border-white/[0.08] shadow-[0_24px_80px_-20px_rgba(0,0,0,0.6)] w-full max-w-md"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-gradient-to-r from-purple-500/[0.06] to-transparent">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/15 rounded-xl">
              <Layers className="w-5 h-5 text-purple-400" />
            </div>
            <h2 className="text-lg font-semibold text-white/90">Create Phase</h2>
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

          {/* Phase Name */}
          <div>
            <label htmlFor="phase-name" className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">
              Phase Name <span className="text-red-400">*</span>
            </label>
            <input
              id="phase-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., Phase 1: Authentication"
              className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-purple-500/30 transition-colors"
              autoFocus
              required
            />
            <p className="text-[11px] text-muted mt-1.5">
              Tip: Use format &ldquo;Phase N: System/Feature&rdquo;
            </p>
          </div>

          {/* Description */}
          <div>
            <label htmlFor="phase-description" className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">
              Description
            </label>
            <textarea
              id="phase-description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What work is included in this phase?"
              className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-purple-500/30 transition-colors resize-none"
              rows={3}
            />
          </div>

          {/* Color Picker */}
          <div>
            <label className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">
              Color
            </label>
            <div className="bg-black/20 border border-white/[0.06] rounded-xl p-3">
              <div className="grid grid-cols-7 gap-2">
                {PHASE_COLORS.map(colorOption => (
                  <button
                    key={colorOption.value}
                    type="button"
                    onClick={() => setColor(colorOption.value)}
                    className={`relative w-8 h-8 rounded-lg cursor-pointer border-2 transition-all flex items-center justify-center ${
                      color === colorOption.value
                        ? 'border-white/50 scale-110'
                        : 'border-white/[0.06] hover:border-white/20'
                    }`}
                    style={{ backgroundColor: colorOption.value + '30' }}
                    title={`${colorOption.name} - ${colorOption.label}`}
                  >
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: colorOption.value }}
                    />
                    {color === colorOption.value && (
                      <div className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-white rounded-full flex items-center justify-center">
                        <Check className="w-2 h-2 text-[#0a1628]" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted mt-2.5">
                {PHASE_COLORS.find(c => c.value === color)?.name} - {PHASE_COLORS.find(c => c.value === color)?.label}
              </p>
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
              {creating ? 'Creating...' : 'Create Phase'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
