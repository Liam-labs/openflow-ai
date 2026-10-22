'use client';

import React, { useState, useEffect } from 'react';
import { FileText, X, AlertTriangle, FolderOpen, Loader2, Check } from 'lucide-react';
import type { CollabChannel } from '@/lib/types';

interface DocPanelModalProps {
  show: boolean;
  activeChannel: CollabChannel;
  onClose: () => void;
  docPanelLoading: boolean;
  docPanelContent: string | null;
  docPanelProjectPath: string | null;
  docPanelExists: boolean;
  /** Why there is nothing to show, when it is not simply "no PROJECT.md" (the agent machine is off, its helper is out of date, ...). */
  docPanelNotice?: string | null;
  onSavePath: (input: string) => Promise<void>;
}

export function DocPanelModal({
  show,
  activeChannel,
  onClose,
  docPanelLoading,
  docPanelContent,
  docPanelProjectPath,
  docPanelExists,
  docPanelNotice,
  onSavePath,
}: DocPanelModalProps) {
  const [docPathInput, setDocPathInput] = useState(docPanelProjectPath ?? '');
  const [docPathSaving, setDocPathSaving] = useState(false);
  const [docPathError, setDocPathError] = useState('');

  // Sync input when the panel opens or projectPath changes
  useEffect(() => {
    if (show) {
      setDocPathInput(docPanelProjectPath ?? '');
      setDocPathError('');
    }
  }, [show, docPanelProjectPath]);

  if (!show) return null;

  const handleSaveDocPath = async () => {
    if (!docPathInput.trim()) return;
    setDocPathSaving(true);
    setDocPathError('');
    try {
      await onSavePath(docPathInput.trim());
    } catch {
      setDocPathError('Failed to save path');
    } finally {
      setDocPathSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute left-1/2 top-20 -translate-x-1/2 z-20 w-[640px] max-w-[95vw] bg-[#0f1d32] border border-white/10 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[75vh]">
        {/* Header */}
        <div className="px-4 py-3 border-b border-white/10 bg-blue-500/5 flex items-center justify-between flex-shrink-0">
          <span className="text-sm font-semibold flex items-center gap-2">
            <FileText className="w-4 h-4 text-blue-400" />
            Project Docs
            {docPanelProjectPath && (
              <span className="text-xs font-mono text-white/30 font-normal">
                {docPanelProjectPath.split('/').slice(-2).join('/')}/PROJECT.md
              </span>
            )}
          </span>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-muted" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-4">
          {docPanelLoading ? (
            <div className="flex items-center justify-center py-12 text-white/30">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading...
            </div>
          ) : docPanelExists && docPanelContent ? (
            <div className="text-sm space-y-1 leading-relaxed">
              {docPanelContent.split('\n').map((line, idx) => {
                if (line.startsWith('# ')) return <h1 key={idx} className="text-lg font-bold text-white mt-4 mb-2 pb-1 border-b border-white/10 first:mt-0">{line.slice(2)}</h1>;
                if (line.startsWith('## ')) return <h2 key={idx} className="text-base font-semibold text-white/90 mt-3 mb-1">{line.slice(3)}</h2>;
                if (line.startsWith('### ')) return <h3 key={idx} className="text-sm font-semibold text-white/80 mt-2 mb-0.5">{line.slice(4)}</h3>;
                if (line.startsWith('```')) return null;
                if (line.match(/^[-*] /)) return <li key={idx} className="text-white/65 ml-4 list-disc">{line.slice(2)}</li>;
                if (line.match(/^\d+\. /)) return <li key={idx} className="text-white/65 ml-4 list-decimal">{line.replace(/^\d+\. /, '')}</li>;
                if (line.match(/^-{3,}$/)) return <hr key={idx} className="border-white/10 my-2" />;
                if (line.trim() === '') return <div key={idx} className="h-1.5" />;
                if (line.startsWith('    ') || line.startsWith('\t')) return <code key={idx} className="block font-mono text-xs text-green-300/80 bg-black/20 px-2 py-0.5 rounded">{line.trimStart()}</code>;
                return <p key={idx} className="text-white/65">{line}</p>;
              })}
            </div>
          ) : (
            /* No working directory set, or PROJECT.md missing */
            <div className="space-y-4">
              {!docPanelProjectPath ? (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/15">
                  <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-amber-300/80">This channel has no working directory set. Set one below to view its PROJECT.md.</p>
                </div>
              ) : docPanelNotice ? (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/15">
                  <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-amber-300/80">{docPanelNotice}</p>
                </div>
              ) : (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                  <AlertTriangle className="w-4 h-4 text-white/30 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-white/50">No PROJECT.md found at <span className="font-mono text-white/70">{docPanelProjectPath}</span>. Update the path or add a PROJECT.md to that directory.</p>
                </div>
              )}
              <div className="space-y-2">
                <label className="text-xs text-white/40 uppercase tracking-wider">Working Directory</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={docPathInput}
                    onChange={e => setDocPathInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSaveDocPath()}
                    placeholder="/home/you/my-project"
                    className="flex-1 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-white placeholder-white/20 focus:outline-none focus:border-blue-500/40"
                  />
                  <button
                    onClick={handleSaveDocPath}
                    disabled={docPathSaving || !docPathInput.trim()}
                    className="px-4 py-2 rounded-lg text-sm bg-blue-500/20 text-blue-300 border border-blue-500/20 hover:bg-blue-500/30 transition-colors disabled:opacity-40 disabled:pointer-events-none flex items-center gap-1.5"
                  >
                    {docPathSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    {docPathSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
                {docPathError && <p className="text-xs text-red-400">{docPathError}</p>}
              </div>
            </div>
          )}
        </div>

        {/* Footer — path edit when doc is loaded */}
        {docPanelExists && docPanelProjectPath && (
          <div className="px-4 py-2.5 border-t border-white/[0.06] bg-white/[0.02] flex items-center gap-2 flex-shrink-0">
            <FolderOpen className="w-3.5 h-3.5 text-white/25 flex-shrink-0" />
            <input
              type="text"
              value={docPathInput}
              onChange={e => setDocPathInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSaveDocPath()}
              className="flex-1 bg-transparent text-xs font-mono text-white/30 focus:text-white/60 focus:outline-none placeholder-white/15"
              placeholder="Working directory path..."
            />
            {docPathInput !== docPanelProjectPath && (
              <button
                onClick={handleSaveDocPath}
                disabled={docPathSaving}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-40"
              >
                {docPathSaving ? 'Saving...' : 'Update'}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
