'use client';

import { useState } from 'react';
import {
  Import,
  X,
  FileText,
  Check,
  AlertCircle,
  Loader2,
  Key,
  Terminal,
  Shield,
  Database,
  FileKey,
  Cloud,
  Globe,
  CreditCard,
} from 'lucide-react';
import { useVault } from './VaultProvider';
import {
  parseCredentialsMarkdown,
  convertToSecrets,
  getImportSummary,
  type ParsedCredential,
} from '@/lib/vault/import-credentials';

interface VaultImportProps {
  onClose: () => void;
}

// Category icons
const categoryIcons: Record<string, typeof Key> = {
  'API Keys': Key,
  'Public Access Tokens': FileKey,
  'Webhook': Cloud,
  'SSH Keys': Terminal,
  'OAuth': Shield,
  'Database': Database,
  'Cloud': Cloud,
  'Websites': Globe,
  'Payments': CreditCard,
};

export function VaultImport({ onClose }: VaultImportProps) {
  const { addSecretsBulk } = useVault();
  const [step, setStep] = useState<'input' | 'preview' | 'importing' | 'done'>('input');
  const [markdown, setMarkdown] = useState('');
  const [credentials, setCredentials] = useState<ParsedCredential[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [importProgress, setImportProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Parse credentials when markdown changes
  const handleParse = () => {
    if (!markdown.trim()) {
      setError('Please paste your credentials markdown');
      return;
    }

    try {
      const parsed = parseCredentialsMarkdown(markdown);
      if (parsed.length === 0) {
        setError('No credentials found in the provided text');
        return;
      }

      setCredentials(parsed);
      setSelectedIds(new Set(parsed.map((_, i) => i)));
      setError(null);
      setStep('preview');
    } catch {
      setError('Failed to parse credentials');
    }
  };

  const toggleSelection = (index: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === credentials.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(credentials.map((_, i) => i)));
    }
  };

  const handleImport = async () => {
    const toImport = credentials.filter((_, i) => selectedIds.has(i));
    if (toImport.length === 0) return;

    setStep('importing');
    const secrets = convertToSecrets(toImport);

    console.log('[Import] Starting bulk import of', secrets.length, 'credentials');
    console.log('[Import] Secrets to import:', secrets.map(s => s.name));

    setImportProgress(10);

    try {
      // Use bulk import to add all secrets in one atomic operation
      await addSecretsBulk(secrets);
      setImportProgress(100);
      console.log('[Import] ✓ Bulk import complete');
      setStep('done');
    } catch (err) {
      console.error('[Import] ✗ Bulk import failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to import secrets');
      setStep('preview');
    }
  };

  const summary = getImportSummary(credentials.filter((_, i) => selectedIds.has(i)));

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="glass-card p-6 w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-accent/10">
              <Import className="w-5 h-5 text-accent" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Import Credentials</h2>
              <p className="text-sm text-muted">
                {step === 'input' && 'Paste your credentials markdown'}
                {step === 'preview' && `${summary.total} credentials found`}
                {step === 'importing' && 'Importing...'}
                {step === 'done' && 'Import complete!'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-white/5"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step: Input */}
        {step === 'input' && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex items-center gap-2 mb-3 text-sm text-muted">
              <FileText className="w-4 h-4" />
              <span>Paste your credentials markdown file content below</span>
            </div>
            <textarea
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              placeholder="## API Keys&#10;&#10;Anthropic Claude API Key:&#10;sk-ant-api03-..."
              className="flex-1 min-h-[300px] w-full p-4 bg-black/40 border border-white/10 rounded-xl text-foreground font-mono text-sm placeholder:text-muted/50 focus:outline-none focus:border-accent/50 resize-none"
            />
            {error && (
              <div className="flex items-center gap-2 mt-3 p-3 bg-error/10 border border-error/20 rounded-lg text-sm text-error">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={onClose} className="glass-button secondary">
                Cancel
              </button>
              <button onClick={handleParse} className="glass-button primary flex items-center gap-2">
                <span>Parse Credentials</span>
              </button>
            </div>
          </div>
        )}

        {/* Step: Preview */}
        {step === 'preview' && (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Category Summary */}
            <div className="flex flex-wrap gap-2 mb-4">
              {Object.entries(summary.byCategory).map(([cat, count]) => {
                const Icon = categoryIcons[cat] || Key;
                return (
                  <div
                    key={cat}
                    className="flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-full text-sm"
                  >
                    <Icon className="w-3.5 h-3.5 text-accent" />
                    <span>{cat}</span>
                    <span className="text-muted">({count})</span>
                  </div>
                );
              })}
            </div>

            {/* Select All */}
            <div className="flex items-center justify-between mb-3 pb-3 border-b border-white/10">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedIds.size === credentials.length}
                  onChange={toggleAll}
                  className="w-4 h-4 rounded border-white/20 bg-black/40 text-accent focus:ring-accent/50"
                />
                <span className="text-sm font-medium">
                  Select All ({selectedIds.size}/{credentials.length})
                </span>
              </label>
            </div>

            {/* Credentials List */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-2">
              {credentials.map((cred, idx) => {
                const Icon = categoryIcons[cred.category] || Key;
                return (
                  <label
                    key={idx}
                    className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                      selectedIds.has(idx)
                        ? 'bg-accent/10 border border-accent/20'
                        : 'bg-white/5 border border-transparent hover:bg-white/10'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(idx)}
                      onChange={() => toggleSelection(idx)}
                      className="w-4 h-4 mt-0.5 rounded border-white/20 bg-black/40 text-accent focus:ring-accent/50"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Icon className="w-4 h-4 text-muted" />
                        <span className="font-medium truncate">{cred.name}</span>
                        <span className="text-xs text-muted bg-white/5 px-2 py-0.5 rounded">
                          {cred.category}
                        </span>
                      </div>
                      {cred.username && (
                        <p className="text-xs text-muted mt-1">User: {cred.username}</p>
                      )}
                      {cred.notes && (
                        <p className="text-xs text-muted mt-1 truncate">{cred.notes}</p>
                      )}
                      <p className="text-xs font-mono text-accent/60 mt-1 truncate">
                        {cred.value.substring(0, 40)}...
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="flex justify-between items-center gap-3 mt-4 pt-4 border-t border-white/10">
              <button
                onClick={() => setStep('input')}
                className="glass-button secondary"
              >
                Back
              </button>
              <button
                onClick={handleImport}
                disabled={selectedIds.size === 0}
                className="glass-button primary flex items-center gap-2"
              >
                <Import className="w-4 h-4" />
                <span>Import {selectedIds.size} Credential{selectedIds.size !== 1 ? 's' : ''}</span>
              </button>
            </div>
          </div>
        )}

        {/* Step: Importing */}
        {step === 'importing' && (
          <div className="flex-1 flex flex-col items-center justify-center py-12">
            <Loader2 className="w-12 h-12 text-accent animate-spin mb-4" />
            <p className="text-lg font-medium mb-2">Encrypting & Importing...</p>
            <p className="text-muted mb-4">{importProgress}% complete</p>
            <div className="w-64 h-2 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${importProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Step: Done */}
        {step === 'done' && (
          <div className="flex-1 flex flex-col items-center justify-center py-12">
            <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center mb-4">
              <Check className="w-8 h-8 text-success" />
            </div>
            <h3 className="text-xl font-bold mb-2">Import Complete!</h3>
            <p className="text-muted mb-6">
              Successfully imported {summary.total} credentials into your vault
            </p>
            <button onClick={onClose} className="glass-button primary">
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
