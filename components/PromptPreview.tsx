'use client';
import React, { useMemo } from 'react';
import { Eye, X } from 'lucide-react';
import { parsePrompt } from '@/lib/prompt-parser';
import { renderMessageContent } from '@/lib/message-renderer';
import type { CollabParticipant } from '@/lib/types';

interface PromptPreviewProps {
  rawInput: string;
  participants: CollabParticipant[];
  projectPath?: string;
  onClose: () => void;
}

/**
 * Live "what the agent will receive" pane (T2.3). Runs the SAME shared parser
 * (lib/prompt-parser) client-side as the dispatch path, then renders the
 * canonical text through the SAME chat renderer (lib/message-renderer) so the
 * preview is byte-faithful to the eventual message. Passthrough inputs render
 * verbatim — the parser returns the original untouched.
 */
export function PromptPreview({ rawInput, participants, projectPath, onClose }: PromptPreviewProps) {
  const { structured, wasStructured } = useMemo(() => parsePrompt(rawInput), [rawInput]);
  const hasInput = rawInput.trim().length > 0;

  return (
    <div className="collab-prompt-preview mb-2 rounded-lg border border-white/10 bg-black/30 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06] bg-white/[0.02]">
        <Eye className="w-3.5 h-3.5 text-blue-400/80 flex-shrink-0" />
        <span className="text-xs text-white/60">What the agent will receive</span>
        <span
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
            wasStructured
              ? 'bg-blue-500/15 text-blue-300 border border-blue-500/25'
              : 'bg-white/[0.06] text-white/40 border border-white/10'
          }`}
        >
          {wasStructured ? 'Structured' : 'Passthrough'}
        </span>
        <button
          onClick={onClose}
          className="ml-auto flex-shrink-0 p-1 rounded hover:bg-white/10 text-muted hover:text-white transition-colors"
          title="Hide preview"
          aria-label="Hide preview"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div
        className="px-3 py-2 max-h-48 overflow-y-auto text-sm whitespace-pre-wrap break-words text-white/90"
        style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
      >
        {hasInput ? (
          renderMessageContent(structured, participants, projectPath)
        ) : (
          <span className="text-white/30 italic">Nothing to preview yet — start typing.</span>
        )}
      </div>
    </div>
  );
}
