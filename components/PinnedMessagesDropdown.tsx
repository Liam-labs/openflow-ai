'use client';

import React from 'react';
import { Pin, X } from 'lucide-react';
import type { CollabMessage } from '@/lib/types';

export interface PinnedMessagesDropdownProps {
  pinnedMessages: CollabMessage[];
  onClose: () => void;
  getRelativeTime: (timestamp: string) => string;
  togglePin: (messageId: string) => void;
}

export function PinnedMessagesDropdown({
  pinnedMessages,
  onClose,
  getRelativeTime,
  togglePin,
}: PinnedMessagesDropdownProps) {
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="fixed right-4 top-[60px] z-20 w-80 bg-[#0a1628]/97 backdrop-blur-xl border border-white/[0.08] rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.5)] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.06] bg-gradient-to-r from-amber-500/[0.06] to-transparent flex items-center justify-between">
          <span className="text-sm font-semibold flex items-center gap-2 text-white/90">
            <Pin className="w-4 h-4 text-amber-400" />
            Pinned Messages
            <span className="text-xs text-amber-400/70 font-normal">{pinnedMessages.length}</span>
          </span>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-muted" aria-label="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto divide-y divide-white/[0.04]">
          {pinnedMessages.map(msg => (
            <div
              key={`pinned-panel-${msg.id}`}
              className="flex items-start gap-3 px-4 py-3 hover:bg-white/[0.03] cursor-pointer transition-colors group"
              onClick={() => {
                onClose();
                setTimeout(() => {
                  const el = document.getElementById(`msg-${msg.id}`);
                  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 50);
              }}
            >
              <div className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold mt-0.5"
                style={{ backgroundColor: msg.from.color || '#8B5CF6' }}>
                {msg.from.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-semibold truncate" style={{ color: msg.from.color }}>
                    {msg.from.name}
                  </span>
                  <span className="text-[10px] text-white/25 flex-shrink-0">{getRelativeTime(msg.timestamp)}</span>
                </div>
                <p className="text-xs text-white/60 truncate leading-relaxed">{msg.content}</p>
              </div>
              <button
                onClick={e => { e.stopPropagation(); togglePin(msg.id); }}
                className="flex-shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 text-white/40 hover:text-white/80 transition-all"
                title="Unpin"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
