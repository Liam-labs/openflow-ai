'use client';

import { useState, useMemo } from 'react';
import { Lock, Eye, EyeOff, Check, X, AlertCircle } from 'lucide-react';
import { evaluatePasswordStrength, getStrengthLabel, getStrengthColor } from '@/lib/vault/argon2';

interface PasswordSetupProps {
  onComplete: (password: string) => void;
  isProcessing?: boolean;
}

export function PasswordSetup({ onComplete, isProcessing }: PasswordSetupProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strength = useMemo(
    () => evaluatePasswordStrength(password),
    [password]
  );

  const passwordsMatch = password === confirmPassword;
  const canSubmit = strength.isAcceptable && passwordsMatch && confirmPassword.length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!strength.isAcceptable) {
      setError('Password is too weak');
      return;
    }

    if (!passwordsMatch) {
      setError('Passwords do not match');
      return;
    }

    setError(null);
    onComplete(password);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="text-center mb-6">
        <Lock className="w-12 h-12 mx-auto mb-4 text-accent" />
        <h3 className="text-xl font-bold mb-2">Create Master Password</h3>
        <p className="text-sm text-muted">
          This password will be used to encrypt your secrets.
          Store it safely in your password manager.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="newPassword" className="block text-sm font-medium">
            Master Password
          </label>
          <div className="relative">
            <input
              id="newPassword"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter a strong password"
              className="glass-input pr-10"
              autoComplete="new-password"
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

          {/* Password Strength Indicator */}
          {password.length > 0 && (
            <div className="space-y-2">
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4].map((level) => (
                  <div
                    key={level}
                    className="flex-1 h-1 rounded-full transition-colors"
                    style={{
                      backgroundColor:
                        level <= strength.score
                          ? getStrengthColor(strength.score)
                          : 'var(--card-border)',
                    }}
                  />
                ))}
              </div>
              <div className="flex justify-between items-center text-xs">
                <span style={{ color: getStrengthColor(strength.score) }}>
                  {getStrengthLabel(strength.score)}
                </span>
                {strength.feedback.length > 0 && (
                  <span className="text-muted">{strength.feedback[0]}</span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="confirmPassword" className="block text-sm font-medium">
            Confirm Password
          </label>
          <div className="relative">
            <input
              id="confirmPassword"
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm your password"
              className={`glass-input pr-10 ${
                confirmPassword.length > 0 && !passwordsMatch ? 'border-error' : ''
              }`}
              autoComplete="new-password"
              disabled={isProcessing}
            />
            {confirmPassword.length > 0 && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                {passwordsMatch ? (
                  <Check className="w-4 h-4 text-success" />
                ) : (
                  <X className="w-4 h-4 text-error" />
                )}
              </div>
            )}
          </div>
          {confirmPassword.length > 0 && !passwordsMatch && (
            <p className="text-xs text-error">Passwords do not match</p>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
          <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      <div className="bg-card-bg rounded-lg p-4 space-y-2">
        <p className="text-xs font-medium text-muted uppercase tracking-wide">
          Password Requirements
        </p>
        <ul className="text-xs text-muted space-y-1">
          <li className="flex items-center gap-2">
            {password.length >= 8 ? (
              <Check className="w-3 h-3 text-success" />
            ) : (
              <X className="w-3 h-3 text-muted" />
            )}
            At least 8 characters
          </li>
          <li className="flex items-center gap-2">
            {/[a-z]/.test(password) && /[A-Z]/.test(password) ? (
              <Check className="w-3 h-3 text-success" />
            ) : (
              <X className="w-3 h-3 text-muted" />
            )}
            Upper and lowercase letters
          </li>
          <li className="flex items-center gap-2">
            {/\d/.test(password) ? (
              <Check className="w-3 h-3 text-success" />
            ) : (
              <X className="w-3 h-3 text-muted" />
            )}
            At least one number
          </li>
        </ul>
      </div>

      <button
        type="submit"
        disabled={!canSubmit || isProcessing}
        className="glass-button primary w-full"
      >
        {isProcessing ? 'Creating Vault...' : 'Continue'}
      </button>
    </form>
  );
}
