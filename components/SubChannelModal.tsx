'use client';

import React from 'react';
import { MessageSquarePlus, X, Circle } from 'lucide-react';
import type { CollabChannel } from '@/lib/types';

export interface SubChannelModalProps {
  showSubChannelModal: boolean;
  setShowSubChannelModal: (v: boolean) => void;
  subChannelParentId: string;
  setSubChannelParentId: (v: string | null) => void;
  channels: CollabChannel[];
  browserParticipantId: string;
  selectedSubChannelMembers: Set<string>;
  setSelectedSubChannelMembers: (updater: (prev: Set<string>) => Set<string>) => void;
  handleCreateSubChannel: () => void;
}

export function SubChannelModal({
  setShowSubChannelModal,
  subChannelParentId,
  setSubChannelParentId,
  channels,
  browserParticipantId,
  selectedSubChannelMembers,
  setSelectedSubChannelMembers,
  handleCreateSubChannel,
}: SubChannelModalProps) {
  const parentCh = channels.find(c => c.id === subChannelParentId);
  if (!parentCh) return null;
  const otherParticipants = parentCh.participants.filter(p => p.id !== browserParticipantId);

  const onClose = () => { setShowSubChannelModal(false); setSubChannelParentId(null); };

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute left-1/2 top-20 -translate-x-1/2 z-20 w-96 bg-[#0f1d32] border border-white/10 rounded-xl shadow-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-white/10 bg-blue-500/5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold flex items-center gap-2">
              <MessageSquarePlus className="w-4 h-4 text-blue-400" />
              Start Side Conversation
            </span>
            <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-muted" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-muted mt-1">in #{parentCh.name}</p>
        </div>

        <div className="p-4 space-y-3">
          <label className="block text-xs text-muted mb-1">Select participants</label>
          {otherParticipants.length === 0 ? (
            <p className="text-xs text-muted/60 py-2">No other members in this channel</p>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {otherParticipants.map((p) => (
                <label
                  key={p.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 cursor-pointer text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selectedSubChannelMembers.has(p.id)}
                    onChange={() => {
                      setSelectedSubChannelMembers(prev => {
                        const next = new Set(prev);
                        if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                        return next;
                      });
                    }}
                    className="rounded border-white/20 bg-black/30 text-blue-500 focus:ring-blue-500/30"
                  />
                  <Circle className="w-2 h-2 flex-shrink-0" style={{ color: p.color, fill: p.color }} />
                  <span className="truncate">{p.name}</span>
                  <span className="text-[10px] text-muted ml-auto">{p.type === 'user' ? 'User' : 'Agent'}</span>
                </label>
              ))}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-sm text-muted hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateSubChannel}
              disabled={selectedSubChannelMembers.size === 0}
              className="px-3 py-1.5 rounded-lg text-sm bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
