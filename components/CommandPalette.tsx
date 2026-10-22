'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Search, ArrowRight, X } from 'lucide-react';
import type { CollabTask } from '@/lib/types';

interface CommandPaletteProps {
  tasks: CollabTask[];
  onSelectTask: (task: CollabTask) => void;
  onClose: () => void;
}

export function CommandPalette({ tasks, onSelectTask, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = query.trim()
    ? tasks.filter(t => t.title.toLowerCase().includes(query.toLowerCase().trim()))
    : tasks.slice(0, 10);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLButtonElement>(`[data-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        onClose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        if (filtered[selectedIndex]) {
          onSelectTask(filtered[selectedIndex]);
          onClose();
        }
        break;
    }
  };

  const statusColors: Record<string, string> = {
    todo: 'text-white/35',
    in_progress: 'text-blue-400',
    done: 'text-green-400',
  };
  const statusLabels: Record<string, string> = {
    todo: 'Todo',
    in_progress: 'In Progress',
    done: 'Done',
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-[3px]" onClick={onClose} />

      {/* Palette */}
      <div
        className="command-palette fixed top-[18vh] left-1/2 -translate-x-1/2 z-[61] w-full max-w-[560px] mx-4 bg-[#0c1a2e] border border-white/[0.1] rounded-2xl overflow-hidden"
        style={{
          boxShadow: '0 24px 64px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.05) inset',
        }}
      >
        {/* Search row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
          <Search className="w-4 h-4 text-white/30 flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search tasks…"
            className="flex-1 bg-transparent text-sm text-white/90 placeholder-white/30 focus:outline-none"
          />
          {query ? (
            <button
              onClick={() => setQuery('')}
              className="text-white/30 hover:text-white/60 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <kbd className="text-[10px] text-white/20 bg-white/[0.06] px-1.5 py-0.5 rounded font-mono flex-shrink-0">
              ESC
            </kbd>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[380px] overflow-y-auto sprint-board-scroll py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-white/25">No tasks found</div>
          ) : (
            filtered.map((task, idx) => (
              <button
                key={task.id}
                data-idx={idx}
                onClick={() => { onSelectTask(task); onClose(); }}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  idx === selectedIndex
                    ? 'bg-white/[0.07] text-white'
                    : 'hover:bg-white/[0.04] text-white/80'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{task.title}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-[11px] ${statusColors[task.status] ?? ''}`}>
                      {statusLabels[task.status] ?? task.status}
                    </span>
                    {task.priority === 'high' && (
                      <span className="text-[11px] text-red-400">· High</span>
                    )}
                  </div>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-white/20 flex-shrink-0" />
              </button>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-white/[0.04] text-[11px] text-white/20">
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> open
          </span>
          <span>
            <kbd className="font-mono">⌘K</kbd> close
          </span>
          {filtered.length > 0 && (
            <span className="ml-auto tabular-nums">{filtered.length} tasks</span>
          )}
        </div>
      </div>
    </>
  );
}
