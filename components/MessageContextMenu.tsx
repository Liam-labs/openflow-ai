'use client';

import React, { useEffect, useState } from 'react';
import { ClipboardCopy, Check } from 'lucide-react';
import type { CollabMessage, CollabParticipant } from '@/lib/types';
import { buildMessageDetailsText } from '@/lib/message-details-copy';

interface MessageContextMenuProps {
  x: number;
  y: number;
  msg: CollabMessage;
  channelName: string;
  channelId: string;
  participants: CollabParticipant[];
  onClose: () => void;
}

export function MessageContextMenu({ x, y, msg, channelName, channelId, participants, onClose }: MessageContextMenuProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopy = async () => {
    const text = buildMessageDetailsText({ msg, channelName, channelId, participants });
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      setTimeout(onClose, 1200);
    } catch {
      setCopyState('failed');
      setTimeout(() => setCopyState('idle'), 1600);
    }
  };

  /* Clamp menu position to viewport */
  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 1920) - 200);
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 1080) - 80);

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        className="fixed z-40 bg-[#0f1d32] border border-white/10 rounded-xl shadow-2xl py-1 min-w-[180px]"
        style={{ left, top }}
      >
        <button
          onClick={handleCopy}
          aria-live="polite"
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5 hover:text-white transition-colors"
        >
          {copyState === 'copied' ? (
            <>
              <Check className="w-3.5 h-3.5 text-green-400" />
              <span className="text-green-400">Copied!</span>
            </>
          ) : copyState === 'failed' ? (
            <>
              <ClipboardCopy className="w-3.5 h-3.5 text-red-400" />
              <span className="text-red-400">Copy failed</span>
            </>
          ) : (
            <>
              <ClipboardCopy className="w-3.5 h-3.5" />
              Copy Message Details
            </>
          )}
        </button>
      </div>
    </>
  );
}
