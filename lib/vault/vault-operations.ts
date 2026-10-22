/**
 * DevFlow Vault Operations
 *
 * Core vault encryption/decryption logic.
 * Ties together crypto, Argon2, backup codes, and WebAuthn.
 */

import type {
  VaultFile,
  Secret,
  SecretsData,
  PasskeyEntry,
  PasswordConfig,
  BackupCodeEntry,
  EncryptedBlob,
  Argon2Params,
} from './types';
import {
  generateDEK,
  exportDEK,
  importDEK,
  encrypt,
  decrypt,
  wrapDEK,
  unwrapDEK,
  importKEK,
  generateRandomBytes,
  arrayBufferToBase64,
  base64ToUint8Array,
  generateUUID,
} from './crypto';
import { deriveKeyFromPassword, createArgon2Params } from './argon2';
import {
  generateBackupCodes,
  hashBackupCode,
  findMatchingBackupCode,
  deriveKEKFromBackupCode,
  generateBackupCodeSalt,
} from './backup-codes';
import { registerPasskey, authenticateWithPasskey, generatePRFSalt, deriveKEKFromPRF } from './webauthn';

// ============================================================================
// Vault Initialization
// ============================================================================

/**
 * Initialize a new vault with password
 *
 * This is the first-time setup flow:
 * 1. Generate DEK
 * 2. Generate empty secrets
 * 3. Encrypt DEK with password-derived KEK
 * 4. Generate and encrypt DEK with backup codes
 *
 * @param password - User's master password
 * @returns New vault file, DEK, and backup codes
 */
export async function initializeVault(
  password: string
): Promise<{
  vaultFile: VaultFile;
  dek: CryptoKey;
  backupCodes: string[];
}> {
  // Generate the master DEK
  const dek = await generateDEK();
  const dekBytes = await exportDEK(dek);

  // Create Argon2 parameters and derive password KEK
  const argon2Params = createArgon2Params();
  const passwordKeyMaterial = await deriveKeyFromPassword(
    password,
    argon2Params.salt,
    argon2Params
  );
  const passwordKEK = await importKEK(passwordKeyMaterial);

  // Wrap DEK with password KEK
  const passwordEncryptedDEK = await wrapDEK(dek, passwordKEK);

  // Generate and setup backup codes
  const backupCodes = generateBackupCodes();
  const backupCodeSalt = base64ToUint8Array(generateBackupCodeSalt());
  const backupCodeEntries: BackupCodeEntry[] = [];

  for (let i = 0; i < backupCodes.length; i++) {
    const code = backupCodes[i];
    const hash = await hashBackupCode(code);
    const codeKEK = await deriveKEKFromBackupCode(code, backupCodeSalt);
    const encryptedDEK = await wrapDEK(dek, codeKEK);

    backupCodeEntries.push({
      id: i + 1,
      hash,
      encryptedDEK,
      used: false,
    });
  }

  // Encrypt empty secrets
  const emptySecrets: SecretsData = { secrets: [] };
  const encryptedSecrets = await encryptSecrets(dek, emptySecrets);

  // Create vault file
  const now = new Date().toISOString();
  const vaultFile: VaultFile = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    passkeys: [],
    password: {
      kdf: argon2Params,
      encryptedDEK: passwordEncryptedDEK,
    },
    backupCodes: backupCodeEntries,
    secrets: encryptedSecrets,
  };

  return { vaultFile, dek, backupCodes };
}

// ============================================================================
// Passkey Management
// ============================================================================

/**
 * Add a passkey to the vault
 *
 * Requires the DEK to be available (vault must be unlocked).
 *
 * @param vaultFile - Current vault file
 * @param dek - Decrypted DEK
 * @param deviceName - User-friendly device name
 * @returns Updated vault file
 */
export async function addPasskeyToVault(
  vaultFile: VaultFile,
  dek: CryptoKey,
  deviceName: string
): Promise<VaultFile> {
  // Generate PRF salt for this passkey
  const prfSalt = generatePRFSalt();

  // Register passkey with WebAuthn
  const result = await registerPasskey(deviceName, prfSalt);

  // Derive KEK from PRF output
  const prfKEK = await deriveKEKFromPRF(
    result.prfOutput,
    base64ToUint8Array(prfSalt)
  );

  // Wrap DEK with passkey KEK
  const encryptedDEK = await wrapDEK(dek, prfKEK);

  // Create passkey entry
  const passkeyEntry: PasskeyEntry = {
    id: generateUUID(),
    deviceName,
    credentialId: result.credentialId,
    publicKey: result.publicKey,
    prfSalt,
    encryptedDEK,
    createdAt: new Date().toISOString(),
  };

  // Update vault file
  return {
    ...vaultFile,
    passkeys: [...vaultFile.passkeys, passkeyEntry],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Remove a passkey from the vault
 */
export function removePasskeyFromVault(
  vaultFile: VaultFile,
  passkeyId: string
): VaultFile {
  return {
    ...vaultFile,
    passkeys: vaultFile.passkeys.filter(p => p.id !== passkeyId),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Update passkey last used timestamp
 */
export function updatePasskeyLastUsed(
  vaultFile: VaultFile,
  credentialId: string
): VaultFile {
  return {
    ...vaultFile,
    passkeys: vaultFile.passkeys.map(p =>
      p.credentialId === credentialId
        ? { ...p, lastUsed: new Date().toISOString() }
        : p
    ),
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Vault Unlocking
// ============================================================================

/**
 * Unlock vault with password
 *
 * @param vaultFile - Vault file to unlock
 * @param password - User's password
 * @returns Decrypted DEK
 */
export async function unlockVaultWithPassword(
  vaultFile: VaultFile,
  password: string
): Promise<CryptoKey> {
  if (!vaultFile.password) {
    throw new Error('No password configured for this vault');
  }

  const { kdf, encryptedDEK } = vaultFile.password;

  // Derive KEK from password
  const keyMaterial = await deriveKeyFromPassword(password, kdf.salt, kdf);
  const kek = await importKEK(keyMaterial);

  // Unwrap DEK
  try {
    return await unwrapDEK(encryptedDEK, kek);
  } catch {
    throw new Error('Incorrect password');
  }
}

/**
 * Unlock vault with passkey
 *
 * @param vaultFile - Vault file to unlock
 * @param credentialId - Optional specific credential ID (uses any if not provided)
 * @returns Decrypted DEK and credential ID used
 */
export async function unlockVaultWithPasskey(
  vaultFile: VaultFile,
  credentialId?: string
): Promise<{ dek: CryptoKey; credentialId: string }> {
  if (vaultFile.passkeys.length === 0) {
    throw new Error('No passkeys registered');
  }

  let passkey: PasskeyEntry | undefined;
  let prfOutput: ArrayBuffer;

  if (credentialId) {
    // Use specific passkey
    passkey = vaultFile.passkeys.find(p => p.credentialId === credentialId);
    if (!passkey) {
      throw new Error('Passkey not found');
    }

    const result = await authenticateWithPasskey(passkey.credentialId, passkey.prfSalt);
    prfOutput = result.prfOutput;
  } else {
    // Let user choose from registered passkeys
    // Note: This will prompt for each until one succeeds
    // In practice, Windows Hello shows a picker
    for (const p of vaultFile.passkeys) {
      try {
        const result = await authenticateWithPasskey(p.credentialId, p.prfSalt);
        passkey = p;
        prfOutput = result.prfOutput;
        break;
      } catch {
        // Try next passkey
        continue;
      }
    }

    if (!passkey || !prfOutput!) {
      throw new Error('No valid passkey found');
    }
  }

  // Derive KEK from PRF output
  const kek = await deriveKEKFromPRF(prfOutput!, base64ToUint8Array(passkey.prfSalt));

  // Unwrap DEK
  try {
    const dek = await unwrapDEK(passkey.encryptedDEK, kek);
    return { dek, credentialId: passkey.credentialId };
  } catch {
    throw new Error('Failed to unlock with passkey');
  }
}

/**
 * Unlock vault with backup code
 *
 * @param vaultFile - Vault file to unlock
 * @param code - Backup code
 * @returns Decrypted DEK and updated vault file with code marked as used
 */
export async function unlockVaultWithBackupCode(
  vaultFile: VaultFile,
  code: string
): Promise<{ dek: CryptoKey; vaultFile: VaultFile }> {
  // Find matching backup code
  const matchingEntry = await findMatchingBackupCode(code, vaultFile.backupCodes);

  if (!matchingEntry) {
    throw new Error('Invalid backup code');
  }

  if (matchingEntry.used) {
    throw new Error('This backup code has already been used');
  }

  // Get backup code salt from the first entry (they all share the same salt derivation)
  // Actually, we derive KEK directly from the code
  const backupCodeSalt = generateRandomBytes(32); // This should be stored, but for simplicity we re-derive
  const kek = await deriveKEKFromBackupCode(code, backupCodeSalt);

  // Try to unwrap - if it fails, the salt was wrong
  // Better approach: store salt in vault or derive from code hash
  // For now, we use the code's hash as a seed for salt derivation
  const saltFromHash = base64ToUint8Array(matchingEntry.hash);
  const properKEK = await deriveKEKFromBackupCode(code, saltFromHash);

  let dek: CryptoKey;
  try {
    dek = await unwrapDEK(matchingEntry.encryptedDEK, properKEK);
  } catch {
    throw new Error('Failed to unlock with backup code');
  }

  // Mark code as used
  const updatedVaultFile: VaultFile = {
    ...vaultFile,
    backupCodes: vaultFile.backupCodes.map(bc =>
      bc.id === matchingEntry.id
        ? { ...bc, used: true, usedAt: new Date().toISOString() }
        : bc
    ),
    updatedAt: new Date().toISOString(),
  };

  return { dek, vaultFile: updatedVaultFile };
}

// ============================================================================
// Secrets Encryption/Decryption
// ============================================================================

/**
 * Encrypt secrets with DEK
 */
export async function encryptSecrets(
  dek: CryptoKey,
  secrets: SecretsData
): Promise<EncryptedBlob> {
  const json = JSON.stringify(secrets);
  const data = new TextEncoder().encode(json);
  return encrypt(dek, data);
}

/**
 * Decrypt secrets with DEK
 */
export async function decryptSecrets(
  dek: CryptoKey,
  encryptedSecrets: EncryptedBlob
): Promise<Secret[]> {
  const data = await decrypt(dek, encryptedSecrets);
  const json = new TextDecoder().decode(data);
  let secretsData: SecretsData;
  try {
    secretsData = JSON.parse(json);
  } catch {
    throw new Error('Vault data is corrupted or the password is incorrect');
  }
  return secretsData.secrets;
}

// ============================================================================
// Password Management
// ============================================================================

/**
 * Change vault password
 *
 * @param vaultFile - Current vault file
 * @param dek - Decrypted DEK (vault must be unlocked)
 * @param newPassword - New password
 * @returns Updated vault file
 */
export async function changeVaultPassword(
  vaultFile: VaultFile,
  dek: CryptoKey,
  newPassword: string
): Promise<VaultFile> {
  // Create new Argon2 parameters
  const argon2Params = createArgon2Params();

  // Derive new KEK
  const keyMaterial = await deriveKeyFromPassword(
    newPassword,
    argon2Params.salt,
    argon2Params
  );
  const newKEK = await importKEK(keyMaterial);

  // Wrap DEK with new KEK
  const encryptedDEK = await wrapDEK(dek, newKEK);

  return {
    ...vaultFile,
    password: {
      kdf: argon2Params,
      encryptedDEK,
    },
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Backup Code Regeneration
// ============================================================================

/**
 * Regenerate backup codes
 *
 * Invalidates all existing backup codes and creates new ones.
 *
 * @param vaultFile - Current vault file
 * @param dek - Decrypted DEK (vault must be unlocked)
 * @returns Updated vault file and new backup codes
 */
export async function regenerateBackupCodes(
  vaultFile: VaultFile,
  dek: CryptoKey
): Promise<{ vaultFile: VaultFile; backupCodes: string[] }> {
  // Generate new backup codes
  const backupCodes = generateBackupCodes();
  const backupCodeEntries: BackupCodeEntry[] = [];

  for (let i = 0; i < backupCodes.length; i++) {
    const code = backupCodes[i];
    const hash = await hashBackupCode(code);

    // Use hash as salt seed for consistency
    const saltFromHash = base64ToUint8Array(hash);
    const codeKEK = await deriveKEKFromBackupCode(code, saltFromHash);
    const encryptedDEK = await wrapDEK(dek, codeKEK);

    backupCodeEntries.push({
      id: i + 1,
      hash,
      encryptedDEK,
      used: false,
    });
  }

  return {
    vaultFile: {
      ...vaultFile,
      backupCodes: backupCodeEntries,
      updatedAt: new Date().toISOString(),
    },
    backupCodes,
  };
}

// ============================================================================
// Secret Management
// ============================================================================

/**
 * Add a new secret to the vault
 */
export async function addSecret(
  vaultFile: VaultFile,
  dek: CryptoKey,
  secret: Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>
): Promise<VaultFile> {
  // Decrypt current secrets
  const secrets = await decryptSecrets(dek, vaultFile.secrets);

  // Create new secret
  const now = new Date().toISOString();
  const newSecret: Secret = {
    ...secret,
    id: generateUUID(),
    createdAt: now,
    updatedAt: now,
  };

  // Add to list and re-encrypt
  const updatedSecrets = [...secrets, newSecret];
  const encryptedSecrets = await encryptSecrets(dek, { secrets: updatedSecrets });

  return {
    ...vaultFile,
    secrets: encryptedSecrets,
    updatedAt: now,
  };
}

/**
 * Add multiple secrets to the vault in a single atomic operation
 * This prevents race conditions when importing many secrets at once
 */
export async function addSecretsBulk(
  vaultFile: VaultFile,
  dek: CryptoKey,
  newSecrets: Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>[]
): Promise<VaultFile> {
  // Decrypt current secrets once
  const existingSecrets = await decryptSecrets(dek, vaultFile.secrets);

  // Create all new secrets with IDs and timestamps
  const now = new Date().toISOString();
  const secretsToAdd: Secret[] = newSecrets.map(secret => ({
    ...secret,
    id: generateUUID(),
    createdAt: now,
    updatedAt: now,
  }));

  // Combine and re-encrypt once
  const updatedSecrets = [...existingSecrets, ...secretsToAdd];
  const encryptedSecrets = await encryptSecrets(dek, { secrets: updatedSecrets });

  return {
    ...vaultFile,
    secrets: encryptedSecrets,
    updatedAt: now,
  };
}

/**
 * Update an existing secret
 */
export async function updateSecret(
  vaultFile: VaultFile,
  dek: CryptoKey,
  secretId: string,
  updates: Partial<Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<VaultFile> {
  // Decrypt current secrets
  const secrets = await decryptSecrets(dek, vaultFile.secrets);

  // Find and update secret
  const now = new Date().toISOString();
  const updatedSecrets = secrets.map(s =>
    s.id === secretId
      ? { ...s, ...updates, updatedAt: now }
      : s
  );

  // Re-encrypt
  const encryptedSecrets = await encryptSecrets(dek, { secrets: updatedSecrets });

  return {
    ...vaultFile,
    secrets: encryptedSecrets,
    updatedAt: now,
  };
}

/**
 * Delete a secret
 */
export async function deleteSecret(
  vaultFile: VaultFile,
  dek: CryptoKey,
  secretId: string
): Promise<VaultFile> {
  // Decrypt current secrets
  const secrets = await decryptSecrets(dek, vaultFile.secrets);

  // Remove secret
  const updatedSecrets = secrets.filter(s => s.id !== secretId);

  // Re-encrypt
  const now = new Date().toISOString();
  const encryptedSecrets = await encryptSecrets(dek, { secrets: updatedSecrets });

  return {
    ...vaultFile,
    secrets: encryptedSecrets,
    updatedAt: now,
  };
}
