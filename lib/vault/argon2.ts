/**
 * DevFlow Vault Argon2id Wrapper
 *
 * WASM-based Argon2id implementation for password hashing.
 * Uses hash-wasm for Next.js/Turbopack compatibility.
 * Targets ~750ms computation time for security.
 */

import { argon2id } from 'hash-wasm';
import type { Argon2Params } from './types';
import { generateRandomBytes, arrayBufferToBase64, base64ToUint8Array } from './crypto';

// ============================================================================
// Constants
// ============================================================================

// Default parameters targeting ~750ms on modern hardware
export const DEFAULT_ARGON2_PARAMS: Omit<Argon2Params, 'salt'> = {
  algorithm: 'argon2id',
  iterations: 4,        // Time cost
  memory: 131072,       // 128 MB in KiB
  parallelism: 4,       // 4 parallel lanes
};

// Output length in bytes (256 bits for AES-256)
const HASH_LENGTH = 32;

// Salt length in bytes
const SALT_LENGTH = 32;

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Derive a key from password using Argon2id
 *
 * @param password - User's password
 * @param salt - 32-byte salt (Base64 encoded)
 * @param params - Argon2 parameters (optional, uses defaults)
 * @returns Raw key material as ArrayBuffer (32 bytes / 256 bits)
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: string,
  params: Partial<Omit<Argon2Params, 'salt' | 'algorithm'>> = {}
): Promise<ArrayBuffer> {
  const mergedParams = { ...DEFAULT_ARGON2_PARAMS, ...params };
  const saltBytes = base64ToUint8Array(salt);

  const hashHex = await argon2id({
    password,
    salt: saltBytes,
    iterations: mergedParams.iterations,
    memorySize: mergedParams.memory, // in KiB
    hashLength: HASH_LENGTH,
    parallelism: mergedParams.parallelism,
    outputType: 'hex',
  });

  // Convert hex string to ArrayBuffer
  const bytes = new Uint8Array(hashHex.length / 2);
  for (let i = 0; i < hashHex.length; i += 2) {
    bytes[i / 2] = parseInt(hashHex.substring(i, i + 2), 16);
  }

  return bytes.buffer;
}

/**
 * Generate a new random salt for Argon2
 *
 * @returns Base64 encoded salt
 */
export function generateSalt(): string {
  const salt = generateRandomBytes(SALT_LENGTH);
  return arrayBufferToBase64(salt.buffer as ArrayBuffer);
}

/**
 * Create full Argon2 parameters with a new salt
 */
export function createArgon2Params(
  overrides: Partial<Omit<Argon2Params, 'algorithm'>> = {}
): Argon2Params {
  return {
    algorithm: 'argon2id',
    salt: overrides.salt || generateSalt(),
    iterations: overrides.iterations || DEFAULT_ARGON2_PARAMS.iterations,
    memory: overrides.memory || DEFAULT_ARGON2_PARAMS.memory,
    parallelism: overrides.parallelism || DEFAULT_ARGON2_PARAMS.parallelism,
  };
}

// ============================================================================
// Parameter Calibration
// ============================================================================

/**
 * Calibrate Argon2 parameters for target computation time
 *
 * Runs a test hash and adjusts parameters to hit ~750ms.
 * Call this once during setup to optimize for the user's hardware.
 *
 * @param targetMs - Target computation time in milliseconds (default 750)
 * @returns Calibrated parameters
 */
export async function calibrateArgon2Params(
  targetMs: number = 750
): Promise<Omit<Argon2Params, 'salt'>> {
  const testPassword = 'calibration-test-password';
  const testSalt = generateSalt();

  // Start with baseline parameters
  let iterations = 2;
  let memory = 65536; // 64 MB

  // First, find a good memory setting at low iterations
  let elapsed = await measureHashTime(testPassword, testSalt, iterations, memory);

  // If too fast at 64MB, try 128MB
  if (elapsed < targetMs / 2 && memory < 262144) {
    memory = 131072; // 128 MB
    elapsed = await measureHashTime(testPassword, testSalt, iterations, memory);
  }

  // If still too fast, try 256MB
  if (elapsed < targetMs / 2 && memory < 262144) {
    memory = 262144; // 256 MB
    elapsed = await measureHashTime(testPassword, testSalt, iterations, memory);
  }

  // Now adjust iterations to hit target time
  const iterationsPerMs = iterations / elapsed;
  iterations = Math.max(2, Math.round(iterationsPerMs * targetMs));

  // Cap iterations at reasonable maximum
  iterations = Math.min(iterations, 20);

  // Verify the calibration
  elapsed = await measureHashTime(testPassword, testSalt, iterations, memory);

  // Fine-tune if needed
  if (elapsed < targetMs * 0.7) {
    iterations = Math.min(20, iterations + 1);
  } else if (elapsed > targetMs * 1.5) {
    iterations = Math.max(2, iterations - 1);
  }

  return {
    algorithm: 'argon2id',
    iterations,
    memory,
    parallelism: 4,
  };
}

/**
 * Measure time to compute an Argon2 hash
 */
async function measureHashTime(
  password: string,
  salt: string,
  iterations: number,
  memory: number
): Promise<number> {
  const start = performance.now();
  const saltBytes = base64ToUint8Array(salt);

  await argon2id({
    password,
    salt: saltBytes,
    iterations,
    memorySize: memory,
    hashLength: HASH_LENGTH,
    parallelism: 4,
    outputType: 'hex',
  });

  return performance.now() - start;
}

// ============================================================================
// Password Strength
// ============================================================================

export interface PasswordStrength {
  score: number;        // 0-4 (0 = very weak, 4 = very strong)
  feedback: string[];   // Suggestions for improvement
  isAcceptable: boolean; // Meets minimum requirements
}

/**
 * Evaluate password strength
 *
 * Simple strength check without external dependencies.
 * For production, consider using zxcvbn or similar.
 */
export function evaluatePasswordStrength(password: string): PasswordStrength {
  const feedback: string[] = [];
  let score = 0;

  // Length checks
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;

  if (password.length < 8) {
    feedback.push('Use at least 8 characters');
  } else if (password.length < 12) {
    feedback.push('Consider using 12+ characters for better security');
  }

  // Character variety
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);

  const varietyCount = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;

  if (varietyCount >= 3) score += 1;

  if (!hasLower && !hasUpper) {
    feedback.push('Add letters');
  }
  if (!hasDigit) {
    feedback.push('Add numbers');
  }
  if (!hasSpecial) {
    feedback.push('Add special characters');
  }

  // Common patterns to avoid
  const commonPatterns = [
    /^password/i,
    /^123456/,
    /^qwerty/i,
    /(.)\1{3,}/, // Repeated characters
  ];

  for (const pattern of commonPatterns) {
    if (pattern.test(password)) {
      score = Math.max(0, score - 1);
      feedback.push('Avoid common patterns');
      break;
    }
  }

  // Cap score at 4
  score = Math.min(4, score);

  return {
    score,
    feedback,
    isAcceptable: score >= 2 && password.length >= 8,
  };
}

/**
 * Get strength label from score
 */
export function getStrengthLabel(score: number): string {
  switch (score) {
    case 0: return 'Very Weak';
    case 1: return 'Weak';
    case 2: return 'Fair';
    case 3: return 'Strong';
    case 4: return 'Very Strong';
    default: return 'Unknown';
  }
}

/**
 * Get strength color for UI
 */
export function getStrengthColor(score: number): string {
  switch (score) {
    case 0: return 'var(--error)';
    case 1: return 'var(--error)';
    case 2: return 'var(--warning)';
    case 3: return 'var(--success)';
    case 4: return 'var(--success)';
    default: return 'var(--muted)';
  }
}
