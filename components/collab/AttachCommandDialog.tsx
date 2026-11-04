'use client';

/**
 * Shown when "Open terminal" cannot open a window on this computer (a Mac, a Linux server, a container install).
 * It says so in plain words and gives the exact command to copy, in place of an error naming Windows Terminal.
 */
import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';

interface Props {
  message: string;
  command: string;
  onClose: () => void;
}

export function AttachCommandDialog({ message, command, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false); // the command stays on screen to select by hand
    }
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="Open this agent's terminal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-white/10 bg-neutral-900 p-4 text-sm text-neutral-100" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <p>{message}</p>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-white/10"><X className="w-4 h-4" aria-hidden="true" /></button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 rounded-md bg-black/40 px-2 py-1.5 text-xs break-all select-all">{command}</code>
          <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-md border border-white/20 px-2 py-1.5 text-xs hover:bg-white/10 min-h-8">
            {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="mt-2 text-xs text-neutral-400">Press Ctrl+B then D to leave the agent running when you are done.</p>
      </div>
    </div>
  );
}
