'use client';

import { useState } from 'react';
import { Key, Loader2, AlertCircle, AlertTriangle } from 'lucide-react';
import { useVault } from './VaultProvider';
import { isValidCodeFormat, formatCode } from '@/lib/vault/backup-codes';

export function BackupCodeUnlock() {
  const { unlockWithBackupCode, remainingBackupCodes, totalBackupCodes, isProcessing, error, clearError } = useVault();
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleCodeChange = (value: string) => {
    // Auto-format as user types
    const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    let formatted = '';

    for (let i = 0; i < cleaned.length && i < 12; i++) {
      if (i > 0 && i % 4 === 0) {
        formatted += '-';
      }
      formatted += cleaned[i];
    }

    setCode(formatted);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!code.trim()) {
      setLocalError('Please enter a backup code');
      return;
    }

    if (!isValidCodeFormat(code)) {
      setLocalError('Invalid backup code format. Use XXXX-XXXX-XXXX');
      return;
    }

    setLocalError(null);
    clearError();

    try {
      await unlockWithBackupCode(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to unlock';
      setLocalError(message);
    }
  };

  const displayError = localError || error;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="text-center">
        <Key className="w-16 h-16 mx-auto mb-4 text-accent" />
        <h3 className="text-lg font-medium mb-2">Unlock with Backup Code</h3>
        <p className="text-sm text-muted">
          Enter one of your one-time backup codes
        </p>
      </div>

      {remainingBackupCodes <= 2 && remainingBackupCodes > 0 && (
        <div className="flex items-center gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />
          <p className="text-sm text-warning">
            Only {remainingBackupCodes} backup code{remainingBackupCodes !== 1 ? 's' : ''} remaining!
            Consider regenerating your codes after unlocking.
          </p>
        </div>
      )}

      {remainingBackupCodes === 0 && (
        <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
          <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
          <p className="text-sm text-error">
            No backup codes remaining. Use your password or passkey to unlock.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="backupCode" className="block text-sm font-medium">
          Backup Code
        </label>
        <input
          id="backupCode"
          type="text"
          value={code}
          onChange={(e) => handleCodeChange(e.target.value)}
          placeholder="XXXX-XXXX-XXXX"
          className="glass-input font-mono text-center text-lg tracking-wider"
          autoComplete="off"
          autoFocus
          disabled={isProcessing || remainingBackupCodes === 0}
          maxLength={14}
        />
        <p className="text-xs text-muted text-center">
          {remainingBackupCodes} of {totalBackupCodes} codes remaining
        </p>
      </div>

      {displayError && (
        <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
          <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
          <p className="text-sm text-error">{displayError}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={isProcessing || remainingBackupCodes === 0 || !code.trim()}
        className="glass-button primary w-full flex items-center justify-center gap-2"
      >
        {isProcessing ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Verifying...</span>
          </>
        ) : (
          <>
            <Key className="w-5 h-5" />
            <span>Unlock with Backup Code</span>
          </>
        )}
      </button>

      <p className="text-xs text-center text-muted">
        This code will be marked as used after successful unlock
      </p>
    </form>
  );
}
