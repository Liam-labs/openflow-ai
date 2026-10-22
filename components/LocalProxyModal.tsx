'use client';

import { useState, useEffect, useCallback } from 'react';
import { Globe, X, Plus, Trash2, Copy, Check, AlertCircle, RefreshCw, Play, Square, ExternalLink } from 'lucide-react';

interface ProxyMapping {
  id: string;
  hostname: string;
  port: number;
  enabled: boolean;
  inHostsFile?: boolean;
}

interface LocalProxyModalProps {
  onClose: () => void;
}

export function LocalProxyModal({ onClose }: LocalProxyModalProps) {
  const [mappings, setMappings] = useState<ProxyMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [caddyRunning, setCaddyRunning] = useState(false);
  const [caddyInstalled, setCaddyInstalled] = useState(false);

  // Add form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newHostname, setNewHostname] = useState('');
  const [newPort, setNewPort] = useState('');
  const [adding, setAdding] = useState(false);

  // Hosts command state
  const [hostsCommand, setHostsCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Action states
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchMappings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/proxy');
      const data = await res.json();
      if (data.success) {
        setMappings(data.mappings || []);
        setCaddyRunning(data.caddyRunning);
        setCaddyInstalled(data.caddyInstalled);
      } else {
        setError(data.error || 'Failed to fetch proxy mappings');
      }
    } catch {
      setError('Failed to fetch proxy mappings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMappings();
  }, [fetchMappings]);

  // Clear success message after 3 seconds
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  const handleAddMapping = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate hostname
    let hostname = newHostname.trim().toLowerCase();
    if (!hostname.endsWith('.test')) {
      hostname = `${hostname}.test`;
    }

    if (!/^[a-zA-Z0-9-]+\.test$/.test(hostname)) {
      setError('Invalid hostname. Use letters, numbers, and hyphens only.');
      return;
    }

    const port = parseInt(newPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      setError('Invalid port. Must be between 1 and 65535.');
      return;
    }

    setAdding(true);
    setError(null);

    try {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          hostname,
          port,
        }),
      });

      const data = await res.json();

      if (data.success) {
        setSuccess(`Added: ${hostname} → localhost:${port}`);
        setNewHostname('');
        setNewPort('');
        setShowAddForm(false);

        if (data.hostsCommand) {
          setHostsCommand(data.hostsCommand);
        }

        fetchMappings();

        // Auto-reload Caddy if running
        if (caddyRunning) {
          await handleCaddyAction('reload');
        }
      } else {
        setError(data.error || 'Failed to add mapping');
      }
    } catch {
      setError('Failed to add mapping');
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteMapping = async (hostname: string) => {
    setActionLoading(`delete-${hostname}`);
    setError(null);

    try {
      const res = await fetch(`/api/proxy?hostname=${encodeURIComponent(hostname)}`, {
        method: 'DELETE',
      });

      const data = await res.json();

      if (data.success) {
        setSuccess(`Removed: ${hostname}`);
        fetchMappings();

        // Auto-reload Caddy if running
        if (caddyRunning) {
          await handleCaddyAction('reload');
        }
      } else {
        setError(data.error || 'Failed to delete mapping');
      }
    } catch {
      setError('Failed to delete mapping');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCaddyAction = async (action: 'start' | 'stop' | 'reload') => {
    setActionLoading(action);
    setError(null);

    try {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      const data = await res.json();

      if (data.success) {
        setSuccess(data.message);
        // Refresh status after a short delay
        setTimeout(fetchMappings, 1000);
      } else {
        setError(data.error || `Failed to ${action} Caddy`);
      }
    } catch {
      setError(`Failed to ${action} Caddy`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCopyCommand = async () => {
    if (hostsCommand) {
      await navigator.clipboard.writeText(hostsCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="glass-card p-6 w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/20">
              <Globe className="w-6 h-6 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Local Proxy</h2>
              <p className="text-sm text-muted">Map ports to .test domains via Caddy</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-card-hover"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Caddy Status Bar */}
        <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/10 mb-4">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${caddyRunning ? 'bg-green-400' : 'bg-red-400'}`} />
            <span className="text-sm">
              Caddy: <span className={caddyRunning ? 'text-green-400' : 'text-red-400'}>
                {caddyRunning ? 'Running' : 'Stopped'}
              </span>
            </span>
            {!caddyInstalled && (
              <span className="text-xs text-amber-400">(Caddyfile not found)</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {caddyRunning ? (
              <>
                <button
                  onClick={() => handleCaddyAction('reload')}
                  disabled={actionLoading === 'reload'}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 rounded-lg transition-all disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${actionLoading === 'reload' ? 'animate-spin' : ''}`} />
                  Reload
                </button>
                <button
                  onClick={() => handleCaddyAction('stop')}
                  disabled={actionLoading === 'stop'}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-all disabled:opacity-50"
                >
                  <Square className="w-3.5 h-3.5" />
                  Stop
                </button>
              </>
            ) : (
              <button
                onClick={() => handleCaddyAction('start')}
                disabled={actionLoading === 'start' || !caddyInstalled}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-green-500/20 text-green-400 hover:bg-green-500/30 rounded-lg transition-all disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" />
                Start
              </button>
            )}
          </div>
        </div>

        {/* Messages */}
        {error && (
          <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg mb-4">
            <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        {success && (
          <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-lg mb-4">
            <Check className="w-4 h-4 text-green-400 flex-shrink-0" />
            <p className="text-sm text-green-400">{success}</p>
          </div>
        )}

        {/* Hosts Command Banner */}
        {hostsCommand && (
          <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg mb-4">
            <div className="flex items-start gap-2 mb-2">
              <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-amber-200 font-medium">Hosts file entry needed (requires Admin):</p>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <code className="flex-1 text-xs bg-black/30 px-3 py-2 rounded font-mono text-amber-100 overflow-x-auto">
                {hostsCommand}
              </code>
              <button
                onClick={handleCopyCommand}
                className={`p-2 rounded transition-colors ${copied ? 'text-green-400' : 'text-amber-400 hover:text-amber-300'}`}
                title="Copy command"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-amber-200/70 mt-2">
              Run this command in PowerShell as Administrator, or use: <code className="bg-black/30 px-1 rounded">C:\Caddy\add-host.ps1</code>
            </p>
            <button
              onClick={() => setHostsCommand(null)}
              className="text-xs text-amber-400/70 hover:text-amber-400 mt-2"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Mappings List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-400"></div>
            </div>
          ) : mappings.length === 0 ? (
            <div className="text-center py-12">
              <Globe className="w-12 h-12 text-muted mx-auto mb-4" />
              <h3 className="font-medium mb-2">No Proxy Mappings</h3>
              <p className="text-sm text-muted mb-4">
                Add a mapping to access localhost ports via .test domains
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {mappings.map((mapping) => (
                <div
                  key={mapping.id}
                  className="flex items-center justify-between p-4 glass-card hover:border-white/20 transition-all"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <a
                        href={`http://${mapping.hostname}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-cyan-400 hover:text-cyan-300 hover:underline flex items-center gap-1"
                      >
                        {mapping.hostname}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                    <span className="text-muted">→</span>
                    <span className="font-mono text-white/80">localhost:{mapping.port}</span>
                  </div>

                  <div className="flex items-center gap-3">
                    {!mapping.inHostsFile && (
                      <span className="text-xs px-2 py-1 bg-amber-500/20 text-amber-400 rounded border border-amber-500/30">
                        Missing hosts entry
                      </span>
                    )}
                    <button
                      onClick={() => handleDeleteMapping(mapping.hostname)}
                      disabled={actionLoading === `delete-${mapping.hostname}`}
                      className="p-2 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-all"
                      title="Remove mapping"
                    >
                      {actionLoading === `delete-${mapping.hostname}` ? (
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-400"></div>
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add Form */}
        {showAddForm ? (
          <form onSubmit={handleAddMapping} className="pt-4 border-t border-white/10 mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">Hostname</label>
                <div className="relative">
                  <input
                    type="text"
                    value={newHostname}
                    onChange={(e) => setNewHostname(e.target.value)}
                    placeholder="myapp"
                    className="glass-input pr-16"
                    autoFocus
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted text-sm">.test</span>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Port</label>
                <input
                  type="number"
                  value={newPort}
                  onChange={(e) => setNewPort(e.target.value)}
                  placeholder="3000"
                  min="1"
                  max="65535"
                  className="glass-input"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowAddForm(false);
                  setNewHostname('');
                  setNewPort('');
                }}
                className="glass-button secondary flex-1"
                disabled={adding}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="glass-button primary flex-1 flex items-center justify-center gap-2"
                disabled={adding || !newHostname.trim() || !newPort}
              >
                <Plus className="w-4 h-4" />
                <span>{adding ? 'Adding...' : 'Add Mapping'}</span>
              </button>
            </div>
          </form>
        ) : (
          <div className="pt-4 border-t border-white/10 mt-4">
            <button
              onClick={() => setShowAddForm(true)}
              className="glass-button primary w-full flex items-center justify-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>Add Proxy Mapping</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
