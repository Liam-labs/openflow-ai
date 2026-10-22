'use client';

import { useState, useEffect, useCallback } from 'react';
import { Key, X, Plus, Trash2, Copy, Check, AlertCircle, Shield, Eye, EyeOff, Clock } from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/brand';

interface ApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scope: 'read' | 'write' | 'admin';
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  usageCount: number;
  metadata?: {
    description?: string;
  };
}

interface ApiTokensModalProps {
  onClose: () => void;
}

type ViewMode = 'list' | 'generate' | 'show-token';

export function ApiTokensModal({ onClose }: ApiTokensModalProps) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  // Generate form state
  const [newTokenName, setNewTokenName] = useState('');
  const [newTokenScope, setNewTokenScope] = useState<'read' | 'write' | 'admin'>('write');
  const [newTokenDescription, setNewTokenDescription] = useState('');
  const [generating, setGenerating] = useState(false);

  // Generated token display
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showToken, setShowToken] = useState(false);

  // Revoke state
  const [revoking, setRevoking] = useState<string | null>(null);

  const fetchTokens = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/tokens');
      const data = await res.json();
      if (data.success) {
        setTokens(data.tokens || []);
      } else {
        setError(data.error || 'Failed to fetch tokens');
      }
    } catch {
      setError('Failed to fetch tokens');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  const handleGenerateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTokenName.trim()) {
      setError('Token name is required');
      return;
    }

    setGenerating(true);
    setError(null);

    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newTokenName.trim(),
          scope: newTokenScope,
          description: newTokenDescription.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (data.success && data.token) {
        setGeneratedToken(data.token);
        setViewMode('show-token');
        // Reset form
        setNewTokenName('');
        setNewTokenDescription('');
        setNewTokenScope('write');
        // Refresh token list
        fetchTokens();
      } else {
        setError(data.error || 'Failed to generate token');
      }
    } catch {
      setError('Failed to generate token');
    } finally {
      setGenerating(false);
    }
  };

  const handleRevokeToken = async (tokenId: string) => {
    setRevoking(tokenId);
    setError(null);

    try {
      const res = await fetch(`/api/tokens/${tokenId}`, {
        method: 'DELETE',
      });

      const data = await res.json();

      if (data.success) {
        fetchTokens();
      } else {
        setError(data.error || 'Failed to revoke token');
      }
    } catch {
      setError('Failed to revoke token');
    } finally {
      setRevoking(null);
    }
  };

  const handleCopyToken = async () => {
    if (generatedToken) {
      await navigator.clipboard.writeText(generatedToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getScopeColor = (scope: string) => {
    switch (scope) {
      case 'admin': return 'text-red-400 bg-red-500/20 border-red-500/30';
      case 'write': return 'text-amber-400 bg-amber-500/20 border-amber-500/30';
      case 'read': return 'text-green-400 bg-green-500/20 border-green-500/30';
      default: return 'text-white/60 bg-white/10 border-white/20';
    }
  };

  // Show generated token screen
  if (viewMode === 'show-token' && generatedToken) {
    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
        <div className="glass-card p-6 w-full max-w-lg">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/20">
                <Check className="w-6 h-6 text-green-400" />
              </div>
              <h2 className="text-xl font-bold">Token Generated</h2>
            </div>
            <button
              onClick={() => {
                setViewMode('list');
                setGeneratedToken(null);
                setShowToken(false);
              }}
              className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-card-hover"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="mb-6">
            <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg mb-4">
              <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <p className="text-sm text-amber-200">
                Copy this token now. It won&apos;t be shown again!
              </p>
            </div>

            <label className="block text-sm font-medium mb-2">Your API Token</label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={generatedToken}
                readOnly
                className="glass-input font-mono text-sm pr-24"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <button
                  onClick={() => setShowToken(!showToken)}
                  className="p-1.5 text-muted hover:text-foreground transition-colors"
                  title={showToken ? 'Hide token' : 'Show token'}
                >
                  {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <button
                  onClick={handleCopyToken}
                  className={`p-1.5 transition-colors ${copied ? 'text-green-400' : 'text-muted hover:text-foreground'}`}
                  title="Copy to clipboard"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>

          <div className="p-4 bg-white/5 rounded-lg mb-6">
            <h3 className="text-sm font-medium mb-2">Quick Start</h3>
            <pre className="text-xs text-muted font-mono overflow-x-auto whitespace-pre-wrap">
{`curl -X POST http://localhost:3000/api/agent \\
  -H "Authorization: Bearer ${showToken ? generatedToken : 'dvf_live_xxx...'}" \\
  -H "Content-Type: application/json" \\
  -d '{"action": "projects.list"}'`}
            </pre>
          </div>

          <button
            onClick={() => {
              setViewMode('list');
              setGeneratedToken(null);
              setShowToken(false);
            }}
            className="glass-button primary w-full"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  // Generate token form
  if (viewMode === 'generate') {
    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
        <div className="glass-card p-6 w-full max-w-lg">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-accent/20">
                <Plus className="w-6 h-6 text-accent" />
              </div>
              <h2 className="text-xl font-bold">Generate API Token</h2>
            </div>
            <button
              onClick={() => setViewMode('list')}
              className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-card-hover"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <form onSubmit={handleGenerateToken} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="tokenName" className="block text-sm font-medium">
                Token Name <span className="text-error">*</span>
              </label>
              <input
                id="tokenName"
                type="text"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="e.g., CI/CD Pipeline"
                className="glass-input"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="tokenScope" className="block text-sm font-medium">
                Permission Scope
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['read', 'write', 'admin'] as const).map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => setNewTokenScope(scope)}
                    className={`
                      p-3 rounded-lg border transition-all text-sm font-medium capitalize
                      ${newTokenScope === scope
                        ? getScopeColor(scope)
                        : 'bg-white/5 border-white/10 text-muted hover:bg-white/10'
                      }
                    `}
                  >
                    {scope}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted mt-1">
                {newTokenScope === 'read' && 'Query-only access to all resources'}
                {newTokenScope === 'write' && 'Create, update, delete most resources'}
                {newTokenScope === 'admin' && 'Full access including token management'}
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="tokenDescription" className="block text-sm font-medium">
                Description <span className="text-muted">(optional)</span>
              </label>
              <input
                id="tokenDescription"
                type="text"
                value={newTokenDescription}
                onChange={(e) => setNewTokenDescription(e.target.value)}
                placeholder="What will this token be used for?"
                className="glass-input"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
                <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
                <p className="text-sm text-error">{error}</p>
              </div>
            )}

            <div className="flex gap-3 pt-4">
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className="glass-button secondary flex-1"
                disabled={generating}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="glass-button primary flex-1 flex items-center justify-center gap-2"
                disabled={generating || !newTokenName.trim()}
              >
                <Key className="w-4 h-4" />
                <span>{generating ? 'Generating...' : 'Generate Token'}</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // Token list view (default)
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="glass-card p-6 w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-accent/20">
              <Key className="w-6 h-6 text-accent" />
            </div>
            <div>
              <h2 className="text-xl font-bold">API Tokens</h2>
              <p className="text-sm text-muted">Manage programmatic access to {PRODUCT_NAME}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-card-hover"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg mb-4">
            <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
            </div>
          ) : tokens.length === 0 ? (
            <div className="text-center py-12">
              <Shield className="w-12 h-12 text-muted mx-auto mb-4" />
              <h3 className="font-medium mb-2">No API Tokens</h3>
              <p className="text-sm text-muted mb-4">
                Generate a token to access {PRODUCT_NAME} programmatically
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {tokens.map((token) => (
                <div
                  key={token.id}
                  className="glass-card p-4 hover:border-white/20 transition-all"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-medium truncate">{token.name}</h3>
                        <span className={`
                          text-xs px-2 py-0.5 rounded-full border capitalize
                          ${getScopeColor(token.scope)}
                        `}>
                          {token.scope}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 text-xs text-muted">
                        <span className="font-mono">{token.tokenPrefix}_***</span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Created {formatDate(token.createdAt)}
                        </span>
                      </div>

                      {token.metadata?.description && (
                        <p className="text-sm text-muted mt-2">{token.metadata.description}</p>
                      )}

                      <div className="flex items-center gap-4 mt-2 text-xs">
                        <span className="text-muted">
                          Used {token.usageCount} time{token.usageCount !== 1 ? 's' : ''}
                        </span>
                        {token.lastUsedAt && (
                          <span className="text-muted">
                            Last used {formatDate(token.lastUsedAt)}
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => handleRevokeToken(token.id)}
                      disabled={revoking === token.id}
                      className="p-2 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-all"
                      title="Revoke token"
                    >
                      {revoking === token.id ? (
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

        <div className="pt-4 border-t border-white/10 mt-4">
          <button
            onClick={() => {
              setError(null);
              setViewMode('generate');
            }}
            className="glass-button primary w-full flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>Generate New Token</span>
          </button>
        </div>
      </div>
    </div>
  );
}
