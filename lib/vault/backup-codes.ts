/**
 * DevFlow Vault Backup Codes
 *
 * One-time use backup codes for emergency vault access.
 * Each code can decrypt the vault DEK once, then is marked as used.
 */

import {
  generateRandomBytes,
  arrayBufferToBase64,
  sha256,
  deriveKEK,
  base64ToUint8Array,
} from './crypto';
import { PRODUCT_NAME } from '@/lib/brand';

// ============================================================================
// Constants
// ============================================================================

// Number of backup codes to generate
export const BACKUP_CODE_COUNT = 10;

// Code format: XXXX-XXXX-XXXX (12 alphanumeric chars + 2 dashes)
const CODE_SEGMENT_LENGTH = 4;
const CODE_SEGMENTS = 3;

// Characters for code generation (avoiding ambiguous chars like 0/O, 1/I/l)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ============================================================================
// Code Generation
// ============================================================================

/**
 * Generate a single backup code in XXXX-XXXX-XXXX format
 */
function generateSingleCode(): string {
  const segments: string[] = [];

  for (let s = 0; s < CODE_SEGMENTS; s++) {
    let segment = '';
    const randomBytes = generateRandomBytes(CODE_SEGMENT_LENGTH);

    for (let i = 0; i < CODE_SEGMENT_LENGTH; i++) {
      const index = randomBytes[i] % CODE_CHARS.length;
      segment += CODE_CHARS[index];
    }

    segments.push(segment);
  }

  return segments.join('-');
}

/**
 * Generate a set of backup codes
 *
 * @param count - Number of codes to generate (default 10)
 * @returns Array of backup codes
 */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  const usedCodes = new Set<string>();

  while (codes.length < count) {
    const code = generateSingleCode();

    // Ensure uniqueness
    if (!usedCodes.has(code)) {
      usedCodes.add(code);
      codes.push(code);
    }
  }

  return codes;
}

// ============================================================================
// Code Hashing and Verification
// ============================================================================

/**
 * Hash a backup code for storage
 *
 * We hash codes so they can't be recovered from the vault file.
 *
 * @param code - Backup code in XXXX-XXXX-XXXX format
 * @returns Base64 encoded SHA-256 hash
 */
export async function hashBackupCode(code: string): Promise<string> {
  // Normalize: uppercase, remove dashes
  const normalized = normalizeCode(code);
  return sha256(normalized);
}

/**
 * Verify a backup code against a stored hash
 *
 * @param code - User-provided backup code
 * @param hash - Stored hash to compare against
 * @returns True if code matches hash
 */
export async function verifyBackupCode(
  code: string,
  hash: string
): Promise<boolean> {
  const codeHash = await hashBackupCode(code);
  return codeHash === hash;
}

/**
 * Normalize a backup code for consistent hashing
 * - Uppercase
 * - Remove dashes and spaces
 * - Trim whitespace
 */
export function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[-\s]/g, '')
    .trim();
}

/**
 * Validate backup code format
 *
 * @param code - Code to validate
 * @returns True if format is valid
 */
export function isValidCodeFormat(code: string): boolean {
  const normalized = normalizeCode(code);

  // Should be 12 alphanumeric characters
  if (normalized.length !== CODE_SEGMENT_LENGTH * CODE_SEGMENTS) {
    return false;
  }

  // Should only contain valid characters
  return [...normalized].every(char => CODE_CHARS.includes(char));
}

// ============================================================================
// Key Derivation from Backup Code
// ============================================================================

/**
 * Derive a KEK from a backup code
 *
 * Each backup code can be used to derive a unique key.
 *
 * @param code - Backup code
 * @param salt - Salt for key derivation (stored with vault)
 * @returns KEK as CryptoKey
 */
export async function deriveKEKFromBackupCode(
  code: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const normalized = normalizeCode(code);

  // Use the code as key material
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(normalized);

  return deriveKEK(keyMaterial.buffer as ArrayBuffer, salt, 'devflow-vault-backup-code');
}

/**
 * Generate salt for backup code KEK derivation
 */
export function generateBackupCodeSalt(): string {
  const salt = generateRandomBytes(32);
  return arrayBufferToBase64(salt.buffer as ArrayBuffer);
}

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format a normalized code back to XXXX-XXXX-XXXX format
 */
export function formatCode(code: string): string {
  const normalized = normalizeCode(code);
  const segments: string[] = [];

  for (let i = 0; i < normalized.length; i += CODE_SEGMENT_LENGTH) {
    segments.push(normalized.slice(i, i + CODE_SEGMENT_LENGTH));
  }

  return segments.join('-');
}

/**
 * Format codes for display/download as text
 */
export function formatCodesForExport(codes: string[]): string {
  const header = `${PRODUCT_NAME} Vault Backup Codes`;
  const warning = 'WARNING: Each code can only be used once!';
  const separator = '─'.repeat(40);

  const lines = [
    header,
    separator,
    warning,
    separator,
    '',
    ...codes.map((code, i) => `${String(i + 1).padStart(2, ' ')}. ${code}`),
    '',
    separator,
    `Generated: ${new Date().toISOString()}`,
    'Store these codes in a safe place.',
  ];

  return lines.join('\n');
}

/**
 * Find which backup code entry matches a given code
 *
 * @param code - User-provided backup code
 * @param entries - Array of backup code entries with hashes
 * @returns Matching entry or null
 */
export async function findMatchingBackupCode<T extends { hash: string }>(
  code: string,
  entries: T[]
): Promise<T | null> {
  const codeHash = await hashBackupCode(code);

  for (const entry of entries) {
    if (entry.hash === codeHash) {
      return entry;
    }
  }

  return null;
}
