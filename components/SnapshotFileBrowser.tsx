'use client';

import { useState, useEffect, useCallback } from 'react';
import { getHomeDir } from '@/lib/home-dir';
import {
  Folder,
  File,
  ChevronRight,
  Download,
  RotateCcw,
  Search,
  X,
  Loader2,
  CheckSquare,
  Square,
  Home,
  ArrowUp,
} from 'lucide-react';

interface SnapshotFile {
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: string;
  mode: number;
}

interface SnapshotFileBrowserProps {
  snapshotId: string;
  snapshotTime: string;
  onRestore: (snapshotId: string, targetPath: string, include?: string[]) => void;
  onClose: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '-';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

function getParentPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  parts.pop();
  return '/' + parts.join('/');
}

export function SnapshotFileBrowser({
  snapshotId,
  snapshotTime,
  onRestore,
  onClose,
}: SnapshotFileBrowserProps) {
  const [files, setFiles] = useState<SnapshotFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [currentPath, setCurrentPath] = useState(getHomeDir());
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [restorePath, setRestorePath] = useState(`${getHomeDir()}/restored`);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/backups?action=list-files&snapshotId=${snapshotId}&path=${encodeURIComponent(currentPath)}`);
      const data = await res.json();
      if (data.success) {
        setFiles(data.files || []);
      } else {
        setError(data.error || 'Failed to load files');
      }
    } catch (err) {
      setError('Failed to fetch files');
    } finally {
      setLoading(false);
    }
  }, [snapshotId, currentPath]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const handleDownload = (filePath: string) => {
    window.open(`/api/backups?action=download-file&snapshotId=${snapshotId}&filePath=${encodeURIComponent(filePath)}`, '_blank');
  };

  const toggleSelect = (path: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const navigateToDir = (path: string) => {
    setCurrentPath(path);
    setFilter('');
  };

  const handleRestoreSelected = () => {
    setShowRestoreModal(true);
  };

  const confirmRestore = () => {
    const include = selectedFiles.size > 0 ? Array.from(selectedFiles) : undefined;
    onRestore(snapshotId, restorePath, include);
    setShowRestoreModal(false);
  };

  // Filter files
  const filteredFiles = files.filter((f) =>
    filter ? getFileName(f.path).toLowerCase().includes(filter.toLowerCase()) : true
  );

  // Breadcrumb parts
  const pathParts = currentPath.split('/').filter(Boolean);

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-700 bg-gray-800/80">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-purple-400">
            Snapshot: <span className="font-mono">{snapshotId.slice(0, 8)}</span>
          </span>
          <span className="text-xs text-gray-500">
            {formatDate(snapshotTime)}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-gray-700"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Breadcrumb navigation */}
      <div className="flex items-center gap-1 p-2 border-b border-gray-700 bg-gray-900/30 text-sm overflow-x-auto">
        <button
          onClick={() => navigateToDir('/')}
          className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
          title="Go to root"
        >
          <Home className="w-4 h-4" />
        </button>
        <ChevronRight className="w-4 h-4 text-gray-600 flex-shrink-0" />
        {pathParts.map((part, idx) => {
          const path = '/' + pathParts.slice(0, idx + 1).join('/');
          const isLast = idx === pathParts.length - 1;
          return (
            <div key={path} className="flex items-center gap-1">
              <button
                onClick={() => navigateToDir(path)}
                className={`px-1.5 py-0.5 rounded ${
                  isLast
                    ? 'text-purple-400 font-medium'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >
                {part}
              </button>
              {!isLast && <ChevronRight className="w-4 h-4 text-gray-600 flex-shrink-0" />}
            </div>
          );
        })}

        {/* Up button */}
        {currentPath !== '/' && (
          <button
            onClick={() => navigateToDir(getParentPath(currentPath))}
            className="ml-auto p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
            title="Go up one level"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Filter and actions bar */}
      <div className="flex items-center gap-2 p-2 border-b border-gray-700 bg-gray-800/50">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files in this folder..."
            className="w-full pl-8 pr-3 py-1.5 bg-gray-900/50 border border-gray-700 rounded text-sm focus:outline-none focus:border-purple-500"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Selection info and restore button */}
        <div className="flex items-center gap-2">
          {selectedFiles.size > 0 && (
            <span className="text-xs text-purple-400">
              {selectedFiles.size} selected
            </span>
          )}
          <button
            onClick={handleRestoreSelected}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 rounded text-sm font-medium transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {selectedFiles.size > 0 ? 'Restore Selected' : 'Restore All'}
          </button>
        </div>
      </div>

      {/* File list */}
      <div className="max-h-80 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
            <span className="ml-2 text-gray-400">Loading files...</span>
          </div>
        ) : error ? (
          <div className="p-8 text-center text-red-400">{error}</div>
        ) : filteredFiles.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {filter ? `No files matching "${filter}"` : 'No files in this directory'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-900/50 sticky top-0">
              <tr>
                <th className="text-left p-2 text-gray-400 font-medium w-8"></th>
                <th className="text-left p-2 text-gray-400 font-medium">Name</th>
                <th className="text-right p-2 text-gray-400 font-medium w-24">Size</th>
                <th className="text-right p-2 text-gray-400 font-medium w-44">Modified</th>
                <th className="text-right p-2 text-gray-400 font-medium w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filteredFiles.map((file) => (
                <tr
                  key={file.path}
                  className={`border-t border-gray-700/50 hover:bg-gray-700/30 ${
                    selectedFiles.has(file.path) ? 'bg-purple-900/20' : ''
                  }`}
                >
                  <td className="p-2">
                    <button
                      onClick={() => toggleSelect(file.path)}
                      className="text-gray-400 hover:text-purple-400"
                    >
                      {selectedFiles.has(file.path) ? (
                        <CheckSquare className="w-4 h-4 text-purple-400" />
                      ) : (
                        <Square className="w-4 h-4" />
                      )}
                    </button>
                  </td>
                  <td className="p-2">
                    {file.type === 'dir' ? (
                      <button
                        onClick={() => navigateToDir(file.path)}
                        className="flex items-center gap-2 text-left hover:text-purple-400 transition-colors"
                      >
                        <Folder className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                        <span className="truncate">{getFileName(file.path)}</span>
                      </button>
                    ) : (
                      <span className="flex items-center gap-2">
                        <File className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        <span className="truncate">{getFileName(file.path)}</span>
                      </span>
                    )}
                  </td>
                  <td className="p-2 text-right text-gray-400">
                    {file.type === 'file' ? formatFileSize(file.size) : '-'}
                  </td>
                  <td className="p-2 text-right text-gray-500 text-xs">
                    {file.mtime ? new Date(file.mtime).toLocaleDateString() : '-'}
                  </td>
                  <td className="p-2 text-right">
                    {file.type === 'file' && (
                      <button
                        onClick={() => handleDownload(file.path)}
                        className="p-1 text-cyan-400 hover:text-cyan-300"
                        title="Download"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between p-2 border-t border-gray-700 bg-gray-800/50 text-xs text-gray-500">
        <span>
          {filteredFiles.length} {filteredFiles.length === 1 ? 'item' : 'items'}
          {filter && files.length !== filteredFiles.length && ` (filtered from ${files.length})`}
        </span>
        <span className="text-gray-600">{currentPath}</span>
      </div>

      {/* Restore Modal */}
      {showRestoreModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 max-w-md mx-4 shadow-2xl">
            <div className="flex items-start gap-4 mb-4">
              <div className="p-3 rounded-xl bg-purple-500/20">
                <RotateCcw className="w-6 h-6 text-purple-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">
                  {selectedFiles.size > 0 ? 'Restore Selected Files' : 'Restore Full Snapshot'}
                </h3>
                <p className="text-gray-400 text-sm mt-1">
                  {selectedFiles.size > 0
                    ? `Restoring ${selectedFiles.size} selected item(s)`
                    : 'Restoring entire snapshot contents'}
                </p>
              </div>
              <button
                onClick={() => setShowRestoreModal(false)}
                className="text-gray-500 hover:text-gray-300 ml-auto"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  Restore to directory
                </label>
                <input
                  type="text"
                  value={restorePath}
                  onChange={(e) => setRestorePath(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-900/50 border border-gray-700 rounded text-sm focus:outline-none focus:border-purple-500"
                  placeholder="/home/you/restored"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Must be under your home folder or /tmp/restore
                </p>
              </div>

              {selectedFiles.size > 0 && (
                <div className="bg-gray-900/50 rounded-lg p-3 max-h-32 overflow-y-auto">
                  <p className="text-xs text-gray-400 mb-2">Files to restore:</p>
                  <ul className="text-xs font-mono text-gray-300 space-y-0.5">
                    {Array.from(selectedFiles).slice(0, 10).map((path) => (
                      <li key={path} className="truncate" title={path}>
                        {path}
                      </li>
                    ))}
                    {selectedFiles.size > 10 && (
                      <li className="text-gray-500">... and {selectedFiles.size - 10} more</li>
                    )}
                  </ul>
                </div>
              )}

              <div className="bg-purple-900/20 border border-purple-700/50 rounded-lg p-3">
                <p className="text-sm text-purple-200">
                  <strong>Note:</strong> Existing files will be overwritten. The restore runs in the background.
                </p>
              </div>
            </div>

            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={() => setShowRestoreModal(false)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmRestore}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-white font-medium transition-colors flex items-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Start Restore
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
