'use client';

import { useState } from 'react';
import { FolderPlus, X, Save, AlertCircle, Globe, Wrench, Server, ArrowLeft } from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/brand';

interface AddProjectModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

type ProjectType = 'site' | 'tool' | 'server' | null;

export function AddProjectModal({ onClose, onSuccess }: AddProjectModalProps) {
  const [selectedType, setSelectedType] = useState<ProjectType>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState('');
  const [localUrl, setLocalUrl] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  // Server-specific fields
  const [port, setPort] = useState('');
  const [pm2Name, setPm2Name] = useState('');
  const [startCommand, setStartCommand] = useState('');
  const [stopCommand, setStopCommand] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!path.trim()) {
      setError('Path is required');
      return;
    }
    if (selectedType === 'server' && !port) {
      setError('Port is required for servers');
      return;
    }

    setIsSubmitting(true);

    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim(),
        path: path.trim(),
        category: selectedType,
        tags: [],
        links: {
          local: localUrl.trim() || undefined,
          repo: repoUrl.trim() || undefined,
        },
      };

      // Add health checks based on type
      if (selectedType === 'site' && localUrl.trim()) {
        payload.healthCheck = {
          type: 'http',
          url: localUrl.trim(),
          label: 'Live Site',
        };
      } else if (selectedType === 'server' && port) {
        payload.healthCheck = {
          type: 'port',
          port: port,
          label: 'Server Port',
        };
        payload.server = {
          port: parseInt(port, 10),
          startCommand: startCommand.trim() || undefined,
          stopCommand: stopCommand.trim() || undefined,
          pm2Name: pm2Name.trim() || undefined,
          autoStart: false,
        };
        // Set local URL to localhost:port if not specified
        if (!localUrl.trim()) {
          payload.links = {
            ...(payload.links as object),
            local: `http://localhost:${port}`,
          };
        }
      }

      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create project');
      }

      onSuccess();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create project';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBack = () => {
    setSelectedType(null);
    setError(null);
  };

  // Type selector screen
  if (!selectedType) {
    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
        <div className="glass-card p-6 w-full max-w-md">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <FolderPlus className="w-6 h-6 text-accent" />
              <h2 className="text-xl font-bold">Add to {PRODUCT_NAME}</h2>
            </div>
            <button
              onClick={onClose}
              className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-card-hover"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <p className="text-muted text-sm mb-4">What would you like to add?</p>

          <div className="space-y-3">
            <button
              onClick={() => setSelectedType('site')}
              className="w-full glass-card p-4 flex items-center gap-4 hover:border-accent/50 transition-all group"
            >
              <div className="p-3 rounded-lg bg-accent/20 text-accent group-hover:bg-accent/30">
                <Globe className="w-6 h-6" />
              </div>
              <div className="text-left">
                <h3 className="font-semibold">Site</h3>
                <p className="text-sm text-muted">Website or web application with health monitoring</p>
              </div>
            </button>

            <button
              onClick={() => setSelectedType('tool')}
              className="w-full glass-card p-4 flex items-center gap-4 hover:border-accent/50 transition-all group"
            >
              <div className="p-3 rounded-lg bg-accent/20 text-accent group-hover:bg-accent/30">
                <Wrench className="w-6 h-6" />
              </div>
              <div className="text-left">
                <h3 className="font-semibold">Tool</h3>
                <p className="text-sm text-muted">Local development tool or utility</p>
              </div>
            </button>

            <button
              onClick={() => setSelectedType('server')}
              className="w-full glass-card p-4 flex items-center gap-4 hover:border-accent/50 transition-all group"
            >
              <div className="p-3 rounded-lg bg-accent/20 text-accent group-hover:bg-accent/30">
                <Server className="w-6 h-6" />
              </div>
              <div className="text-left">
                <h3 className="font-semibold">Server</h3>
                <p className="text-sm text-muted">PM2-managed server or service</p>
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Form screen based on selected type
  const typeLabels = {
    site: 'Site',
    tool: 'Tool',
    server: 'Server',
  };

  const TypeIcon = {
    site: Globe,
    tool: Wrench,
    server: Server,
  }[selectedType];

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="glass-card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button
              onClick={handleBack}
              className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-card-hover"
              aria-label="Go back"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <TypeIcon className="w-6 h-6 text-accent" />
            <h2 className="text-xl font-bold">Add {typeLabels[selectedType]}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-card-hover"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Common fields */}
          <div className="space-y-2">
            <label htmlFor="name" className="block text-sm font-medium">
              Name <span className="text-error">*</span>
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`e.g., My ${typeLabels[selectedType]}`}
              className="glass-input"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="description" className="block text-sm font-medium">
              Description
            </label>
            <input
              id="description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description"
              className="glass-input"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="path" className="block text-sm font-medium">
              Local Path <span className="text-error">*</span>
            </label>
            <input
              id="path"
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/user/project"
              className="glass-input font-mono text-sm"
            />
          </div>

          {/* Site-specific fields */}
          {selectedType === 'site' && (
            <>
              <div className="space-y-2">
                <label htmlFor="localUrl" className="block text-sm font-medium">
                  Live URL
                </label>
                <input
                  id="localUrl"
                  type="url"
                  value={localUrl}
                  onChange={(e) => setLocalUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="glass-input"
                />
                <p className="text-xs text-muted">Used for health monitoring</p>
              </div>

              <div className="space-y-2">
                <label htmlFor="repoUrl" className="block text-sm font-medium">
                  Repository URL
                </label>
                <input
                  id="repoUrl"
                  type="url"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/..."
                  className="glass-input"
                />
              </div>
            </>
          )}

          {/* Tool-specific fields */}
          {selectedType === 'tool' && (
            <>
              <div className="space-y-2">
                <label htmlFor="localUrl" className="block text-sm font-medium">
                  Local URL
                </label>
                <input
                  id="localUrl"
                  type="url"
                  value={localUrl}
                  onChange={(e) => setLocalUrl(e.target.value)}
                  placeholder="http://localhost:3000"
                  className="glass-input"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="repoUrl" className="block text-sm font-medium">
                  Repository URL
                </label>
                <input
                  id="repoUrl"
                  type="url"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/..."
                  className="glass-input"
                />
              </div>
            </>
          )}

          {/* Server-specific fields */}
          {selectedType === 'server' && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label htmlFor="port" className="block text-sm font-medium">
                    Port <span className="text-error">*</span>
                  </label>
                  <input
                    id="port"
                    type="number"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="3000"
                    className="glass-input"
                  />
                </div>

                <div className="space-y-2">
                  <label htmlFor="pm2Name" className="block text-sm font-medium">
                    PM2 Name
                  </label>
                  <input
                    id="pm2Name"
                    type="text"
                    value={pm2Name}
                    onChange={(e) => setPm2Name(e.target.value)}
                    placeholder="my-server"
                    className="glass-input"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="startCommand" className="block text-sm font-medium">
                  Start Command
                </label>
                <input
                  id="startCommand"
                  type="text"
                  value={startCommand}
                  onChange={(e) => setStartCommand(e.target.value)}
                  placeholder="pm2 start npm --name my-server -- run dev"
                  className="glass-input font-mono text-sm"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="stopCommand" className="block text-sm font-medium">
                  Stop Command
                </label>
                <input
                  id="stopCommand"
                  type="text"
                  value={stopCommand}
                  onChange={(e) => setStopCommand(e.target.value)}
                  placeholder="pm2 stop my-server"
                  className="glass-input font-mono text-sm"
                />
              </div>
            </>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
              <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
              <p className="text-sm text-error">{error}</p>
            </div>
          )}

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="glass-button secondary flex-1"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="glass-button primary flex-1 flex items-center justify-center gap-2"
              disabled={isSubmitting || !name.trim() || !path.trim() || (selectedType === 'server' && !port)}
            >
              <Save className="w-4 h-4" />
              <span>{isSubmitting ? 'Adding...' : `Add ${typeLabels[selectedType]}`}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
