'use client';

import { useState, useEffect, useCallback } from 'react';
import { ExternalLink, Github, FolderOpen, Terminal, Loader2, Play, Square, Image, Shield, Radio, Trash2, AlertTriangle } from 'lucide-react';
import { Project, ProjectHealthStatus } from '@/lib/types';
import { ImageOptimizerModal } from './ImageOptimizerModal';
import { SecretsModal } from './SecretsModal';

interface SiteCardProps {
  project: Project;
  healthStatus?: ProjectHealthStatus;
  onDelete?: () => void;
}

interface DevServerStatus {
  running: boolean;
  port?: number;
  pm2Name?: string;
}

export function SiteCard({ project, healthStatus, onDelete }: SiteCardProps) {
  const [isOpeningClaude, setIsOpeningClaude] = useState(false);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const [devServerStatus, setDevServerStatus] = useState<DevServerStatus>({ running: false });
  const [isDevServerLoading, setIsDevServerLoading] = useState(false);
  const [showImageOptimizer, setShowImageOptimizer] = useState(false);
  const [showSecretsScanner, setShowSecretsScanner] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteDirectory, setDeleteDirectory] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const status = healthStatus?.overallStatus || 'unknown';

  const checkDevServerStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/dev-server?projectId=${project.id}`);
      if (response.ok) {
        const data = await response.json();
        setDevServerStatus(data);
      }
    } catch (error) {
      console.error('Failed to check dev server status:', error);
    }
  }, [project.id]);

  useEffect(() => {
    checkDevServerStatus();
    const interval = setInterval(checkDevServerStatus, 30000);
    return () => clearInterval(interval);
  }, [checkDevServerStatus]);

  const handleDevServer = async () => {
    setIsDevServerLoading(true);
    try {
      const action = devServerStatus.running ? 'stop' : 'start';
      const response = await fetch('/api/dev-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, action }),
      });
      if (response.ok) {
        const data = await response.json();
        if (action === 'start' && data.port) {
          setDevServerStatus({ running: true, port: data.port, pm2Name: data.pm2Name });
        } else {
          setDevServerStatus({ running: false });
        }
      }
    } catch (error) {
      console.error('Dev server action failed:', error);
    } finally {
      setIsDevServerLoading(false);
      setTimeout(checkDevServerStatus, 1000);
    }
  };

  const handleOpenFolder = async () => {
    setIsOpeningFolder(true);
    try {
      const response = await fetch('/api/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      });
      if (!response.ok) {
        console.error('Failed to open folder');
      }
    } catch (error) {
      console.error('Error opening folder:', error);
    } finally {
      setTimeout(() => setIsOpeningFolder(false), 1000);
    }
  };

  const handleOpenClaude = async () => {
    setIsOpeningClaude(true);
    try {
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      });
      if (!response.ok) {
        console.error('Failed to open Claude');
      }
    } catch (error) {
      console.error('Error opening Claude:', error);
    } finally {
      setTimeout(() => setIsOpeningClaude(false), 1000);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const response = await fetch('/api/projects', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, deleteDirectory }),
      });
      if (response.ok) {
        setShowDeleteConfirm(false);
        onDelete?.();
      } else {
        const data = await response.json();
        console.error('Failed to delete project:', data.error);
      }
    } catch (error) {
      console.error('Error deleting project:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const statusColors: Record<string, string> = {
    online: 'bg-emerald-500',
    warning: 'bg-amber-500',
    offline: 'bg-red-500',
    unknown: 'bg-slate-500',
    checking: 'bg-slate-500',
  };

  return (
    <div className="group relative bg-slate-900/50 border border-slate-700/50 rounded-lg overflow-hidden hover:border-slate-600/50 transition-all duration-200">
      {/* Header */}
      <div className="px-4 py-4 border-b border-slate-700/30">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-3 h-3 rounded-full flex-shrink-0 ${statusColors[status] || 'bg-slate-500'} ${status === 'online' ? 'animate-pulse' : ''}`} />
          <h3 className="font-bold text-xl text-slate-100 truncate flex-1">{project.name}</h3>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="p-1 rounded opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all duration-150"
            title="Remove site"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Actions - Fixed 6-button row with labels */}
      <div className="px-3 py-3">
        <div className="flex justify-between items-start">
          {/* Position 1: Dev Server */}
          <div className="flex flex-col items-center w-10">
            {project.devServer?.enabled !== false ? (
              <>
                <button
                  onClick={handleDevServer}
                  disabled={isDevServerLoading}
                  className={`p-1.5 rounded-md transition-all duration-150 ${
                    devServerStatus.running
                      ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/30'
                      : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/30'
                  }`}
                >
                  {isDevServerLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : devServerStatus.running ? (
                    <Square className="w-4 h-4" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                </button>
                <span className={`text-[9px] mt-1 font-medium ${devServerStatus.running ? 'text-red-400' : 'text-emerald-400'}`}>
                  {devServerStatus.running ? 'Stop' : 'Dev'}
                </span>
              </>
            ) : (
              <>
                <div className="p-1.5 rounded-md bg-slate-700/20 border border-slate-700/30 cursor-not-allowed">
                  <Play className="w-4 h-4 text-slate-600" />
                </div>
                <span className="text-[9px] mt-1 font-medium text-slate-600">Dev</span>
              </>
            )}
          </div>

          {/* Position 2: Claude */}
          <div className="flex flex-col items-center w-10">
            <button
              onClick={handleOpenClaude}
              disabled={isOpeningClaude}
              className="p-1.5 rounded-md bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 border border-violet-500/30 transition-all duration-150"
            >
              {isOpeningClaude ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Terminal className="w-4 h-4" />
              )}
            </button>
            <span className="text-[9px] mt-1 font-medium text-violet-400">Claude</span>
          </div>

          {/* Position 3: Visit */}
          <div className="flex flex-col items-center w-10">
            {((devServerStatus.running && devServerStatus.port) || project.links.live || project.links.local) ? (
              <>
                <a
                  href={devServerStatus.running && devServerStatus.port ? `http://localhost:${devServerStatus.port}` : (project.links.live || project.links.local)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1.5 rounded-md bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/30 transition-all duration-150"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
                <span className="text-[9px] mt-1 font-medium text-blue-400">Visit</span>
              </>
            ) : (
              <>
                <div className="p-1.5 rounded-md bg-slate-700/20 border border-slate-700/30 cursor-not-allowed">
                  <ExternalLink className="w-4 h-4 text-slate-600" />
                </div>
                <span className="text-[9px] mt-1 font-medium text-slate-600">Visit</span>
              </>
            )}
          </div>

          {/* Position 4: Folder */}
          <div className="flex flex-col items-center w-10">
            <button
              onClick={handleOpenFolder}
              disabled={isOpeningFolder}
              className="p-1.5 rounded-md bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/30 transition-all duration-150"
            >
              {isOpeningFolder ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FolderOpen className="w-4 h-4" />
              )}
            </button>
            <span className="text-[9px] mt-1 font-medium text-amber-400">Folder</span>
          </div>

          {/* Position 5: GitHub */}
          <div className="flex flex-col items-center w-10">
            {project.links.repo ? (
              <>
                <a
                  href={project.links.repo}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1.5 rounded-md bg-slate-500/15 text-slate-300 hover:bg-slate-500/25 border border-slate-500/30 transition-all duration-150"
                >
                  <Github className="w-4 h-4" />
                </a>
                <span className="text-[9px] mt-1 font-medium text-slate-400">GitHub</span>
              </>
            ) : (
              <>
                <div className="p-1.5 rounded-md bg-slate-700/20 border border-slate-700/30 cursor-not-allowed">
                  <Github className="w-4 h-4 text-slate-600" />
                </div>
                <span className="text-[9px] mt-1 font-medium text-slate-600">GitHub</span>
              </>
            )}
          </div>

          {/* Position 6: Images */}
          <div className="flex flex-col items-center w-10">
            <button
              onClick={() => setShowImageOptimizer(true)}
              className="p-1.5 rounded-md bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 border border-pink-500/30 transition-all duration-150"
            >
              <Image className="w-4 h-4" />
            </button>
            <span className="text-[9px] mt-1 font-medium text-pink-400">Images</span>
          </div>
        </div>
      </div>

      {/* Dev Server Status Bar - always at bottom, below all icons */}
      {devServerStatus.running && devServerStatus.port && (
        <div className="px-3 py-1.5 bg-emerald-500/10 border-t border-emerald-500/20 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Radio className="w-2.5 h-2.5 text-emerald-400" />
            <span className="text-[10px] text-emerald-400 font-medium">Running</span>
          </div>
          <a
            href={`http://localhost:${devServerStatus.port}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-emerald-400 hover:text-emerald-300 font-mono transition-colors"
          >
            :{devServerStatus.port}
          </a>
        </div>
      )}

      {showImageOptimizer && (
        <ImageOptimizerModal
          project={project}
          onClose={() => setShowImageOptimizer(false)}
        />
      )}

      {showSecretsScanner && (
        <SecretsModal
          project={project}
          onClose={() => setShowSecretsScanner(false)}
        />
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-red-500/15 border border-red-500/30">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <h3 className="text-lg font-semibold text-slate-100">Remove {project.name}?</h3>
            </div>
            <p className="text-sm text-slate-400 mb-4">
              This will remove <span className="text-slate-200 font-medium">{project.name}</span> from the Sites dashboard.
            </p>
            <label className="flex items-start gap-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20 cursor-pointer mb-5 hover:bg-red-500/10 transition-colors">
              <input
                type="checkbox"
                checked={deleteDirectory}
                onChange={e => setDeleteDirectory(e.target.checked)}
                className="mt-0.5 accent-red-500"
              />
              <div>
                <span className="text-sm font-medium text-red-400">Also delete working directory</span>
                <p className="text-xs text-slate-500 mt-0.5 font-mono">{project.path}</p>
              </div>
            </label>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeleteDirectory(false); }}
                className="px-4 py-2 text-sm rounded-md bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="px-4 py-2 text-sm rounded-md bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/40 transition-colors disabled:opacity-50"
              >
                {isDeleting ? 'Removing...' : deleteDirectory ? 'Remove & Delete' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
