/**
 * DevFlow Vault Crypto Utilities
 *
 * Web Crypto API utilities for AES-256-GCM encryption/decryption
 * and key derivation using HKDF.
 */

import type { EncryptedBlob } from './types';

// ============================================================================
// Constants
// ============================================================================

const AES_KEY_LENGTH = 256;
const AES_IV_LENGTH = 12; // 96 bits for GCM
const HKDF_HASH = 'SHA-256';

// ============================================================================
// Type Helpers
// ============================================================================

/**
 * Convert Uint8Array to BufferSource for Web Crypto API
 * Uses type assertion to satisfy strict TypeScript typing
 */
function toBufferSource(arr: Uint8Array): BufferSource {
  // Create a fresh ArrayBuffer copy and cast to BufferSource
  const buffer = new ArrayBuffer(arr.byteLength);
  const result = new Uint8Array(buffer);
  result.set(arr);
  return result as unknown as BufferSource;
}

// ============================================================================
// Random Bytes Generation
// ============================================================================

/**
 * Generate cryptographically secure random bytes
 */
export function generateRandomBytes(length: number): Uint8Array {
  const buffer = new ArrayBuffer(length);
  const arr = new Uint8Array(buffer);
  crypto.getRandomValues(arr);
  return arr;
}

/**
 * Generate a UUID v4
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

// ============================================================================
// Base64 Encoding/Decoding
// ============================================================================

/**
 * Convert ArrayBuffer to Base64 string
 */
export function arrayBufferToBase64(buffer: ArrayBuffer | ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer as ArrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert Base64 string to ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return buffer;
}

/**
 * Convert Base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const buffer = base64ToArrayBuffer(base64);
  return new Uint8Array(buffer);
}

// ============================================================================
// DEK (Data Encryption Key) Operations
// ============================================================================

/**
 * Generate a new Data Encryption Key (DEK)
 * This is the key that encrypts the actual secrets
 */
export async function generateDEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    true, // extractable - needed to encrypt with KEK
    ['encrypt', 'decrypt']
  );
}

/**
 * Export DEK to raw bytes for encryption with KEK
 */
export async function exportDEK(dek: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.exportKey('raw', dek);
}

/**
 * Import DEK from raw bytes
 */
export async function importDEK(rawKey: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    true, // extractable
    ['encrypt', 'decrypt']
  );
}

// ============================================================================
// KEK (Key Encryption Key) Operations
// ============================================================================

/**
 * Derive a Key Encryption Key (KEK) from raw key material using HKDF
 *
 * @param keyMaterial - Raw key material (from password/passkey/backup code)
 * @param salt - Salt for HKDF (stored with vault)
 * @param info - Context info string (e.g., "devflow-vault-kek")
 */
export async function deriveKEK(
  keyMaterial: ArrayBuffer,
  salt: Uint8Array,
  info: string = 'devflow-vault-kek'
): Promise<CryptoKey> {
  // Import key material as HKDF base key
  const baseKey = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );

  // Derive KEK using HKDF
  const infoBytes = new TextEncoder().encode(info);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: HKDF_HASH,
      salt: toBufferSource(salt),
      info: toBufferSource(new Uint8Array(infoBytes)),
    },
    baseKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false, // not extractable
    ['wrapKey', 'unwrapKey']
  );
}

/**
 * Import raw key material directly as a KEK
 * Used when the key material is already 256 bits (e.g., from Argon2)
 */
export async function importKEK(rawKey: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

// ============================================================================
// AES-256-GCM Encryption/Decryption
// ============================================================================

/**
 * Encrypt data using AES-256-GCM
 *
 * @param key - CryptoKey for encryption
 * @param plaintext - Data to encrypt
 * @returns EncryptedBlob with IV and ciphertext (includes auth tag)
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array
): Promise<EncryptedBlob> {
  const iv = generateRandomBytes(AES_IV_LENGTH);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    toBufferSource(plaintext)
  );

  return {
    iv: arrayBufferToBase64(iv.buffer),
    ciphertext: arrayBufferToBase64(ciphertext),
  };
}

/**
 * Decrypt data using AES-256-GCM
 *
 * @param key - CryptoKey for decryption
 * @param blob - EncryptedBlob with IV and ciphertext
 * @returns Decrypted data as Uint8Array
 */
export async function decrypt(
  key: CryptoKey,
  blob: EncryptedBlob
): Promise<Uint8Array> {
  const iv = base64ToUint8Array(blob.iv);
  const ciphertext = base64ToArrayBuffer(blob.ciphertext);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    ciphertext
  );

  return new Uint8Array(plaintext);
}

/**
 * Encrypt a string and return EncryptedBlob
 */
export async function encryptString(
  key: CryptoKey,
  plaintext: string
): Promise<EncryptedBlob> {
  const data = new TextEncoder().encode(plaintext);
  return encrypt(key, new Uint8Array(data));
}

/**
 * Decrypt EncryptedBlob and return string
 */
export async function decryptString(
  key: CryptoKey,
  blob: EncryptedBlob
): Promise<string> {
  const data = await decrypt(key, blob);
  return new TextDecoder().decode(data);
}

// ============================================================================
// Key Wrapping (Encrypt DEK with KEK)
// ============================================================================

/**
 * Wrap (encrypt) DEK with KEK
 *
 * @param dek - Data Encryption Key to wrap
 * @param kek - Key Encryption Key to use
 * @returns EncryptedBlob containing the wrapped DEK
 */
export async function wrapDEK(
  dek: CryptoKey,
  kek: CryptoKey
): Promise<EncryptedBlob> {
  const iv = generateRandomBytes(AES_IV_LENGTH);

  const wrappedKey = await crypto.subtle.wrapKey(
    'raw',
    dek,
    kek,
    { name: 'AES-GCM', iv: toBufferSource(iv) }
  );

  return {
    iv: arrayBufferToBase64(iv.buffer),
    ciphertext: arrayBufferToBase64(wrappedKey),
  };
}

/**
 * Unwrap (decrypt) DEK using KEK
 *
 * @param wrappedDEK - EncryptedBlob containing the wrapped DEK
 * @param kek - Key Encryption Key to use
 * @returns Unwrapped DEK as CryptoKey
 */
export async function unwrapDEK(
  wrappedDEK: EncryptedBlob,
  kek: CryptoKey
): Promise<CryptoKey> {
  const iv = base64ToUint8Array(wrappedDEK.iv);
  const wrappedKey = base64ToArrayBuffer(wrappedDEK.ciphertext);

  return crypto.subtle.unwrapKey(
    'raw',
    wrappedKey,
    kek,
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    true, // extractable
    ['encrypt', 'decrypt']
  );
}

// ============================================================================
// Hashing
// ============================================================================

/**
 * Compute SHA-256 hash of data
 *
 * @param data - Data to hash (string or Uint8Array)
 * @returns Base64 encoded hash
 */
export async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data;

  const hash = await crypto.subtle.digest('SHA-256', toBufferSource(new Uint8Array(bytes)));
  return arrayBufferToBase64(hash);
}

// ============================================================================
// Memory Cleanup (Security)
// ============================================================================

/**
 * Overwrite a buffer with random data then zeros
 * Best effort to clear sensitive data from memory
 *
 * Note: JavaScript doesn't guarantee memory clearing, but this helps
 */
export function clearSensitiveBuffer(buffer: ArrayBuffer): void {
  const view = new Uint8Array(buffer);
  crypto.getRandomValues(view); // Overwrite with random data
  view.fill(0); // Then zero out
}

/**
 * Clear a string from memory (best effort)
 * Creates a new string to potentially allow GC of the original
 */
export function clearSensitiveString(str: string): string {
  // This is a hint to the GC, not a guarantee
  return '';
}
