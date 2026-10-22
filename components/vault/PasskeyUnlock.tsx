'use client';

import { useState, useEffect } from 'react';
import { Fingerprint, Loader2, AlertCircle } from 'lucide-react';
import { useVault } from './VaultProvider';

export function PasskeyUnlock() {
  const { unlockWithPasskey, passkeys, isProcessing, error, clearError } = useVault();
  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    checkSupport();
  }, []);

  const checkSupport = async () => {
    try {
      const { checkWebAuthnSupport } = useVault();
      const support = await checkWebAuthnSupport();
      setIsSupported(support.prfSupported);
    } catch {
      setIsSupported(false);
    }
  };

  const handleUnlock = async () => {
    setLocalError(null);
    clearError();

    try {
      await unlockWithPasskey();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to unlock';
      setLocalError(message);
    }
  };

  if (passkeys.length === 0) {
    return (
      <div className="text-center py-8">
        <Fingerprint className="w-12 h-12 mx-auto mb-4 text-muted" />
        <p className="text-muted">No passkeys registered</p>
        <p className="text-sm text-muted mt-2">
          Unlock with password to add a passkey
        </p>
      </div>
    );
  }

  if (isSupported === false) {
    return (
      <div className="text-center py-8">
        <AlertCircle className="w-12 h-12 mx-auto mb-4 text-warning" />
        <p className="text-warning">Windows Hello not available</p>
        <p className="text-sm text-muted mt-2">
          Your browser or device doesn't support passkey authentication.
          Please use password or backup code instead.
        </p>
      </div>
    );
  }

  const displayError = localError || error;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <Fingerprint className="w-16 h-16 mx-auto mb-4 text-accent" />
        <h3 className="text-lg font-medium mb-2">Unlock with Windows Hello</h3>
        <p className="text-sm text-muted">
          Use your face, fingerprint, or PIN to unlock
        </p>
      </div>

      {passkeys.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted uppercase tracking-wide">Registered Devices</p>
          <div className="space-y-1">
            {passkeys.map(pk => (
              <div key={pk.id} className="flex items-center justify-between py-2 px-3 bg-card-bg rounded-lg">
                <span className="text-sm">{pk.deviceName}</span>
                {pk.lastUsed && (
                  <span className="text-xs text-muted">
                    Last used: {new Date(pk.lastUsed).toLocaleDateString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {displayError && (
        <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
          <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
          <p className="text-sm text-error">{displayError}</p>
        </div>
      )}

      <button
        onClick={handleUnlock}
        disabled={isProcessing || isSupported === null}
        className="glass-button primary w-full flex items-center justify-center gap-2"
      >
        {isProcessing ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Authenticating...</span>
          </>
        ) : (
          <>
            <Fingerprint className="w-5 h-5" />
            <span>Unlock with Windows Hello</span>
          </>
        )}
      </button>
    </div>
  );
}
