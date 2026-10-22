'use client';

import {
  ExternalLink,
  FolderOpen,
  Github,
  FileText,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useState } from 'react';
import { Project, ProjectHealthStatus } from '@/lib/types';
import { StatusBadge, HealthCheckBadge } from './StatusBadge';

interface ProjectCardProps {
  project: Project;
  healthStatus?: ProjectHealthStatus;
}

export function ProjectCard({ project, healthStatus }: ProjectCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const status = healthStatus?.overallStatus || 'unknown';

  return (
    <div className="glass-card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-semibold truncate">{project.name}</h3>
            <span className={`category-badge ${project.category}`}>
              {project.category}
            </span>
          </div>
          <p className="text-sm text-muted line-clamp-2">{project.description}</p>
        </div>
        <StatusBadge status={status} size="md" />
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {project.tags.map((tag) => (
          <span key={tag} className="tag-pill">
            {tag}
          </span>
        ))}
      </div>

      <div className="flex items-center gap-3 mb-4 text-sm">
        <div className="flex items-center gap-1.5 text-muted">
          <FolderOpen className="w-4 h-4" />
          <span className="truncate max-w-[200px]" title={project.path}>
            {project.path.split('/').slice(-2).join('/')}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {project.links.local && (
            <a
              href={project.links.local}
              target="_blank"
              rel="noopener noreferrer"
              className="icon-link"
              title="Open local URL"
            >
              <ExternalLink className="w-5 h-5" />
            </a>
          )}
          {project.links.repo && (
            <a
              href={project.links.repo}
              target="_blank"
              rel="noopener noreferrer"
              className="icon-link"
              title="Open repository"
            >
              <Github className="w-5 h-5" />
            </a>
          )}
          {project.links.docs && (
            <a
              href={project.links.docs}
              target="_blank"
              rel="noopener noreferrer"
              className="icon-link"
              title="Open documentation"
            >
              <FileText className="w-5 h-5" />
            </a>
          )}
        </div>

        {project.healthChecks.length > 0 && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="glass-button flex items-center gap-1 text-xs py-1"
          >
            <span>{project.healthChecks.length} checks</span>
            {isExpanded ? (
              <ChevronUp className="w-3 h-3" />
            ) : (
              <ChevronDown className="w-3 h-3" />
            )}
          </button>
        )}
      </div>

      {isExpanded && healthStatus && (
        <div className="mt-4 pt-4 border-t border-card-border space-y-2">
          {healthStatus.checks.map((check) => (
            <HealthCheckBadge
              key={check.checkId}
              label={check.label}
              status={check.status}
              message={check.message}
              responseTime={check.responseTime}
            />
          ))}
        </div>
      )}
    </div>
  );
}
