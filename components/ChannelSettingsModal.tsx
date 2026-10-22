'use client';

import React from 'react';
import { Settings, X } from 'lucide-react';
import type { CollabChannel } from '@/lib/types';
import { TeamsBridgePanel } from './TeamsBridgePanel';

export interface ChannelSettingsModalProps {
  activeChannel: CollabChannel;
  onClose: () => void;
  editChannelName: string;
  setEditChannelName: (v: string) => void;
  editChannelDescription: string;
  setEditChannelDescription: (v: string) => void;
  editChannelProjectPath: string;
  setEditChannelProjectPath: (v: string) => void;
  handleSaveChannelSettings: () => void;
  error?: string | null;
  saving?: boolean;
}

export function ChannelSettingsModal({
  activeChannel,
  onClose,
  editChannelName,
  setEditChannelName,
  editChannelDescription,
  setEditChannelDescription,
  editChannelProjectPath,
  setEditChannelProjectPath,
  handleSaveChannelSettings,
  error,
  saving = false,
}: ChannelSettingsModalProps) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-10"
        onClick={onClose}
      />
      {/* Settings dropdown */}
      <div className="absolute left-1/2 top-20 -translate-x-1/2 z-20 w-96 bg-[#0f1d32] border border-white/10 rounded-xl shadow-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-white/10 bg-blue-500/5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold flex items-center gap-2">
              <Settings className="w-4 h-4 text-blue-400" />
              Channel Settings
            </span>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-white/10 text-muted"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {/* Channel Name */}
          <div>
            <label className="block text-xs text-muted mb-1.5">Channel Name</label>
            <input
              type="text"
              value={editChannelName}
              onChange={(e) => setEditChannelName(e.target.value)}
              className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-sm text-white placeholder:text-muted focus:border-blue-500/50 focus:outline-none"
              placeholder="Enter channel name..."
            />
          </div>

          {/* Channel Description */}
          <div>
            <label className="block text-xs text-muted mb-1.5">Description (optional)</label>
            <textarea
              value={editChannelDescription}
              onChange={(e) => setEditChannelDescription(e.target.value)}
              className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-sm text-white placeholder:text-muted focus:border-blue-500/50 focus:outline-none resize-none"
              placeholder="What's this channel about?"
              rows={3}
            />
          </div>

          {/* Project Association */}
          <div>
            <label className="block text-xs text-muted mb-1.5">Associated Project</label>
            <input
              type="text"
              value={editChannelProjectPath}
              onChange={(e) => setEditChannelProjectPath(e.target.value)}
              placeholder="/home/you/my-project"
              className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-sm text-white font-mono placeholder:text-muted focus:border-blue-500/50 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="mt-1 text-[10px] text-white/30">Feature docs will auto-export to {editChannelProjectPath ? `${editChannelProjectPath}/docs/features/` : 'project/docs/features/'}</p>
          </div>

          {/* Teams Integration */}
          <TeamsBridgePanel
            channelId={activeChannel.id}
            channelName={activeChannel.name}
          />

          {error && (
            <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-sm text-muted hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveChannelSettings}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg text-sm bg-blue-500 hover:bg-blue-600 disabled:cursor-wait disabled:opacity-60 text-white transition-colors"
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
