'use client';

import { useState } from 'react';
import { Play, FolderOpen, Terminal, ExternalLink, Github, Loader2, Bot, Shield } from 'lucide-react';
import { Project } from '@/lib/types';
import { SecretsModal } from './SecretsModal';

interface ToolCardProps {
  project: Project;
  onLaunch?: (project: Project) => void;
  onOpenFolder?: (project: Project) => void;
  onOpenTerminal?: (project: Project) => void;
}

export function ToolCard({
  project,
  onLaunch,
  onOpenFolder,
  onOpenTerminal,
}: ToolCardProps) {
  const [isOpeningClaude, setIsOpeningClaude] = useState(false);
  const [showSecretsScanner, setShowSecretsScanner] = useState(false);

  const handleLaunch = () => {
    if (project.links.local) {
      window.open(project.links.local, '_blank');
    }
    onLaunch?.(project);
  };

  const handleOpenFolder = () => {
    onOpenFolder?.(project);
  };

  const handleOpenTerminal = () => {
    onOpenTerminal?.(project);
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

  return (
    <div className="glass-card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-semibold truncate">{project.name}</h3>
          </div>
          <p className="text-sm text-muted line-clamp-2">{project.description}</p>
        </div>
        {project.links.repo && (
          <a
            href={project.links.repo}
            target="_blank"
            rel="noopener noreferrer"
            className="icon-link ml-2"
            title="View repository"
          >
            <Github className="w-5 h-5" />
          </a>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {project.tags.map((tag) => (
          <span key={tag} className="tag-pill">
            {tag}
          </span>
        ))}
      </div>

      <div className="flex items-center gap-2 mb-4 text-xs text-muted">
        <FolderOpen className="w-3.5 h-3.5" />
        <span className="truncate" title={project.path}>
          {project.path}
        </span>
      </div>

      <div className="flex items-center gap-2 pt-3 border-t border-card-border">
        <button
          onClick={handleOpenClaude}
          disabled={isOpeningClaude}
          className="action-button launch flex-1"
          title="Open with Claude"
        >
          {isOpeningClaude ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Bot className="w-4 h-4" />
          )}
          <span>Claude</span>
        </button>

        <button
          onClick={handleOpenFolder}
          className="action-button folder"
          title="Open project folder"
        >
          <FolderOpen className="w-4 h-4" />
        </button>

        <button
          onClick={handleOpenTerminal}
          className="action-button terminal"
          title="Open terminal in project"
        >
          <Terminal className="w-4 h-4" />
        </button>

        <button
          onClick={() => setShowSecretsScanner(true)}
          className="action-button folder"
          title="Scan for secrets"
        >
          <Shield className="w-4 h-4" />
        </button>

        {project.links.local && (
          <a
            href={project.links.local}
            target="_blank"
            rel="noopener noreferrer"
            className="action-button folder"
            title="Open in browser"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
      </div>

      {showSecretsScanner && (
        <SecretsModal
          project={project}
          onClose={() => setShowSecretsScanner(false)}
        />
      )}
    </div>
  );
}
