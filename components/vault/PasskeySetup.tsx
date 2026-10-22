'use client';

import { useState, useEffect } from 'react';
import { Fingerprint, Loader2, AlertCircle, Check, SkipForward } from 'lucide-react';
import { useVault } from './VaultProvider';

interface PasskeySetupProps {
  onComplete: () => void;
  onSkip?: () => void;
  isOptional?: boolean;
}

export function PasskeySetup({ onComplete, onSkip, isOptional = true }: PasskeySetupProps) {
  const { registerPasskey, checkWebAuthnSupport, isProcessing, error, clearError } = useVault();
  const [deviceName, setDeviceName] = useState('');
  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);

  useEffect(() => {
    checkSupport();
    setDefaultDeviceName();
  }, []);

  const checkSupport = async () => {
    try {
      const support = await checkWebAuthnSupport();
      setIsSupported(support.prfSupported);
    } catch {
      setIsSupported(false);
    }
  };

  const setDefaultDeviceName = () => {
    // Try to generate a sensible default device name
    const platform = navigator.platform || 'Device';
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    setDeviceName(`${platform} - ${dateStr}`);
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!deviceName.trim()) {
      setLocalError('Please enter a device name');
      return;
    }

    setLocalError(null);
    clearError();

    try {
      await registerPasskey(deviceName.trim());
      setIsRegistered(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to register passkey';
      setLocalError(message);
    }
  };

  const displayError = localError || error;

  if (isRegistered) {
    return (
      <div className="text-center space-y-6">
        <div className="w-16 h-16 mx-auto bg-success/20 rounded-full flex items-center justify-center">
          <Check className="w-8 h-8 text-success" />
        </div>
        <div>
          <h3 className="text-xl font-bold mb-2">Passkey Registered!</h3>
          <p className="text-sm text-muted">
            You can now use Windows Hello to unlock your vault.
          </p>
        </div>
        <button
          onClick={onComplete}
          className="glass-button primary w-full"
        >
          Continue
        </button>
      </div>
    );
  }

  if (isSupported === false) {
    return (
      <div className="text-center space-y-6">
        <div className="w-16 h-16 mx-auto bg-warning/20 rounded-full flex items-center justify-center">
          <AlertCircle className="w-8 h-8 text-warning" />
        </div>
        <div>
          <h3 className="text-xl font-bold mb-2">Passkeys Not Available</h3>
          <p className="text-sm text-muted">
            Your browser or device doesn't support the required passkey features.
            You can still use your password to unlock the vault.
          </p>
        </div>
        <button
          onClick={onComplete}
          className="glass-button primary w-full"
        >
          Continue Without Passkey
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleRegister} className="space-y-6">
      <div className="text-center mb-6">
        <Fingerprint className="w-12 h-12 mx-auto mb-4 text-accent" />
        <h3 className="text-xl font-bold mb-2">Set Up Windows Hello</h3>
        <p className="text-sm text-muted">
          Use your face, fingerprint, or PIN for quick and secure access.
          {isOptional && ' You can skip this step and add a passkey later.'}
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="deviceName" className="block text-sm font-medium">
          Device Name
        </label>
        <input
          id="deviceName"
          type="text"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder="e.g., Work Laptop, Home Desktop"
          className="glass-input"
          disabled={isProcessing}
        />
        <p className="text-xs text-muted">
          A name to identify this device in your passkey list
        </p>
      </div>

      {displayError && (
        <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
          <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
          <p className="text-sm text-error">{displayError}</p>
        </div>
      )}

      <div className="space-y-3">
        <button
          type="submit"
          disabled={isProcessing || !deviceName.trim() || isSupported === null}
          className="glass-button primary w-full flex items-center justify-center gap-2"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>Registering...</span>
            </>
          ) : (
            <>
              <Fingerprint className="w-5 h-5" />
              <span>Register Passkey</span>
            </>
          )}
        </button>

        {isOptional && onSkip && (
          <button
            type="button"
            onClick={onSkip}
            disabled={isProcessing}
            className="glass-button secondary w-full flex items-center justify-center gap-2"
          >
            <SkipForward className="w-4 h-4" />
            <span>Skip for Now</span>
          </button>
        )}
      </div>

      {isSupported === null && (
        <p className="text-xs text-center text-muted">
          Checking Windows Hello availability...
        </p>
      )}
    </form>
  );
}
