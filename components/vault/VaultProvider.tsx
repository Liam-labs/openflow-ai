'use client';

/**
 * DevFlow Vault Provider
 *
 * React Context provider for vault state management.
 * DEK is stored ONLY in React state - refresh = lock.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import type {
  VaultContextType,
  VaultStatus,
  VaultFile,
  Secret,
} from '@/lib/vault/types';
import { computeVaultDerived } from '@/lib/vault/vault-computed';
import { loadVaultFile, saveVaultFile, syncSecretsToFile } from '@/lib/vault/storage';
import {
  initializeVault,
  addPasskeyToVault,
  removePasskeyFromVault,
  updatePasskeyLastUsed,
  unlockVaultWithPassword,
  unlockVaultWithPasskey,
  unlockVaultWithBackupCode,
  decryptSecrets,
  changeVaultPassword,
  regenerateBackupCodes,
  addSecret as addSecretOp,
  addSecretsBulk as addSecretsBulkOp,
  updateSecret as updateSecretOp,
  deleteSecret as deleteSecretOp,
} from '@/lib/vault/vault-operations';
import { getWebAuthnSupport } from '@/lib/vault/webauthn';

// ============================================================================
// Context
// ============================================================================

const VaultContext = createContext<VaultContextType | null>(null);

export function useVault(): VaultContextType {
  const context = useContext(VaultContext);
  if (!context) {
    throw new Error('useVault must be used within a VaultProvider');
  }
  return context;
}

// ============================================================================
// Provider
// ============================================================================

interface VaultProviderProps {
  children: ReactNode;
}

export function VaultProvider({ children }: VaultProviderProps) {
  // DEK stored ONLY in React state - cleared on refresh/unmount
  const [dek, setDek] = useState<CryptoKey | null>(null);

  // Vault state
  const [status, setStatus] = useState<VaultStatus>('loading');
  const [vaultFile, setVaultFile] = useState<VaultFile | null>(null);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const loadInitialState = useCallback(async () => {
    try {
      setStatus('loading');
      const vault = await loadVaultFile();

      if (vault) {
        setVaultFile(vault);
        setStatus('locked');
      } else {
        setStatus('setup-required');
      }
    } catch (err) {
      console.error('Failed to load vault:', err);
      setError('Failed to load vault');
      setStatus('setup-required');
    }
  }, []);

  // ============================================================================
  // Initialization
  // ============================================================================

  useEffect(() => {
    loadInitialState();
  }, [loadInitialState]);

  // ============================================================================
  // Unlock Methods
  // ============================================================================

  const unlockWithPassword = useCallback(async (password: string) => {
    if (!vaultFile) throw new Error('No vault loaded');

    setIsProcessing(true);
    setError(null);

    try {
      const decryptedDek = await unlockVaultWithPassword(vaultFile, password);
      const decryptedSecrets = await decryptSecrets(decryptedDek, vaultFile.secrets);

      setDek(decryptedDek);
      setSecrets(decryptedSecrets);
      setStatus('unlocked');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to unlock';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, [vaultFile]);

  const unlockWithPasskey = useCallback(async (credentialId?: string) => {
    if (!vaultFile) throw new Error('No vault loaded');

    setIsProcessing(true);
    setError(null);

    try {
      const result = await unlockVaultWithPasskey(vaultFile, credentialId);
      const decryptedSecrets = await decryptSecrets(result.dek, vaultFile.secrets);

      // Update last used timestamp
      const updatedVault = updatePasskeyLastUsed(vaultFile, result.credentialId);
      await saveVaultFile(updatedVault);
      setVaultFile(updatedVault);

      setDek(result.dek);
      setSecrets(decryptedSecrets);
      setStatus('unlocked');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to unlock';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, [vaultFile]);

  const unlockWithBackupCode = useCallback(async (code: string) => {
    if (!vaultFile) throw new Error('No vault loaded');

    setIsProcessing(true);
    setError(null);

    try {
      const result = await unlockVaultWithBackupCode(vaultFile, code);
      const decryptedSecrets = await decryptSecrets(result.dek, result.vaultFile.secrets);

      // Save updated vault (with code marked as used)
      await saveVaultFile(result.vaultFile);
      setVaultFile(result.vaultFile);

      setDek(result.dek);
      setSecrets(decryptedSecrets);
      setStatus('unlocked');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to unlock';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, [vaultFile]);

  // ============================================================================
  // Lock
  // ============================================================================

  const lock = useCallback(() => {
    setDek(null);
    setSecrets([]);
    setStatus('locked');
    setError(null);
  }, []);

  // ============================================================================
  // Setup
  // ============================================================================

  const setupVault = useCallback(async (password: string): Promise<{ backupCodes: string[] }> => {
    setIsProcessing(true);
    setError(null);

    try {
      const result = await initializeVault(password);

      // Save vault file
      await saveVaultFile(result.vaultFile);
      setVaultFile(result.vaultFile);

      // Set DEK and unlock
      setDek(result.dek);
      setSecrets([]);
      setStatus('unlocked');

      return { backupCodes: result.backupCodes };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to setup vault';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, []);

  const registerPasskey = useCallback(async (deviceName: string) => {
    if (!vaultFile || !dek) throw new Error('Vault must be unlocked');

    setIsProcessing(true);
    setError(null);

    try {
      const updatedVault = await addPasskeyToVault(vaultFile, dek, deviceName);
      await saveVaultFile(updatedVault);
      setVaultFile(updatedVault);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to register passkey';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, [vaultFile, dek]);

  // ============================================================================
  // Secret Management
  // ============================================================================

  const addSecret = useCallback(async (
    secret: Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>
  ) => {
    if (!vaultFile || !dek) throw new Error('Vault must be unlocked');

    setIsProcessing(true);
    setError(null);

    try {
      const updatedVault = await addSecretOp(vaultFile, dek, secret);
      await saveVaultFile(updatedVault);
      setVaultFile(updatedVault);

      // Refresh secrets
      const decryptedSecrets = await decryptSecrets(dek, updatedVault.secrets);
      setSecrets(decryptedSecrets);

      // Sync to ~/.secrets file
      await syncSecretsToFile([], 'add', {
        secret: {
          name: secret.name,
          value: secret.value,
          category: secret.category,
          payloadUrl: secret.payloadUrl,
          score: secret.score,
          clientId: secret.clientId,
          clientSecret: secret.clientSecret,
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add secret';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, [vaultFile, dek]);

  const addSecretsBulk = useCallback(async (
    newSecrets: Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>[]
  ) => {
    if (!vaultFile || !dek) throw new Error('Vault must be unlocked');

    setIsProcessing(true);
    setError(null);

    try {
      console.log('[VaultProvider] Bulk importing', newSecrets.length, 'secrets');
      const updatedVault = await addSecretsBulkOp(vaultFile, dek, newSecrets);
      await saveVaultFile(updatedVault);
      setVaultFile(updatedVault);

      // Refresh secrets
      const decryptedSecrets = await decryptSecrets(dek, updatedVault.secrets);
      setSecrets(decryptedSecrets);
      console.log('[VaultProvider] Bulk import complete, now have', decryptedSecrets.length, 'secrets');

      // Sync all secrets to ~/.secrets file
      await syncSecretsToFile(
        decryptedSecrets.map(s => ({
          name: s.name,
          value: s.value,
          category: s.category,
          payloadUrl: s.payloadUrl,
          score: s.score,
          clientId: s.clientId,
          clientSecret: s.clientSecret,
        })),
        'sync'
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to import secrets';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, [vaultFile, dek]);

  const updateSecret = useCallback(async (
    id: string,
    updates: Partial<Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>>
  ) => {
    if (!vaultFile || !dek) throw new Error('Vault must be unlocked');

    setIsProcessing(true);
    setError(null);

    try {
      // Get old secret name for potential rename
      const oldSecrets = await decryptSecrets(dek, vaultFile.secrets);
      const oldSecret = oldSecrets.find(s => s.id === id);
      const oldName = oldSecret?.name;

      const updatedVault = await updateSecretOp(vaultFile, dek, id, updates);
      await saveVaultFile(updatedVault);
      setVaultFile(updatedVault);

      // Refresh secrets
      const decryptedSecrets = await decryptSecrets(dek, updatedVault.secrets);
      setSecrets(decryptedSecrets);

      // Sync to ~/.secrets file
      const updatedSecret = decryptedSecrets.find(s => s.id === id);
      if (updatedSecret) {
        await syncSecretsToFile([], 'update', {
          secret: {
            name: updatedSecret.name,
            value: updatedSecret.value,
            category: updatedSecret.category,
            payloadUrl: updatedSecret.payloadUrl,
            score: updatedSecret.score,
            clientId: updatedSecret.clientId,
            clientSecret: updatedSecret.clientSecret,
          },
          oldName: oldName !== updatedSecret.name ? oldName : undefined
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update secret';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, [vaultFile, dek]);

  const deleteSecret = useCallback(async (id: string) => {
    if (!vaultFile || !dek) throw new Error('Vault must be unlocked');

    setIsProcessing(true);
    setError(null);

    try {
      // Get secret name before deletion for sync
      const oldSecrets = await decryptSecrets(dek, vaultFile.secrets);
      const secretToDelete = oldSecrets.find(s => s.id === id);

      const updatedVault = await deleteSecretOp(vaultFile, dek, id);
      await saveVaultFile(updatedVault);
      setVaultFile(updatedVault);

      // Refresh secrets
      const decryptedSecrets = await decryptSecrets(dek, updatedVault.secrets);
      setSecrets(decryptedSecrets);

      // Sync deletion to ~/.secrets file
      if (secretToDelete) {
        await syncSecretsToFile([], 'delete', {
          secret: { name: secretToDelete.name, value: '', category: secretToDelete.category }
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete secret';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, [vaultFile, dek]);

  // ============================================================================
  // Settings
  // ============================================================================

  const changePassword = useCallback(async (
    currentPassword: string,
    newPassword: string
  ) => {
    if (!vaultFile) throw new Error('No vault loaded');

    setIsProcessing(true);
    setError(null);

    try {
      // Verify current password by unlocking
      const currentDek = await unlockVaultWithPassword(vaultFile, currentPassword);

      // Change password
      const updatedVault = await changeVaultPassword(vaultFile, currentDek, newPassword);
      await saveVaultFile(updatedVault);
      setVaultFile(updatedVault);

      // Keep DEK if already unlocked
      if (!dek) {
        setDek(currentDek);
        const decryptedSecrets = await decryptSecrets(currentDek, updatedVault.secrets);
        setSecrets(decryptedSecrets);
        setStatus('unlocked');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to change password';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, [vaultFile, dek]);

  const addPasskey = useCallback(async (deviceName: string) => {
    return registerPasskey(deviceName);
  }, [registerPasskey]);

  const removePasskey = useCallback(async (id: string) => {
    if (!vaultFile) throw new Error('No vault loaded');

    // Prevent removing last passkey if no password is set
    if (vaultFile.passkeys.length <= 1 && !vaultFile.password) {
      throw new Error('Cannot remove last passkey without a password set');
    }

    setIsProcessing(true);
    setError(null);

    try {
      const updatedVault = removePasskeyFromVault(vaultFile, id);
      await saveVaultFile(updatedVault);
      setVaultFile(updatedVault);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove passkey';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, [vaultFile]);

  const regenerateBackupCodesAction = useCallback(async (
    password: string
  ): Promise<string[]> => {
    if (!vaultFile) throw new Error('No vault loaded');

    setIsProcessing(true);
    setError(null);

    try {
      // Verify password
      const verifiedDek = await unlockVaultWithPassword(vaultFile, password);

      // Regenerate codes
      const result = await regenerateBackupCodes(vaultFile, verifiedDek);
      await saveVaultFile(result.vaultFile);
      setVaultFile(result.vaultFile);

      return result.backupCodes;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to regenerate backup codes';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, [vaultFile]);

  // ============================================================================
  // Utilities
  // ============================================================================

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const checkWebAuthnSupport = useCallback(async () => {
    const support = await getWebAuthnSupport();
    return {
      supported: support.supported,
      prfSupported: support.prfSupported,
    };
  }, []);

  // ============================================================================
  // Computed Values
  // ============================================================================

  const { passkeys, remainingBackupCodes, totalBackupCodes } = computeVaultDerived(vaultFile);
  const hasPassword = vaultFile?.password !== null;

  // ============================================================================
  // Context Value
  // ============================================================================

  const contextValue: VaultContextType = {
    // State
    status,
    secrets,
    passkeys,
    hasPassword,
    remainingBackupCodes,
    totalBackupCodes,
    error,
    isProcessing,

    // Actions
    unlockWithPasskey,
    unlockWithPassword,
    unlockWithBackupCode,
    lock,
    setupVault,
    registerPasskey,
    addSecret,
    addSecretsBulk,
    updateSecret,
    deleteSecret,
    changePassword,
    addPasskey,
    removePasskey,
    regenerateBackupCodes: regenerateBackupCodesAction,
    clearError,
    checkWebAuthnSupport,
  };

  return (
    <VaultContext.Provider value={contextValue}>
      {children}
    </VaultContext.Provider>
  );
}
