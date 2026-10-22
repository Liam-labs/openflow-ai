/**
 * Tests for computeVaultDerived — guards against undefined array access
 * on partial vault files (e.g. {version:1} with no passkeys/backupCodes).
 */

import { describe, it, expect } from 'vitest';
import { computeVaultDerived } from '@/lib/vault/vault-computed';

describe('computeVaultDerived', () => {
  it('returns empty passkeys and zero counts when vaultFile is null', () => {
    const result = computeVaultDerived(null);
    expect(result.passkeys).toEqual([]);
    expect(result.remainingBackupCodes).toBe(0);
    expect(result.totalBackupCodes).toBe(0);
  });

  it('does not throw and returns defaults when vaultFile has no passkeys or backupCodes', () => {
    // Simulates a partial vault file read from disk (only version field present)
    const partialVault = { version: 1 } as never;
    expect(() => computeVaultDerived(partialVault)).not.toThrow();
    const result = computeVaultDerived(partialVault);
    expect(result.passkeys).toEqual([]);
    expect(result.remainingBackupCodes).toBe(0);
    expect(result.totalBackupCodes).toBe(0);
  });

  it('maps passkeys correctly when present', () => {
    const vault = {
      version: 1 as const,
      passkeys: [
        {
          id: 'pk-1',
          deviceName: 'My Laptop',
          credentialId: 'cred-1',
          publicKey: 'pk',
          prfSalt: 'salt',
          encryptedDEK: { iv: 'iv', ciphertext: 'ct' },
          createdAt: '2026-01-01T00:00:00Z',
          lastUsed: '2026-01-02T00:00:00Z',
        },
      ],
      backupCodes: [],
      password: null,
      secrets: { iv: 'iv', ciphertext: 'ct' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const result = computeVaultDerived(vault);
    expect(result.passkeys).toHaveLength(1);
    expect(result.passkeys[0]).toEqual({
      id: 'pk-1',
      deviceName: 'My Laptop',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsed: '2026-01-02T00:00:00Z',
    });
  });

  it('counts remaining (unused) backup codes correctly', () => {
    const vault = {
      version: 1 as const,
      passkeys: [],
      backupCodes: [
        { id: 1, hash: 'h1', encryptedDEK: { iv: 'iv', ciphertext: 'ct' }, used: false },
        { id: 2, hash: 'h2', encryptedDEK: { iv: 'iv', ciphertext: 'ct' }, used: true },
        { id: 3, hash: 'h3', encryptedDEK: { iv: 'iv', ciphertext: 'ct' }, used: false },
      ],
      password: null,
      secrets: { iv: 'iv', ciphertext: 'ct' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const result = computeVaultDerived(vault);
    expect(result.totalBackupCodes).toBe(3);
    expect(result.remainingBackupCodes).toBe(2);
  });
});
