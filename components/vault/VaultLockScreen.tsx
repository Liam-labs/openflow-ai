'use client';

import { useState } from 'react';
import { Shield, Fingerprint, Lock, Key } from 'lucide-react';
import { useVault } from './VaultProvider';
import { PasskeyUnlock } from './PasskeyUnlock';
import { PasswordUnlock } from './PasswordUnlock';
import { BackupCodeUnlock } from './BackupCodeUnlock';

type UnlockTab = 'passkey' | 'password' | 'backup';

export function VaultLockScreen() {
  const { passkeys, hasPassword } = useVault();
  const [activeTab, setActiveTab] = useState<UnlockTab>(
    passkeys.length > 0 ? 'passkey' : 'password'
  );

  const tabs = [
    {
      id: 'passkey' as const,
      label: 'Passkey',
      icon: Fingerprint,
      show: passkeys.length > 0,
    },
    {
      id: 'password' as const,
      label: 'Password',
      icon: Lock,
      show: hasPassword,
    },
    {
      id: 'backup' as const,
      label: 'Backup Code',
      icon: Key,
      show: true,
    },
  ].filter(tab => tab.show);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-4">
      <div className="glass-card p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <Shield className="w-12 h-12 mx-auto mb-4 text-accent" />
          <h2 className="text-2xl font-bold mb-2">Vault Locked</h2>
          <p className="text-muted">
            Choose an unlock method to access your secrets
          </p>
        </div>

        {/* Tab Navigation */}
        {tabs.length > 1 && (
          <div className="flex gap-1 p-1 bg-card-bg rounded-lg mb-6">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm font-medium transition-all ${
                  activeTab === tab.id
                    ? 'bg-accent text-white'
                    : 'text-muted hover:text-foreground hover:bg-card-hover'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            ))}
          </div>
        )}

        {/* Tab Content */}
        <div>
          {activeTab === 'passkey' && <PasskeyUnlock />}
          {activeTab === 'password' && <PasswordUnlock />}
          {activeTab === 'backup' && <BackupCodeUnlock />}
        </div>
      </div>
    </div>
  );
}
