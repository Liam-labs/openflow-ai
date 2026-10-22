'use client';

import { useState } from 'react';
import { Lock, Eye, EyeOff, Loader2, AlertCircle } from 'lucide-react';
import { useVault } from './VaultProvider';

export function PasswordUnlock() {
  const { unlockWithPassword, isProcessing, error, clearError } = useVault();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!password.trim()) {
      setLocalError('Please enter your password');
      return;
    }

    setLocalError(null);
    clearError();

    try {
      await unlockWithPassword(password);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to unlock';
      setLocalError(message);
    }
  };

  const displayError = localError || error;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="text-center">
        <Lock className="w-16 h-16 mx-auto mb-4 text-accent" />
        <h3 className="text-lg font-medium mb-2">Unlock with Password</h3>
        <p className="text-sm text-muted">
          Enter your master password to unlock the vault
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="block text-sm font-medium">
          Master Password
        </label>
        <div className="relative">
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            className="glass-input pr-10"
            autoComplete="current-password"
            autoFocus
            disabled={isProcessing}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-colors"
            tabIndex={-1}
          >
            {showPassword ? (
              <EyeOff className="w-4 h-4" />
            ) : (
              <Eye className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {displayError && (
        <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
          <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
          <p className="text-sm text-error">{displayError}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={isProcessing || !password.trim()}
        className="glass-button primary w-full flex items-center justify-center gap-2"
      >
        {isProcessing ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Unlocking...</span>
          </>
        ) : (
          <>
            <Lock className="w-5 h-5" />
            <span>Unlock</span>
          </>
        )}
      </button>

      {isProcessing && (
        <p className="text-xs text-center text-muted">
          Deriving encryption key... This may take a moment.
        </p>
      )}
    </form>
  );
}
