'use client';

import { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  Copy,
  Eye,
  EyeOff,
  Edit2,
  Trash2,
  Key,
  Check,
  ExternalLink,
  Lock,
  Settings,
  ChevronDown,
  ChevronRight,
  Shield,
  Database,
  Globe,
  Terminal,
  Cloud,
  CreditCard,
  FileKey,
  Import,
  FileJson,
} from 'lucide-react';
import { useVault } from './VaultProvider';
import { copyToClipboard } from '@/lib/vault/storage';
import { normalizeVaultCategory } from '@/lib/vault/categories';
import type { Secret } from '@/lib/vault/types';

interface VaultSecretsViewerProps {
  onAddSecret: () => void;
  onEditSecret: (secret: Secret) => void;
  onOpenSettings: () => void;
  onImport?: () => void;
}

// Category icons and colors
const categoryConfig: Record<string, { icon: typeof Key; color: string; bg: string }> = {
  'API Keys': { icon: Key, color: 'text-amber-400', bg: 'bg-amber-400/10' },
  'Public Access Tokens': { icon: FileKey, color: 'text-cyan-400', bg: 'bg-cyan-400/10' },
  'Webhook': { icon: Cloud, color: 'text-cyan-300', bg: 'bg-cyan-300/10' },
  'SSH Keys': { icon: Terminal, color: 'text-green-400', bg: 'bg-green-400/10' },
  'OAuth': { icon: Shield, color: 'text-blue-400', bg: 'bg-blue-400/10' },
  'Database': { icon: Database, color: 'text-purple-400', bg: 'bg-purple-400/10' },
  'Cloud': { icon: Cloud, color: 'text-sky-400', bg: 'bg-sky-400/10' },
  'Websites': { icon: Globe, color: 'text-pink-400', bg: 'bg-pink-400/10' },
  'Payments': { icon: CreditCard, color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
};

const defaultCategory = { icon: Key, color: 'text-accent', bg: 'bg-accent/10' };

export function VaultSecretsViewer({
  onAddSecret,
  onEditSecret,
  onOpenSettings,
  onImport,
}: VaultSecretsViewerProps) {
  const { secrets, lock, deleteSecret, isProcessing } = useVault();
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Group secrets by category
  const groupedSecrets = useMemo(() => {
    const groups: Record<string, Secret[]> = {};

    secrets.forEach(secret => {
      const category = normalizeVaultCategory(secret.category) || 'Uncategorized';
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(secret);
    });

    // Sort categories
    return Object.entries(groups).sort(([a], [b]) => {
      if (a === 'Uncategorized') return 1;
      if (b === 'Uncategorized') return -1;
      return a.localeCompare(b);
    });
  }, [secrets]);

  // Filter secrets by search
  const filteredGroups = useMemo(() => {
    if (!searchQuery) return groupedSecrets;

    const query = searchQuery.toLowerCase();
    return groupedSecrets
      .map(([category, secrets]) => {
        const filtered = secrets.filter(s =>
          s.name.toLowerCase().includes(query) ||
          normalizeVaultCategory(s.category).toLowerCase().includes(query) ||
          s.notes?.toLowerCase().includes(query) ||
          s.username?.toLowerCase().includes(query) ||
          s.score?.toLowerCase().includes(query) ||
          s.payloadUrl?.toLowerCase().includes(query)
        );
        return [category, filtered] as [string, Secret[]];
      })
      .filter(([, secrets]) => secrets.length > 0);
  }, [groupedSecrets, searchQuery]);

  // Stats
  const totalSecrets = secrets.length;
  const categoryCount = groupedSecrets.length;

  const toggleVisibility = (id: string) => {
    setVisibleSecrets(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleCategory = (category: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const handleCopy = async (secret: Secret) => {
    await copyToClipboard(secret.value, 30000);
    setCopiedId(secret.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDelete = async (id: string) => {
    if (deleteConfirm !== id) {
      setDeleteConfirm(id);
      setTimeout(() => setDeleteConfirm(null), 3000);
      return;
    }
    await deleteSecret(id);
    setDeleteConfirm(null);
  };

  const getCategoryConfig = (category: string) => {
    return categoryConfig[category] || defaultCategory;
  };

  const maskValue = (value: string) => {
    if (value.length <= 8) return '••••••••';
    return value.substring(0, 4) + '••••••••' + value.substring(value.length - 4);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-xl bg-accent/10 border border-accent/20">
            <Shield className="w-6 h-6 text-accent" />
          </div>
          <div>
            <h2 className="text-2xl font-bold">Secrets Vault</h2>
            <p className="text-sm text-muted">
              {totalSecrets} secret{totalSecrets !== 1 ? 's' : ''} in {categoryCount} categor{categoryCount !== 1 ? 'ies' : 'y'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenSettings}
            className="p-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all"
            title="Settings"
          >
            <Settings className="w-4 h-4 text-white/70" />
          </button>
          <button
            onClick={lock}
            className="p-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all"
            title="Lock Vault"
          >
            <Lock className="w-4 h-4 text-white/70" />
          </button>
          {onImport && (
            <button
              onClick={onImport}
              className="glass-button secondary flex items-center gap-2"
            >
              <Import className="w-4 h-4" />
              <span>Import</span>
            </button>
          )}
          <button
            onClick={onAddSecret}
            className="glass-button primary flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>Add Secret</span>
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted" />
        <input
          type="text"
          placeholder="Search secrets by name, category, or notes..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-12 pr-4 py-3 bg-black/40 border border-white/10 rounded-xl text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50 transition-colors"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
          >
            ×
          </button>
        )}
      </div>

      {/* Secrets List */}
      {filteredGroups.length === 0 ? (
        <div className="text-center py-16 glass-card">
          <Key className="w-16 h-16 mx-auto mb-4 text-muted opacity-50" />
          {secrets.length === 0 ? (
            <>
              <h3 className="text-lg font-medium mb-2">No secrets yet</h3>
              <p className="text-muted mb-6">
                Add your first API key or credential to get started
              </p>
              <div className="flex items-center justify-center gap-3">
                {onImport && (
                  <button
                    onClick={onImport}
                    className="glass-button secondary inline-flex items-center gap-2"
                  >
                    <Import className="w-4 h-4" />
                    <span>Import Secrets</span>
                  </button>
                )}
                <button
                  onClick={onAddSecret}
                  className="glass-button primary inline-flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add Secret</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-lg font-medium mb-2">No matches found</h3>
              <p className="text-muted">
                Try a different search term
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredGroups.map(([category, categorySecrets]) => {
            const config = getCategoryConfig(category);
            const Icon = config.icon;
            const isCollapsed = collapsedCategories.has(category);

            return (
              <div key={category} className="glass-card overflow-hidden">
                {/* Category Header */}
                <button
                  onClick={() => toggleCategory(category)}
                  className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${config.bg}`}>
                      <Icon className={`w-4 h-4 ${config.color}`} />
                    </div>
                    <span className="font-semibold">{category}</span>
                    <span className="text-xs text-muted bg-white/5 px-2 py-0.5 rounded-full">
                      {categorySecrets.length}
                    </span>
                  </div>
                  {isCollapsed ? (
                    <ChevronRight className="w-5 h-5 text-muted" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-muted" />
                  )}
                </button>

                {/* Secrets in Category */}
                {!isCollapsed && (
                  <div className="border-t border-white/5">
                    {categorySecrets.map((secret, idx) => (
                      <div
                        key={secret.id}
                        className={`p-4 hover:bg-white/5 transition-colors ${
                          idx !== categorySecrets.length - 1 ? 'border-b border-white/5' : ''
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            {/* Name and metadata */}
                            <div className="flex items-center gap-2 mb-2">
                              <h3 className="font-medium">{secret.name}</h3>
                              {/* JSON badge */}
                              {secret.type === 'json' && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-xs text-emerald-400">
                                  <FileJson className="w-3 h-3" />
                                  JSON
                                </span>
                              )}
                              {secret.url && (
                                <a
                                  href={secret.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-muted hover:text-accent transition-colors"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                              )}
                            </div>

                            {/* Username if present */}
                            {secret.username && (
                              <p className="text-sm text-muted mb-2">
                                <span className="text-white/40">User:</span> {secret.username}
                              </p>
                            )}

                            {secret.payloadUrl && (
                              <p className="text-sm text-muted mb-2 break-all">
                                <span className="text-white/40">Payload URL:</span> {secret.payloadUrl}
                              </p>
                            )}

                            {secret.score && (
                              <div className="mb-2 rounded-lg border border-white/5 bg-black/30 px-3 py-2">
                                <p className="text-xs uppercase tracking-wide text-white/40 mb-1">Score</p>
                                <p className="text-xs text-muted whitespace-pre-wrap break-words">
                                  {secret.score}
                                </p>
                              </div>
                            )}

                            {/* OAuth credentials if present */}
                            {(secret.clientId || secret.clientSecret) && (
                              <div className="mb-2 space-y-1.5 p-2.5 rounded-lg border border-blue-500/15 bg-blue-500/5">
                                {secret.clientId && (
                                  <div className="flex items-center gap-2 text-sm">
                                    <span className="text-blue-400/60 text-xs min-w-[70px]">Client ID</span>
                                    <code className="font-mono text-blue-300/80 text-xs truncate">
                                      {visibleSecrets.has(secret.id) ? secret.clientId : maskValue(secret.clientId)}
                                    </code>
                                  </div>
                                )}
                                {secret.clientSecret && (
                                  <div className="flex items-center gap-2 text-sm">
                                    <span className="text-blue-400/60 text-xs min-w-[70px]">Client Secret</span>
                                    <code className="font-mono text-blue-300/80 text-xs truncate">
                                      {visibleSecrets.has(secret.id) ? secret.clientSecret : maskValue(secret.clientSecret)}
                                    </code>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Secret Value */}
                            {secret.type === 'json' ? (
                              /* JSON preview */
                              <div className="font-mono text-sm bg-black/40 border border-emerald-500/10 rounded-lg px-3 py-2.5">
                                <div className="flex items-start gap-2">
                                  <code className="flex-1 text-emerald-400/80 whitespace-pre-wrap max-h-20 overflow-hidden">
                                    {visibleSecrets.has(secret.id)
                                      ? secret.value.substring(0, 200) + (secret.value.length > 200 ? '...' : '')
                                      : '{ "type": "...", ... }'}
                                  </code>
                                  <div className="flex items-center gap-1 border-l border-white/10 pl-2 ml-2 flex-shrink-0">
                                    <button
                                      onClick={() => toggleVisibility(secret.id)}
                                      className="p-1.5 text-muted hover:text-foreground transition-colors rounded hover:bg-white/5"
                                      title={visibleSecrets.has(secret.id) ? 'Hide' : 'Reveal'}
                                    >
                                      {visibleSecrets.has(secret.id) ? (
                                        <EyeOff className="w-4 h-4" />
                                      ) : (
                                        <Eye className="w-4 h-4" />
                                      )}
                                    </button>
                                    <button
                                      onClick={() => handleCopy(secret)}
                                      className="p-1.5 text-muted hover:text-foreground transition-colors rounded hover:bg-white/5"
                                      title="Copy JSON to clipboard"
                                    >
                                      {copiedId === secret.id ? (
                                        <Check className="w-4 h-4 text-success" />
                                      ) : (
                                        <Copy className="w-4 h-4" />
                                      )}
                                    </button>
                                  </div>
                                </div>
                                <p className="text-xs text-emerald-400/50 mt-1">
                                  Syncs to ~/.secrets.d/ as JSON file
                                </p>
                              </div>
                            ) : (
                              /* Regular text secret */
                              <div className="flex items-center gap-2 font-mono text-sm bg-black/40 border border-white/5 rounded-lg px-3 py-2.5">
                                <code className="flex-1 truncate text-accent/80">
                                  {visibleSecrets.has(secret.id)
                                    ? secret.value
                                    : maskValue(secret.value)}
                                </code>
                                <div className="flex items-center gap-1 border-l border-white/10 pl-2 ml-2">
                                  <button
                                    onClick={() => toggleVisibility(secret.id)}
                                    className="p-1.5 text-muted hover:text-foreground transition-colors rounded hover:bg-white/5"
                                    title={visibleSecrets.has(secret.id) ? 'Hide' : 'Reveal'}
                                  >
                                    {visibleSecrets.has(secret.id) ? (
                                      <EyeOff className="w-4 h-4" />
                                    ) : (
                                      <Eye className="w-4 h-4" />
                                    )}
                                  </button>
                                  <button
                                    onClick={() => handleCopy(secret)}
                                    className="p-1.5 text-muted hover:text-foreground transition-colors rounded hover:bg-white/5"
                                    title="Copy to clipboard (auto-clears in 30s)"
                                  >
                                    {copiedId === secret.id ? (
                                      <Check className="w-4 h-4 text-success" />
                                    ) : (
                                      <Copy className="w-4 h-4" />
                                    )}
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Notes */}
                            {secret.notes && (
                              <p className="text-xs text-muted mt-2 leading-relaxed">
                                {secret.notes}
                              </p>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => onEditSecret(secret)}
                              className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-white/5"
                              title="Edit"
                              disabled={isProcessing}
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDelete(secret.id)}
                              className={`p-2 transition-colors rounded-lg ${
                                deleteConfirm === secret.id
                                  ? 'text-error bg-error/10'
                                  : 'text-muted hover:text-error hover:bg-error/10'
                              }`}
                              title={deleteConfirm === secret.id ? 'Click again to confirm' : 'Delete'}
                              disabled={isProcessing}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Clipboard Toast */}
      {copiedId && (
        <div className="fixed bottom-6 right-6 glass-card px-4 py-3 flex items-center gap-3 text-sm shadow-lg border border-success/20 animate-in slide-in-from-bottom-2">
          <div className="p-1.5 rounded-full bg-success/10">
            <Check className="w-4 h-4 text-success" />
          </div>
          <span>Copied to clipboard! Auto-clears in 30s</span>
        </div>
      )}
    </div>
  );
}
