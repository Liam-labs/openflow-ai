'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import type { CollabChannel } from '../colab-types';
import type { ChannelGroup } from '@/lib/types';
import { getChannelGroupId } from '@/lib/collab-groups';

export interface JumpEntry { channel: CollabChannel; where: string; unread: number }

/** Every channel the sidebar can open, with where it lives, ranked for an empty query: unread first, then newest. */
export function buildJumpEntries(
  channels: CollabChannel[],
  groups: ChannelGroup[],
  unreadCounts: Record<string, number>,
  commanderId?: string,
): JumpEntry[] {
  const byId = new Map(channels.map(c => [c.id, c]));
  const stamp = (c: CollabChannel) => new Date(c.lastMessageAt || c.lastActivity || c.createdAt || 0).getTime() || 0;
  return channels
    .map(channel => {
      const parent = channel.parentChannelId ? byId.get(channel.parentChannelId) : undefined;
      let where = 'Channel';
      if (channel.id === commanderId) where = 'Commander';
      else if ((parent ?? channel).pinnedAt) where = 'Pinned';
      else {
        const gid = getChannelGroupId(parent ?? channel, groups);
        where = groups.find(g => g.id === gid)?.name ?? 'Channel';
      }
      if (parent) where = `${where} · in ${parent.name}`;
      return { channel, where, unread: unreadCounts[channel.id] || 0 };
    })
    .sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || stamp(b.channel) - stamp(a.channel));
}

/** Every word typed must appear in the channel name or where it lives; earlier name matches rank first. */
export function filterJumpEntries(entries: JumpEntry[], query: string): JumpEntry[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  const scored: Array<{ entry: JumpEntry; score: number }> = [];
  for (const entry of entries) {
    const name = entry.channel.name.toLocaleLowerCase();
    const where = entry.where.toLocaleLowerCase();
    let score = 0;
    let ok = true;
    for (const word of words) {
      const at = name.indexOf(word);
      if (at >= 0) score += at === 0 ? 0 : name[at - 1] === ' ' ? 1 : 2;
      else if (where.includes(word)) score += 5;
      else { ok = false; break; }
    }
    if (ok) scored.push({ entry, score });
  }
  return scored.sort((a, b) => a.score - b.score).map(item => item.entry);
}

/** Ctrl+K quick switcher: type a few letters of a channel name, arrows to choose, Enter to open. */
export function ChannelJump({ entries, onPick, onClose }: { entries: JumpEntry[]; onPick: (channel: CollabChannel) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => filterJumpEntries(entries, query).slice(0, 50), [entries, query]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index, results]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(i => Math.min(i + 1, results.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(i => Math.max(i - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); const hit = results[index]; if (hit) onPick(hit.channel); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/65 p-3 pt-[12vh]" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Jump to channel" onKeyDown={onKeyDown} className="w-full max-w-md overflow-hidden rounded-xl border border-white/15 bg-[#101c2d] text-white shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-3">
          <Search size={16} className="text-white/50" aria-hidden />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="channel-jump-list"
            aria-activedescendant={results[index] ? `channel-jump-${results[index].channel.id}` : undefined}
            value={query}
            onChange={event => { setQuery(event.target.value); setIndex(0); }}
            placeholder="Jump to channel…"
            className="h-11 flex-1 bg-transparent text-sm placeholder-white/40 focus:outline-none"
          />
          <kbd className="rounded border border-white/15 px-1.5 text-[10px] text-white/50">Esc</kbd>
        </div>
        <div ref={listRef} id="channel-jump-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 && <p className="px-3 py-6 text-center text-sm text-white/45">No channel matches &ldquo;{query}&rdquo;</p>}
          {results.map((entry, i) => (
            <div
              key={entry.channel.id}
              id={`channel-jump-${entry.channel.id}`}
              role="option"
              aria-selected={i === index}
              onMouseMove={() => setIndex(i)}
              onClick={() => onPick(entry.channel)}
              className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm ${i === index ? 'bg-blue-500/20 text-white' : 'text-white/75'}`}
            >
              <span className={`min-w-0 flex-1 truncate ${entry.unread > 0 ? 'font-semibold' : ''}`}>{entry.channel.name}</span>
              <span className="shrink-0 truncate text-[11px] text-white/40">{entry.where}</span>
              {entry.unread > 0 && <span className="shrink-0 rounded-full bg-blue-500 px-1.5 text-[10px] font-bold">{entry.unread > 99 ? '99+' : entry.unread}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
