'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Shield, Loader2, ArrowLeft } from 'lucide-react';
import { VaultProvider, useVault } from '@/components/vault/VaultProvider';
import { VaultLockScreen } from '@/components/vault/VaultLockScreen';
import { VaultSetupWizard } from '@/components/vault/VaultSetupWizard';
import { VaultSecretsViewer } from '@/components/vault/VaultSecretsViewer';
import { VaultAddSecret } from '@/components/vault/VaultAddSecret';
import { VaultSettings } from '@/components/vault/VaultSettings';
import { VaultImport } from '@/components/vault/VaultImport';
import type { Secret } from '@/lib/vault/types';

function VaultContent() {
  const { status } = useVault();
  const [showAddSecret, setShowAddSecret] = useState(false);
  const [editingSecret, setEditingSecret] = useState<Secret | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const handleAddSecret = () => {
    setEditingSecret(null);
    setShowAddSecret(true);
  };

  const handleEditSecret = (secret: Secret) => {
    setEditingSecret(secret);
    setShowAddSecret(true);
  };

  const handleCloseModal = () => {
    setShowAddSecret(false);
    setEditingSecret(null);
  };

  if (status === 'loading') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 mx-auto mb-4 text-accent animate-spin" />
          <p className="text-muted">Loading vault...</p>
        </div>
      </div>
    );
  }

  if (status === 'setup-required') {
    return <VaultSetupWizard />;
  }

  if (status === 'locked') {
    return <VaultLockScreen />;
  }

  return (
    <>
      <VaultSecretsViewer
        onAddSecret={handleAddSecret}
        onEditSecret={handleEditSecret}
        onOpenSettings={() => setShowSettings(true)}
        onImport={() => setShowImport(true)}
      />

      {showAddSecret && (
        <VaultAddSecret
          editingSecret={editingSecret}
          onClose={handleCloseModal}
        />
      )}

      {showSettings && (
        <VaultSettings onClose={() => setShowSettings(false)} />
      )}

      {showImport && (
        <VaultImport onClose={() => setShowImport(false)} />
      )}
    </>
  );
}

export default function VaultPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="glass-header sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Shield className="w-8 h-8 text-accent" />
              <div>
                <h1 className="text-xl font-bold">DevFlow Vault</h1>
                <p className="text-xs text-muted">Secure Secrets Management</p>
              </div>
            </div>
            <Link
              href="/operations"
              className="flex items-center gap-2 px-4 py-2 text-sm text-muted hover:text-foreground transition-colors rounded-lg hover:bg-card-hover"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Dashboard</span>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        <VaultProvider>
          <VaultContent />
        </VaultProvider>
      </main>
    </div>
  );
}
