'use client';

import { useState } from 'react';
import { Shield, Lock, Fingerprint, Key, Check } from 'lucide-react';
import { useVault } from './VaultProvider';
import { PasswordSetup } from './PasswordSetup';
import { PasskeySetup } from './PasskeySetup';
import { BackupCodesDisplay } from './BackupCodesDisplay';

type SetupStep = 'password' | 'passkey' | 'backup-codes' | 'complete';

const STEPS: { id: SetupStep; label: string; icon: typeof Lock }[] = [
  { id: 'password', label: 'Password', icon: Lock },
  { id: 'passkey', label: 'Passkey', icon: Fingerprint },
  { id: 'backup-codes', label: 'Backup Codes', icon: Key },
];

export function VaultSetupWizard() {
  const { setupVault, isProcessing } = useVault();
  const [currentStep, setCurrentStep] = useState<SetupStep>('password');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const currentStepIndex = STEPS.findIndex(s => s.id === currentStep);

  const handlePasswordComplete = async (password: string) => {
    try {
      setError(null);
      const result = await setupVault(password);
      setBackupCodes(result.backupCodes);
      setCurrentStep('passkey');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create vault';
      setError(message);
    }
  };

  const handlePasskeyComplete = () => {
    setCurrentStep('backup-codes');
  };

  const handlePasskeySkip = () => {
    setCurrentStep('backup-codes');
  };

  const handleBackupCodesComplete = () => {
    setCurrentStep('complete');
  };

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-4">
      <div className="glass-card p-8 w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-8">
          <Shield className="w-12 h-12 mx-auto mb-4 text-accent" />
          <h2 className="text-2xl font-bold mb-2">Set Up Your Vault</h2>
          <p className="text-muted">
            Create a secure vault to store your API keys and secrets
          </p>
        </div>

        {/* Progress Steps */}
        {currentStep !== 'complete' && (
          <div className="flex items-center justify-center gap-2 mb-8">
            {STEPS.map((step, index) => {
              const isComplete = index < currentStepIndex;
              const isCurrent = step.id === currentStep;

              return (
                <div key={step.id} className="flex items-center">
                  <div
                    className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
                      isComplete
                        ? 'bg-success text-white'
                        : isCurrent
                        ? 'bg-accent text-white'
                        : 'bg-card-bg text-muted'
                    }`}
                  >
                    {isComplete ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      <step.icon className="w-4 h-4" />
                    )}
                  </div>
                  {index < STEPS.length - 1 && (
                    <div
                      className={`w-12 h-0.5 mx-1 transition-colors ${
                        isComplete ? 'bg-success' : 'bg-card-border'
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Step Content */}
        {currentStep === 'password' && (
          <PasswordSetup
            onComplete={handlePasswordComplete}
            isProcessing={isProcessing}
          />
        )}

        {currentStep === 'passkey' && (
          <PasskeySetup
            onComplete={handlePasskeyComplete}
            onSkip={handlePasskeySkip}
            isOptional
          />
        )}

        {currentStep === 'backup-codes' && (
          <BackupCodesDisplay
            codes={backupCodes}
            onComplete={handleBackupCodesComplete}
          />
        )}

        {currentStep === 'complete' && (
          <div className="text-center space-y-6">
            <div className="w-20 h-20 mx-auto bg-success/20 rounded-full flex items-center justify-center">
              <Check className="w-10 h-10 text-success" />
            </div>
            <div>
              <h3 className="text-2xl font-bold mb-2">Vault Created!</h3>
              <p className="text-muted">
                Your secure vault is ready to use. Start adding your secrets.
              </p>
            </div>
          </div>
        )}

        {error && currentStep === 'password' && (
          <div className="mt-4 p-3 bg-error/10 border border-error/20 rounded-lg text-center">
            <p className="text-sm text-error">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
