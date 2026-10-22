/**
 * DevFlow Vault Type Definitions
 *
 * Secure secrets vault with three unlock methods:
 * 1. Windows Hello Passkey (WebAuthn PRF)
 * 2. Password (Argon2id)
 * 3. One-time Backup Codes
 */

// ============================================================================
// Encrypted Data Structures
// ============================================================================

/**
 * Encrypted blob using AES-256-GCM
 * IV is 12 bytes (96 bits) for GCM
 * Tag is included in ciphertext by Web Crypto API
 */
export interface EncryptedBlob {
  iv: string;         // Base64 encoded 12 bytes
  ciphertext: string; // Base64 encoded (includes auth tag)
}

// ============================================================================
// Passkey (WebAuthn PRF)
// ============================================================================

export interface PasskeyEntry {
  id: string;           // Unique identifier (UUID)
  deviceName: string;   // User-friendly device name
  credentialId: string; // Base64 encoded credential ID
  publicKey: string;    // Base64 encoded public key (for verification)
  prfSalt: string;      // Base64 encoded 32-byte salt for PRF
  encryptedDEK: EncryptedBlob;
  createdAt: string;    // ISO 8601 timestamp
  lastUsed?: string;    // ISO 8601 timestamp
}

// ============================================================================
// Password (Argon2id)
// ============================================================================

export interface Argon2Params {
  algorithm: 'argon2id';
  salt: string;       // Base64 encoded 32 bytes
  iterations: number; // Time cost (e.g., 4)
  memory: number;     // Memory in KiB (e.g., 131072 = 128MB)
  parallelism: number; // Parallel lanes (e.g., 4)
}

export interface PasswordConfig {
  kdf: Argon2Params;
  encryptedDEK: EncryptedBlob;
}

// ============================================================================
// Backup Codes
// ============================================================================

export interface BackupCodeEntry {
  id: number;             // Code number (1-10)
  hash: string;           // SHA-256 hash of the code
  encryptedDEK: EncryptedBlob;
  used: boolean;
  usedAt?: string;        // ISO 8601 timestamp when used
}

// ============================================================================
// Vault File Structure (Stored on disk)
// ============================================================================

export interface VaultFile {
  version: 1;
  createdAt: string;      // ISO 8601 timestamp
  updatedAt: string;      // ISO 8601 timestamp
  passkeys: PasskeyEntry[];
  password: PasswordConfig | null;
  backupCodes: BackupCodeEntry[];
  secrets: EncryptedBlob;
}

// ============================================================================
// Decrypted Secret Entry
// ============================================================================

/**
 * Secret type determines how the value is stored and synced:
 * - 'text': Simple string value, exported as environment variable
 * - 'json': JSON content, written to ~/.secrets.d/ as file, env var points to path
 */
export type SecretType = 'text' | 'json';

export interface Secret {
  id: string;           // UUID
  name: string;         // Display name (e.g., "GitHub API Key")
  value: string;        // The actual secret value (or JSON string for json type)
  type?: SecretType;    // Secret type (defaults to 'text' for backwards compat)
  category?: string;    // Optional category (e.g., "API Keys", "Databases", "OAuth")
  url?: string;         // Optional associated URL
  payloadUrl?: string;   // Optional webhook payload URL
  score?: string;       // Optional plain-text scope / score notes
  username?: string;    // Optional username
  notes?: string;       // Optional notes
  clientId?: string;    // OAuth Client ID (used when category is "OAuth")
  clientSecret?: string; // OAuth Client Secret (used when category is "OAuth")
  createdAt: string;    // ISO 8601 timestamp
  updatedAt: string;    // ISO 8601 timestamp
}

export interface SecretsData {
  secrets: Secret[];
}

// ============================================================================
// Vault Context State
// ============================================================================

export type VaultStatus =
  | 'loading'        // Initial load, checking if vault exists
  | 'setup-required' // No vault exists, need first-time setup
  | 'locked'         // Vault exists but not unlocked
  | 'unlocked';      // Vault unlocked, secrets available

export type UnlockMethod = 'passkey' | 'password' | 'backup-code';

export interface VaultState {
  status: VaultStatus;
  secrets: Secret[];
  passkeys: Array<{
    id: string;
    deviceName: string;
    createdAt: string;
    lastUsed?: string;
  }>;
  hasPassword: boolean;
  remainingBackupCodes: number;
  totalBackupCodes: number;
  error: string | null;
  isProcessing: boolean;
}

// ============================================================================
// Vault Context Actions
// ============================================================================

export interface VaultActions {
  // Unlock methods
  unlockWithPasskey: (credentialId?: string) => Promise<void>;
  unlockWithPassword: (password: string) => Promise<void>;
  unlockWithBackupCode: (code: string) => Promise<void>;

  // Lock
  lock: () => void;

  // First-time setup
  setupVault: (password: string) => Promise<{ backupCodes: string[] }>;
  registerPasskey: (deviceName: string) => Promise<void>;

  // Secret management
  addSecret: (secret: Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  addSecretsBulk: (secrets: Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>[]) => Promise<void>;
  updateSecret: (id: string, updates: Partial<Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>;
  deleteSecret: (id: string) => Promise<void>;

  // Settings
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  addPasskey: (deviceName: string) => Promise<void>;
  removePasskey: (id: string) => Promise<void>;
  regenerateBackupCodes: (password: string) => Promise<string[]>;

  // Utilities
  clearError: () => void;
  checkWebAuthnSupport: () => Promise<{ supported: boolean; prfSupported: boolean }>;
}

export type VaultContextType = VaultState & VaultActions;

// ============================================================================
// WebAuthn Types
// ============================================================================

export interface WebAuthnRegistrationResult {
  credentialId: string;
  publicKey: string;
  prfOutput: ArrayBuffer;
}

export interface WebAuthnAuthenticationResult {
  credentialId: string;
  prfOutput: ArrayBuffer;
}

// ============================================================================
// API Types
// ============================================================================

export interface VaultApiResponse {
  success: boolean;
  error?: string;
  vault?: VaultFile;
}
