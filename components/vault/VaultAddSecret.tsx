'use client';

import { useState, useMemo } from 'react';
import { Key, Eye, EyeOff, RefreshCw, X, Save, AlertCircle, FileJson, FileText, CheckCircle, Shield } from 'lucide-react';
import { useVault } from './VaultProvider';
import { generatePassword } from '@/lib/vault/storage';
import { normalizeVaultCategory, isWebhookCategory, VAULT_CATEGORY_OPTIONS } from '@/lib/vault/categories';
import type { Secret, SecretType } from '@/lib/vault/types';

interface VaultAddSecretProps {
  editingSecret?: Secret | null;
  onClose: () => void;
}

/**
 * Convert secret name to a safe filename for JSON files (preview)
 */
function toJsonFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    + '.json';
}

/**
 * Convert secret name to env var name (preview)
 */
function toEnvVarName(name: string, isJson: boolean): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return isJson ? base.replace(/_JSON$/, '') + '_JSON' : base;
}

export function VaultAddSecret({ editingSecret, onClose }: VaultAddSecretProps) {
  const { addSecret, updateSecret, isProcessing, error, clearError } = useVault();

  const [name, setName] = useState(editingSecret?.name || '');
  const [value, setValue] = useState(editingSecret?.value || '');
  const [type, setType] = useState<SecretType>(editingSecret?.type || 'text');
  const [category, setCategory] = useState(normalizeVaultCategory(editingSecret?.category));
  const [url, setUrl] = useState(editingSecret?.url || '');
  const [payloadUrl, setPayloadUrl] = useState(editingSecret?.payloadUrl || '');
  const [score, setScore] = useState(editingSecret?.score || '');
  const [username, setUsername] = useState(editingSecret?.username || '');
  const [notes, setNotes] = useState(editingSecret?.notes || '');
  const [clientId, setClientId] = useState(editingSecret?.clientId || '');
  const [clientSecret, setClientSecret] = useState(editingSecret?.clientSecret || '');
  const [showValue, setShowValue] = useState(false);
  const [showClientSecret, setShowClientSecret] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const isEditing = !!editingSecret;
  const isJson = type === 'json';
  const normalizedCategory = normalizeVaultCategory(category);
  const isOAuth = normalizedCategory.toLowerCase() === 'oauth';
  const isWebhook = isWebhookCategory(category);

  // Validate JSON in real-time
  const jsonValidation = useMemo(() => {
    if (!isJson || !value.trim()) return { valid: true, error: null };
    try {
      JSON.parse(value);
      return { valid: true, error: null };
    } catch (e) {
      return { valid: false, error: (e as Error).message };
    }
  }, [isJson, value]);

  // Preview paths for JSON secrets
  const previewPaths = useMemo(() => {
    if (!name.trim()) return null;
    return {
      envVar: toEnvVarName(name, isJson),
      filename: isJson ? toJsonFilename(name) : null,
    };
  }, [name, isJson]);

  const handleGeneratePassword = () => {
    const newPassword = generatePassword({
      length: 24,
      includeLowercase: true,
      includeUppercase: true,
      includeNumbers: true,
      includeSymbols: true,
    });
    setValue(newPassword);
    setShowValue(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      setLocalError('Name is required');
      return;
    }

    if (!value.trim()) {
      setLocalError('Value is required');
      return;
    }

    // Validate JSON if type is json
    if (isJson && !jsonValidation.valid) {
      setLocalError('Invalid JSON: ' + jsonValidation.error);
      return;
    }

    setLocalError(null);
    clearError();

    try {
      const secretData = {
        name: name.trim(),
        value: value.trim(),
        type,
        category: normalizedCategory || undefined,
        url: url.trim() || undefined,
        payloadUrl: isWebhook ? payloadUrl.trim() || undefined : undefined,
        score: score.trim() || undefined,
        username: username.trim() || undefined,
        notes: notes.trim() || undefined,
        clientId: isOAuth && clientId.trim() ? clientId.trim() : undefined,
        clientSecret: isOAuth && clientSecret.trim() ? clientSecret.trim() : undefined,
      };

      if (isEditing) {
        await updateSecret(editingSecret.id, secretData);
      } else {
        await addSecret(secretData);
      }
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save secret';
      setLocalError(message);
    }
  };

  const displayError = localError || error;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="glass-card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Key className="w-6 h-6 text-accent" />
            <h2 className="text-xl font-bold">
              {isEditing ? 'Edit Secret' : 'Add New Secret'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-card-hover"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Secret Type Selector */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">Secret Type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setType('text')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-all ${
                  type === 'text'
                    ? 'bg-accent/20 border-accent text-accent'
                    : 'bg-card border-border text-muted hover:text-foreground hover:border-border-hover'
                }`}
              >
                <FileText className="w-4 h-4" />
                <span>Text</span>
              </button>
              <button
                type="button"
                onClick={() => setType('json')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-all ${
                  type === 'json'
                    ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                    : 'bg-card border-border text-muted hover:text-foreground hover:border-border-hover'
                }`}
              >
                <FileJson className="w-4 h-4" />
                <span>JSON Key</span>
              </button>
            </div>
            {isJson && (
              <p className="text-xs text-muted">
                JSON keys are saved to <code className="text-emerald-400">~/.secrets.d/</code> as files
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="name" className="block text-sm font-medium">
              Name <span className="text-error">*</span>
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isJson ? "e.g., Google Analytics Service Account" : "e.g., GitHub API Key"}
              className="glass-input"
              autoFocus
            />
            {/* Preview of generated paths */}
            {previewPaths && (
              <div className="text-xs space-y-1 mt-1">
                <div className="text-muted">
                  Env var: <code className="text-accent">${previewPaths.envVar}</code>
                </div>
                {previewPaths.filename && (
                  <div className="text-muted">
                    File: <code className="text-emerald-400">~/.secrets.d/{previewPaths.filename}</code>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="value" className="block text-sm font-medium">
              {isJson ? 'JSON Content' : isOAuth ? 'OAuth Key / Token' : 'Secret Value'} <span className="text-error">*</span>
            </label>
            {isJson ? (
              /* JSON textarea with validation indicator */
              <div className="relative">
                <textarea
                  id="value"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder='{\n  "type": "service_account",\n  "project_id": "...",\n  ...\n}'
                  className={`glass-input font-mono text-sm min-h-[200px] resize-y ${
                    value.trim() && !jsonValidation.valid ? 'border-error' : ''
                  }`}
                  rows={10}
                />
                {value.trim() && (
                  <div className="absolute top-2 right-2">
                    {jsonValidation.valid ? (
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-error" />
                    )}
                  </div>
                )}
                {value.trim() && !jsonValidation.valid && (
                  <p className="text-xs text-error mt-1">{jsonValidation.error}</p>
                )}
              </div>
            ) : (
              /* Text input with show/hide and generate buttons */
              <div className="relative">
                <input
                  id="value"
                  type={showValue ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Enter the secret value"
                  className="glass-input pr-20 font-mono"
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setShowValue(!showValue)}
                    className="p-1.5 text-muted hover:text-foreground transition-colors"
                    title={showValue ? 'Hide' : 'Show'}
                  >
                    {showValue ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleGeneratePassword}
                    className="p-1.5 text-muted hover:text-accent transition-colors"
                    title="Generate random value"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor="category" className="block text-sm font-medium">
                Category
              </label>
              <input
                id="category"
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g., Public Access Tokens"
                className="glass-input"
                list="categories"
              />
              <datalist id="categories">
                {VAULT_CATEGORY_OPTIONS.map(option => (
                  <option key={option} value={option} />
                ))}
              </datalist>
              <p className="text-xs text-muted">
                Legacy `Tokens` entries are normalized to <code className="text-accent">Public Access Tokens</code>.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="username" className="block text-sm font-medium">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Optional"
                className="glass-input"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="url" className="block text-sm font-medium">
              {isOAuth ? 'Authorization URL' : 'URL'}
            </label>
            <input
              id="url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={isOAuth ? "https://accounts.google.com/o/oauth2/auth" : "https://..."}
              className="glass-input"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="score" className="block text-sm font-medium">
              Score
            </label>
            <textarea
              id="score"
              value={score}
              onChange={(e) => setScore(e.target.value)}
              placeholder="Paste scopes, permissions, or any plain-text notes about access"
              className="glass-input min-h-[90px] resize-y font-mono text-sm"
              rows={4}
            />
            <p className="text-xs text-muted">
              Use this for freeform scope / permission text. It is stored as metadata and synced into the `~/.secrets` comment.
            </p>
          </div>

          {isWebhook && (
            <div className="space-y-2 p-4 rounded-lg border border-cyan-500/20 bg-cyan-500/5">
              <label htmlFor="payloadUrl" className="block text-sm font-medium">
                Payload URL
              </label>
              <input
                id="payloadUrl"
                type="url"
                value={payloadUrl}
                onChange={(e) => setPayloadUrl(e.target.value)}
                placeholder="https://example.com/webhook"
                className="glass-input"
              />
              <p className="text-xs text-muted">
                Webhook entries keep the destination URL here for quick recall and sync notes.
              </p>
            </div>
          )}

          {/* OAuth-specific fields */}
          {isOAuth && (
            <div className="space-y-4 p-4 rounded-lg border border-blue-500/20 bg-blue-500/5">
              <div className="flex items-center gap-2 text-sm font-medium text-blue-400">
                <Shield className="w-4 h-4" />
                <span>OAuth Credentials</span>
              </div>

              <div className="space-y-2">
                <label htmlFor="clientId" className="block text-sm font-medium">
                  Client ID
                </label>
                <input
                  id="clientId"
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="e.g., 123456789-abc.apps.googleusercontent.com"
                  className="glass-input font-mono text-sm"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="clientSecret" className="block text-sm font-medium">
                  Client Secret
                </label>
                <div className="relative">
                  <input
                    id="clientSecret"
                    type={showClientSecret ? 'text' : 'password'}
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="e.g., GOCSPX-..."
                    className="glass-input pr-10 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowClientSecret(!showClientSecret)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted hover:text-foreground transition-colors"
                    title={showClientSecret ? 'Hide' : 'Show'}
                  >
                    {showClientSecret ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="notes" className="block text-sm font-medium">
              Notes
            </label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional notes..."
              className="glass-input min-h-[80px] resize-y"
              rows={3}
            />
          </div>

          {displayError && (
            <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
              <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
              <p className="text-sm text-error">{displayError}</p>
            </div>
          )}

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="glass-button secondary flex-1"
              disabled={isProcessing}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="glass-button primary flex-1 flex items-center justify-center gap-2"
              disabled={isProcessing || !name.trim() || !value.trim()}
            >
              <Save className="w-4 h-4" />
              <span>{isEditing ? 'Save Changes' : 'Add Secret'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
