'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Folder, FolderOpen, ChevronRight, ChevronDown, Bookmark, ArrowUp } from 'lucide-react';

import { getHomeDir } from '@/lib/home-dir';
interface DirectoryBrowserProps {
  value: string;
  onChange: (path: string) => void;
}

interface DirEntry {
  name: string;
  expanded?: boolean;
  children?: DirEntry[];
  loaded?: boolean;
}

interface Bookmark {
  name: string;
  path: string;
}

export function DirectoryBrowser({ value, onChange }: DirectoryBrowserProps) {
  const [currentPath, setCurrentPath] = useState(value || getHomeDir());
  const [directories, setDirectories] = useState<string[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(false);
  const [manualInput, setManualInput] = useState(value || getHomeDir());

  const fetchDirectories = useCallback(async (dirPath: string, includeBookmarks = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ path: dirPath });
      if (includeBookmarks) params.set('bookmarks', 'true');

      const res = await fetch(`/api/folder?${params}`);
      const data = await res.json();

      if (data.directories) {
        setDirectories(data.directories);
        setCurrentPath(data.path || dirPath);
      }
      if (data.bookmarks) {
        setBookmarks(data.bookmarks);
      }
    } catch (err) {
      console.error('Failed to browse directory:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load with bookmarks
  useEffect(() => {
    fetchDirectories(currentPath, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateTo = (dirPath: string) => {
    const newPath = dirPath;
    setCurrentPath(newPath);
    setManualInput(newPath);
    onChange(newPath);
    fetchDirectories(newPath);
  };

  const navigateUp = () => {
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/home';
    navigateTo(parent);
  };

  const selectDir = (dirName: string) => {
    const newPath = `${currentPath}/${dirName}`.replace(/\/+/g, '/');
    navigateTo(newPath);
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualInput.startsWith('/home/')) {
      navigateTo(manualInput);
    }
  };

  const pathParts = currentPath.split('/').filter(Boolean);

  return (
    <div className="flex flex-col gap-2">
      {/* Bookmarks bar */}
      {bookmarks.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {bookmarks.map((bm) => (
            <button
              key={bm.path}
              onClick={() => navigateTo(bm.path)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                currentPath === bm.path
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'bg-white/5 text-muted hover:bg-white/10 border border-transparent'
              }`}
            >
              <Bookmark className="w-3 h-3" />
              {bm.name}
            </button>
          ))}
        </div>
      )}

      {/* Breadcrumb path */}
      <div className="flex items-center gap-1 text-xs text-muted overflow-x-auto">
        <button
          onClick={navigateUp}
          className="p-1 rounded hover:bg-white/10 flex-shrink-0"
          title="Go up"
        >
          <ArrowUp className="w-3 h-3" />
        </button>
        <span className="text-muted">/</span>
        {pathParts.map((part, i) => {
          const partPath = '/' + pathParts.slice(0, i + 1).join('/');
          return (
            <React.Fragment key={partPath}>
              <button
                onClick={() => navigateTo(partPath)}
                className="hover:text-foreground transition-colors whitespace-nowrap"
              >
                {part}
              </button>
              {i < pathParts.length - 1 && <span className="text-muted">/</span>}
            </React.Fragment>
          );
        })}
      </div>

      {/* Directory list */}
      <div className="bg-black/30 rounded-lg border border-white/10 max-h-48 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-muted text-xs">Loading...</div>
        ) : directories.length === 0 ? (
          <div className="p-4 text-center text-muted text-xs">No subdirectories</div>
        ) : (
          directories.map((dir) => (
            <button
              key={dir}
              onClick={() => selectDir(dir)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-white/5 transition-colors"
            >
              <Folder className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
              <span className="truncate">{dir}</span>
            </button>
          ))
        )}
      </div>

      {/* Manual path input */}
      <form onSubmit={handleManualSubmit} className="flex gap-1">
        <input
          type="text"
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          placeholder="/home/you/project"
          className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-blue-500/50"
        />
        <button
          type="submit"
          className="px-2 py-1 bg-white/5 hover:bg-white/10 rounded text-xs text-muted border border-white/10"
        >
          Go
        </button>
      </form>

      {/* Selected path display */}
      <div className="text-[10px] text-muted">
        Selected: <span className="text-foreground font-mono">{currentPath}</span>
      </div>
    </div>
  );
}
