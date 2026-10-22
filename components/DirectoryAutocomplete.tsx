'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Folder, FolderOpen, Bookmark } from 'lucide-react';

import { getHomeDir } from '@/lib/home-dir';
interface DirectoryAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  iconClassName?: string;
  iconSize?: string;
}

interface FolderResult {
  path: string;
  directories: string[];
  bookmarks?: string[];
}

export function DirectoryAutocomplete({
  value,
  onChange,
  placeholder = '/home/you/project',
  className = '',
  iconClassName = 'w-3.5 h-3.5 text-amber-400/60 flex-shrink-0',
  iconSize,
}: DirectoryAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Fetch bookmarks on first focus
  const fetchBookmarks = useCallback(async () => {
    if (bookmarks.length > 0) return;
    try {
      const res = await fetch(`/api/folder?path=${encodeURIComponent(getHomeDir())}&bookmarks=true`);
      if (res.ok) {
        const data: FolderResult = await res.json();
        setBookmarks((data.bookmarks || []).map((b: { name?: string; path?: string } | string) => typeof b === 'string' ? b : (b.path || b.name || '')).filter(Boolean));
      }
    } catch { /* ignore */ }
  }, [bookmarks.length]);

  // Fetch directory suggestions for a path
  const fetchSuggestions = useCallback(async (inputPath: string) => {
    if (!inputPath || inputPath.length < 2) {
      setSuggestions([]);
      return;
    }

    // Determine parent directory and partial name
    const lastSlash = inputPath.lastIndexOf('/');
    const parentDir = lastSlash > 0 ? inputPath.substring(0, lastSlash) : '/';
    const partial = lastSlash >= 0 ? inputPath.substring(lastSlash + 1).toLowerCase() : '';

    setLoading(true);
    try {
      const res = await fetch(`/api/folder?path=${encodeURIComponent(parentDir)}`);
      if (res.ok) {
        const data: FolderResult = await res.json();
        const dirs = data.directories || [];

        // Filter by partial match
        const filtered = partial
          ? dirs.filter(d => d.toLowerCase().startsWith(partial))
          : dirs;

        // Build full paths
        const fullPaths = filtered.slice(0, 10).map(d =>
          parentDir === '/' ? `/${d}` : `${parentDir}/${d}`
        );

        setSuggestions(fullPaths);
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  // Debounced fetch on input change
  const handleInputChange = (newValue: string) => {
    onChange(newValue);
    setHighlightIndex(-1);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchSuggestions(newValue);
      setShowDropdown(true);
    }, 200);
  };

  const handleFocus = () => {
    fetchBookmarks();
    setShowDropdown(true);
    if (value) fetchSuggestions(value);
  };

  const selectSuggestion = (path: string) => {
    onChange(path);
    setSuggestions([]);
    setShowDropdown(false);
    setHighlightIndex(-1);
    // After selecting a directory, fetch its contents for further navigation
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const items = getDropdownItems();
    if (!showDropdown || items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(prev => Math.min(prev + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      e.preventDefault();
      selectSuggestion(items[highlightIndex].path);
    } else if (e.key === 'Tab' && highlightIndex >= 0) {
      e.preventDefault();
      selectSuggestion(items[highlightIndex].path);
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    }
  };

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current && !inputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Cleanup debounce
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const getDropdownItems = () => {
    const items: Array<{ path: string; label: string; type: 'bookmark' | 'directory' }> = [];

    // Show bookmarks when input is empty or short
    if ((!value || value.length < 3) && bookmarks.length > 0) {
      bookmarks.forEach(b => {
        if (!value || b.toLowerCase().includes(value.toLowerCase())) {
          items.push({ path: b, label: b, type: 'bookmark' });
        }
      });
    }

    // Add directory suggestions
    suggestions.forEach(s => {
      if (!items.find(i => i.path === s)) {
        items.push({ path: s, label: s, type: 'directory' });
      }
    });

    return items.slice(0, 12);
  };

  const items = showDropdown ? getDropdownItems() : [];

  return (
    <div className="relative flex items-center gap-1.5 flex-1">
      <Folder className={iconClassName} />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => handleInputChange(e.target.value)}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={className}
      />
      {showDropdown && items.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute left-0 top-full mt-1 w-full z-[60] bg-[#0c1829] border border-white/10 rounded-lg shadow-xl max-h-48 overflow-y-auto"
        >
          {items.map((item, i) => (
            <button
              key={item.path}
              onClick={(e) => { e.stopPropagation(); selectSuggestion(item.path); }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                i === highlightIndex
                  ? 'bg-purple-500/20 text-purple-300'
                  : 'text-white/70 hover:bg-white/5'
              }`}
            >
              {item.type === 'bookmark' ? (
                <Bookmark className="w-3 h-3 text-amber-400/60 flex-shrink-0" />
              ) : (
                <FolderOpen className="w-3 h-3 text-white/30 flex-shrink-0" />
              )}
              <span className="truncate font-mono">{item.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
