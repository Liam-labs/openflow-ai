'use client';

/**
 * ChannelDeleteDialog — confirm archiving or permanently deleting a channel, and choose what happens to
 * its project folder (working directory): keep it, or delete it. Delete is offered only when the server
 * says the folder belongs to this channel alone; otherwise the reason it is kept is shown. A folder with unsaved
 * git work can be deleted too (owner, 18 Oct 2026), but only after he is shown what would be lost and ticks the box.
 */

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, Loader2 } from 'lucide-react';

interface WorkspaceStatus {
  path?: string;
  eligible: boolean;
  reason?: string;
  exists?: boolean;
  bytes?: number;
  files?: number;
  gitIssues?: string[];
}

interface ChannelDeleteDialogProps {
  channelId: string;
  channelName: string;
  mode: 'archive' | 'permanent';
  busy: boolean;
  error?: string;
  onCancel: () => void;
  /** `discardUnsavedGit` is true only when the folder is being deleted and its unsaved git work was acknowledged. */
  onConfirm: (deleteFolder: boolean, discardUnsavedGit: boolean) => void;
}

function formatSize(bytes?: number): string {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function ChannelDeleteDialog({ channelId, channelName, mode, busy, error, onCancel, onConfirm }: ChannelDeleteDialogProps) {
  const [workspace, setWorkspace] = useState<WorkspaceStatus | null>(null);
  const [deleteFolder, setDeleteFolder] = useState(false);
  const [discardAck, setDiscardAck] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/collab/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', channelId }),
    })
      .then((response) => response.json())
      .then((data) => { if (!cancelled) setWorkspace(data?.workspace ?? { eligible: false, reason: data?.error || 'Folder status unavailable.' }); })
      .catch(() => { if (!cancelled) setWorkspace({ eligible: false, reason: 'Folder status unavailable.' }); });
    return () => { cancelled = true; };
  }, [channelId]);

  if (typeof document === 'undefined') return null;
  const canDelete = !!workspace?.eligible && workspace.exists !== false;
  const hasUnsavedGit = !!workspace?.gitIssues?.length;
  const mustAcknowledge = deleteFolder && hasUnsavedGit;
  const title = mode === 'archive' ? `Archive “${channelName}”?` : `Permanently delete “${channelName}”?`;
  const lead = mode === 'archive'
    ? 'The channel moves to Archived and can be restored later.'
    : 'The channel and its messages are removed for good.';

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[#030812]/88 p-3 sm:p-6"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-delete-title"
        className="w-full max-w-[480px] overflow-hidden rounded-[14px] border border-[#27466f]/55 bg-[#081321] shadow-[0_36px_120px_rgba(0,0,0,0.72)]"
      >
        <div className="px-5 pb-4 pt-5">
          <h2 id="channel-delete-title" className="text-base font-semibold text-white/90">{title}</h2>
          <p className="mt-1 text-sm text-white/55">{lead}</p>
        </div>

        <div className="mx-5 rounded-lg border border-[#21364f] bg-[#0d1a2b] p-3">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-white/45">
            <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" /> Project folder
          </div>
          {!workspace ? (
            <div className="mt-2 flex items-center gap-2 text-sm text-white/50">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Checking the folder…
            </div>
          ) : (
            <>
              {workspace.path && <div className="mt-1.5 break-all font-mono text-[12px] text-white/75">{workspace.path}</div>}
              {workspace.exists && (
                <div className="mt-1 text-xs text-white/45">{formatSize(workspace.bytes)} · {workspace.files ?? 0} files</div>
              )}
              {canDelete ? (
                <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Project folder">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!deleteFolder}
                    onClick={() => { setDeleteFolder(false); setDiscardAck(false); }}
                    className={`rounded-md border px-3 py-2 text-left text-sm ${!deleteFolder ? 'border-emerald-400/55 bg-emerald-500/[0.08] text-white/85' : 'border-[#21364f] text-white/60 hover:border-[#3c608b]'}`}
                  >
                    Keep folder
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={deleteFolder}
                    onClick={() => setDeleteFolder(true)}
                    className={`rounded-md border px-3 py-2 text-left text-sm ${deleteFolder ? 'border-red-400/60 bg-red-500/[0.09] text-white/85' : 'border-[#21364f] text-white/60 hover:border-[#3c608b]'}`}
                  >
                    Delete folder
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-white/50">
                  {workspace.exists === false ? 'The folder no longer exists.' : `Kept: ${workspace.reason || 'it cannot be deleted from here.'}`}
                </p>
              )}
              {hasUnsavedGit && !deleteFolder && (
                <p className="mt-2 text-xs text-amber-300/85">
                  Has unsaved git work: {workspace.gitIssues!.join('; ')}. Keeping the folder is the safe choice; you can still delete it, but that work is lost for good.
                </p>
              )}
              {deleteFolder && (
                <p className="mt-2 text-xs text-red-300/85">The folder and everything in it is deleted from the PC. The channel&apos;s agents are stopped first. This cannot be undone.</p>
              )}
              {mustAcknowledge && (
                <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-red-400/40 bg-red-500/[0.07] p-2 text-xs text-red-200/90">
                  <input
                    type="checkbox"
                    checked={discardAck}
                    onChange={(event) => setDiscardAck(event.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 accent-red-500"
                  />
                  <span>This folder has unsaved git work ({workspace.gitIssues!.join('; ')}). I understand that work is lost for good.</span>
                </label>
              )}
            </>
          )}
        </div>

        {error && <p className="mx-5 mt-3 text-sm text-red-300">{error}</p>}

        <div className="flex justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md px-3 py-2 text-sm text-white/60 hover:bg-white/5 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(deleteFolder, mustAcknowledge && discardAck)}
            disabled={busy || !workspace || (mustAcknowledge && !discardAck)}
            title={mustAcknowledge && !discardAck ? 'Tick the box to confirm the unsaved git work is lost' : undefined}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-50 ${mode === 'archive' && !deleteFolder ? 'bg-cyan-600/85 hover:bg-cyan-600' : 'bg-red-500/85 hover:bg-red-500'}`}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {mode === 'archive' ? 'Archive channel' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
