'use client';

import { useState } from 'react';
import {
  Settings,
  X,
  Fingerprint,
  Lock,
  Key,
  Trash2,
  Plus,
  AlertCircle,
  AlertTriangle,
  Check,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { useVault } from './VaultProvider';
import { PasskeySetup } from './PasskeySetup';
import { BackupCodesDisplay } from './BackupCodesDisplay';

type SettingsTab = 'passkeys' | 'password' | 'backup-codes';

interface VaultSettingsProps {
  onClose: () => void;
}

export function VaultSettings({ onClose }: VaultSettingsProps) {
  const {
    passkeys,
    hasPassword,
    remainingBackupCodes,
    totalBackupCodes,
    removePasskey,
    changePassword,
    regenerateBackupCodes,
    isProcessing,
    error,
    clearError,
  } = useVault();

  const [activeTab, setActiveTab] = useState<SettingsTab>('passkeys');
  const [showAddPasskey, setShowAddPasskey] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  // Backup codes state
  const [regeneratePassword, setRegeneratePassword] = useState('');
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);
  const [codesError, setCodesError] = useState<string | null>(null);

  const handleRemovePasskey = async (id: string) => {
    if (deleteConfirm !== id) {
      setDeleteConfirm(id);
      setTimeout(() => setDeleteConfirm(null), 3000);
      return;
    }

    try {
      await removePasskey(id);
      setDeleteConfirm(null);
    } catch {
      // Error handled by context
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      return;
    }

    try {
      await changePassword(currentPassword, newPassword);
      setPasswordSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to change password';
      setPasswordError(message);
    }
  };

  const handleRegenerateCodes = async (e: React.FormEvent) => {
    e.preventDefault();
    setCodesError(null);

    try {
      const codes = await regenerateBackupCodes(regeneratePassword);
      setNewBackupCodes(codes);
      setRegeneratePassword('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to regenerate codes';
      setCodesError(message);
    }
  };

  const tabs = [
    { id: 'passkeys' as const, label: 'Passkeys', icon: Fingerprint },
    { id: 'password' as const, label: 'Password', icon: Lock },
    { id: 'backup-codes' as const, label: 'Backup Codes', icon: Key },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="glass-card p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Settings className="w-6 h-6 text-accent" />
            <h2 className="text-xl font-bold">Vault Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-card-hover"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-card-bg rounded-lg mb-6">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                clearError();
              }}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-accent text-white'
                  : 'text-muted hover:text-foreground hover:bg-card-hover'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Passkeys Tab */}
        {activeTab === 'passkeys' && !showAddPasskey && (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Passkeys let you unlock your vault with Windows Hello (face, fingerprint, or PIN).
            </p>

            {passkeys.length === 0 ? (
              <div className="text-center py-8">
                <Fingerprint className="w-12 h-12 mx-auto mb-4 text-muted" />
                <p className="text-muted mb-4">No passkeys registered</p>
              </div>
            ) : (
              <div className="space-y-2">
                {passkeys.map(pk => (
                  <div
                    key={pk.id}
                    className="flex items-center justify-between p-4 bg-card-bg rounded-lg"
                  >
                    <div>
                      <p className="font-medium">{pk.deviceName}</p>
                      <p className="text-xs text-muted">
                        Added: {new Date(pk.createdAt).toLocaleDateString()}
                        {pk.lastUsed && ` • Last used: ${new Date(pk.lastUsed).toLocaleDateString()}`}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRemovePasskey(pk.id)}
                      disabled={isProcessing || (passkeys.length === 1 && !hasPassword)}
                      className={`p-2 rounded-lg transition-colors ${
                        deleteConfirm === pk.id
                          ? 'text-error bg-error/10'
                          : 'text-muted hover:text-error hover:bg-error/10'
                      }`}
                      title={deleteConfirm === pk.id ? 'Click again to confirm' : 'Remove passkey'}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => setShowAddPasskey(true)}
              className="glass-button primary w-full flex items-center justify-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>Add New Passkey</span>
            </button>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
                <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
                <p className="text-sm text-error">{error}</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'passkeys' && showAddPasskey && (
          <div>
            <button
              onClick={() => setShowAddPasskey(false)}
              className="text-sm text-muted hover:text-foreground mb-4"
            >
              ← Back to passkeys list
            </button>
            <PasskeySetup
              onComplete={() => setShowAddPasskey(false)}
              isOptional={false}
            />
          </div>
        )}

        {/* Password Tab */}
        {activeTab === 'password' && (
          <form onSubmit={handleChangePassword} className="space-y-4">
            <p className="text-sm text-muted">
              Change your master password. Make sure to update it in your password manager.
            </p>

            <div className="space-y-2">
              <label htmlFor="currentPassword" className="block text-sm font-medium">
                Current Password
              </label>
              <input
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="glass-input"
                autoComplete="current-password"
                disabled={isProcessing}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="newPassword" className="block text-sm font-medium">
                New Password
              </label>
              <input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="glass-input"
                autoComplete="new-password"
                disabled={isProcessing}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="confirmNewPassword" className="block text-sm font-medium">
                Confirm New Password
              </label>
              <input
                id="confirmNewPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="glass-input"
                autoComplete="new-password"
                disabled={isProcessing}
              />
            </div>

            {passwordError && (
              <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
                <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
                <p className="text-sm text-error">{passwordError}</p>
              </div>
            )}

            {passwordSuccess && (
              <div className="flex items-center gap-2 p-3 bg-success/10 border border-success/20 rounded-lg">
                <Check className="w-4 h-4 text-success flex-shrink-0" />
                <p className="text-sm text-success">Password changed successfully!</p>
              </div>
            )}

            <button
              type="submit"
              disabled={isProcessing || !currentPassword || !newPassword || !confirmPassword}
              className="glass-button primary w-full flex items-center justify-center gap-2"
            >
              {isProcessing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Lock className="w-4 h-4" />
              )}
              <span>Change Password</span>
            </button>
          </form>
        )}

        {/* Backup Codes Tab */}
        {activeTab === 'backup-codes' && !newBackupCodes && (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-card-bg rounded-lg">
              <div>
                <p className="font-medium">Backup Codes</p>
                <p className="text-sm text-muted">
                  {remainingBackupCodes} of {totalBackupCodes} codes remaining
                </p>
              </div>
              {remainingBackupCodes <= 2 && (
                <AlertTriangle className="w-5 h-5 text-warning" />
              )}
            </div>

            <div className="flex items-center gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />
              <p className="text-sm text-warning">
                Regenerating codes will invalidate all existing codes.
              </p>
            </div>

            <form onSubmit={handleRegenerateCodes} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="regeneratePassword" className="block text-sm font-medium">
                  Enter Password to Regenerate
                </label>
                <input
                  id="regeneratePassword"
                  type="password"
                  value={regeneratePassword}
                  onChange={(e) => setRegeneratePassword(e.target.value)}
                  className="glass-input"
                  placeholder="Verify your password"
                  disabled={isProcessing}
                />
              </div>

              {codesError && (
                <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
                  <p className="text-sm text-error">{codesError}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={isProcessing || !regeneratePassword}
                className="glass-button primary w-full flex items-center justify-center gap-2"
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                <span>Regenerate Backup Codes</span>
              </button>
            </form>
          </div>
        )}

        {activeTab === 'backup-codes' && newBackupCodes && (
          <BackupCodesDisplay
            codes={newBackupCodes}
            onComplete={() => setNewBackupCodes(null)}
          />
        )}
      </div>
    </div>
  );
}
