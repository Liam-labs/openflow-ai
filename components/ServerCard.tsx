'use client';

import { useState } from 'react';
import {
  Play,
  Square,
  ExternalLink,
  Server,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Bot,
} from 'lucide-react';
import { Project, ServerStatus, PortInfo } from '@/lib/types';

interface ServerCardProps {
  project: Project;
  serverStatus?: ServerStatus;
  portConflict?: PortInfo;
  onStart: (project: Project) => Promise<void>;
  onStop: (project: Project) => Promise<void>;
}

export function ServerCard({
  project,
  serverStatus,
  portConflict,
  onStart,
  onStop,
}: ServerCardProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isOpeningClaude, setIsOpeningClaude] = useState(false);
  const isRunning = serverStatus?.isRunning ?? false;
  const port = project.server?.port;

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

  const handleStart = async () => {
    setIsLoading(true);
    try {
      await onStart(project);
    } finally {
      setIsLoading(false);
    }
  };

  const handleStop = async () => {
    setIsLoading(true);
    try {
      await onStop(project);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpen = () => {
    if (project.links.local) {
      window.open(project.links.local, '_blank');
    } else if (port) {
      window.open(`http://localhost:${port}`, '_blank');
    }
  };

  return (
    <div className="glass-card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div
            className={`p-2 rounded-lg ${
              isRunning
                ? 'bg-success/20 text-success'
                : 'bg-muted/20 text-muted'
            }`}
          >
            <Server className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">{project.name}</h3>
            <p className="text-sm text-muted">{project.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {project.server?.autoStart && (
            <div
              className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/20 text-accent text-xs"
              title="Auto-start enabled"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Auto</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span
              className={`status-dot ${isRunning ? 'online' : 'offline'}`}
            />
            <span className={`text-sm ${isRunning ? 'text-success' : 'text-muted'}`}>
              {isRunning ? 'Running' : 'Stopped'}
            </span>
          </div>
        </div>
      </div>

      {port && (
        <div className="flex items-center gap-4 mb-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted">Port:</span>
            <span className="font-mono font-medium">{port}</span>
          </div>
          {serverStatus?.pid && (
            <div className="flex items-center gap-2">
              <span className="text-muted">PID:</span>
              <span className="font-mono font-medium">{serverStatus.pid}</span>
            </div>
          )}
        </div>
      )}

      {portConflict && !isRunning && (
        <div className="flex items-center gap-2 p-3 mb-4 rounded-lg bg-warning/10 border border-warning/20">
          <AlertTriangle className="w-4 h-4 text-warning" />
          <div className="text-sm">
            <span className="text-warning font-medium">Port conflict: </span>
            <span className="text-muted">
              Port {portConflict.port} is in use by {portConflict.process} (PID: {portConflict.pid})
            </span>
          </div>
        </div>
      )}

      {project.server?.startCommand && (
        <div className="text-xs text-muted mb-4 font-mono bg-black/30 p-2 rounded">
          {project.server.startCommand}
        </div>
      )}

      <div className="flex items-center gap-2 pt-3 border-t border-card-border">
        {isRunning ? (
          <>
            <button
              onClick={handleStop}
              disabled={isLoading}
              className="action-button flex-1 bg-error/20 text-error border-error/30 hover:bg-error/30"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Square className="w-4 h-4" />
              )}
              <span>Stop</span>
            </button>
            <button
              onClick={handleOpen}
              className="action-button launch flex-1"
            >
              <ExternalLink className="w-4 h-4" />
              <span>Open</span>
            </button>
          </>
        ) : (
          <button
            onClick={handleStart}
            disabled={isLoading || !!portConflict}
            className={`action-button launch flex-1 ${
              portConflict ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            <span>Start</span>
          </button>
        )}
        <button
          onClick={handleOpenClaude}
          disabled={isOpeningClaude}
          className="action-button folder"
          title="Open with Claude"
        >
          {isOpeningClaude ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Bot className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}
