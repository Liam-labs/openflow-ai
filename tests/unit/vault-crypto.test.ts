/**
 * Vault crypto module — high-value test kickoff (Sprint overnight T9)
 *
 * Covers: encrypt/decrypt round-trip, wrong-key rejection, DEK uniqueness,
 * DEK wrap/unwrap, backup code hash/verify, concurrent encrypt safety.
 *
 * Uses Node 20 native Web Crypto — no polyfills needed.
 */

import { describe, it, expect } from 'vitest';
import {
  generateDEK,
  exportDEK,
  importDEK,
  encrypt,
  decrypt,
  encryptString,
  decryptString,
  wrapDEK,
  unwrapDEK,
  generateRandomBytes,
  arrayBufferToBase64,
  importKEK,
} from '@/lib/vault/crypto';
import {
  generateBackupCodes,
  hashBackupCode,
  verifyBackupCode,
  isValidCodeFormat,
  normalizeCode,
} from '@/lib/vault/backup-codes';

// ─── Encrypt / Decrypt ───────────────────────────────────────────────────────

describe('encrypt / decrypt', () => {
  it('round-trip: decrypting encrypted plaintext returns the original bytes', async () => {
    const key = await generateDEK();
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);

    const blob = await encrypt(key, plaintext);
    const recovered = await decrypt(key, blob);

    expect(recovered).toEqual(plaintext);
  });

  it('encryptString / decryptString round-trip preserves arbitrary unicode', async () => {
    const key = await generateDEK();
    const original = 'Hello, 世界! 🔑 café résumé naïve';

    const blob = await encryptString(key, original);
    const recovered = await decryptString(key, blob);

    expect(recovered).toBe(original);
  });

  it('decrypt with wrong key throws (GCM authentication tag mismatch)', async () => {
    const key = await generateDEK();
    const wrongKey = await generateDEK();
    const blob = await encryptString(key, 'secret');

    await expect(decryptString(wrongKey, blob)).rejects.toThrow();
  });

  it('each encrypt call produces a unique ciphertext (unique IV per call)', async () => {
    const key = await generateDEK();
    const text = 'same plaintext';

    const blob1 = await encryptString(key, text);
    const blob2 = await encryptString(key, text);

    // Same plaintext encrypted twice must produce different IVs and ciphertexts
    expect(blob1.iv).not.toBe(blob2.iv);
    expect(blob1.ciphertext).not.toBe(blob2.ciphertext);
  });
});

// ─── DEK Generation ──────────────────────────────────────────────────────────

describe('generateDEK', () => {
  it('produces distinct keys on successive calls', async () => {
    const dek1 = await generateDEK();
    const dek2 = await generateDEK();

    const raw1 = await exportDEK(dek1);
    const raw2 = await exportDEK(dek2);

    expect(arrayBufferToBase64(raw1)).not.toBe(arrayBufferToBase64(raw2));
  });

  it('exported then re-imported DEK decrypts ciphertext correctly', async () => {
    const dek = await generateDEK();
    const blob = await encryptString(dek, 'test value');

    const rawBytes = await exportDEK(dek);
    const reimported = await importDEK(rawBytes);

    const recovered = await decryptString(reimported, blob);
    expect(recovered).toBe('test value');
  });
});

// ─── DEK Wrap / Unwrap (Key Rotation) ────────────────────────────────────────

describe('wrapDEK / unwrapDEK', () => {
  async function makeKEK(): Promise<CryptoKey> {
    // Build a raw 256-bit key and import it as a KEK
    const raw = generateRandomBytes(32);
    return importKEK(raw.buffer as ArrayBuffer);
  }

  it('unwrap with the same KEK recovers the original DEK', async () => {
    const dek = await generateDEK();
    const kek = await makeKEK();

    const wrapped = await wrapDEK(dek, kek);
    const recovered = await unwrapDEK(wrapped, kek);

    // Verify recovered DEK by using it to decrypt a blob produced by the original
    const blob = await encryptString(dek, 'rotation test');
    const text = await decryptString(recovered, blob);
    expect(text).toBe('rotation test');
  });

  it('key rotation: re-wrapping DEK with new KEK does not corrupt prior records', async () => {
    const dek = await generateDEK();
    const oldKEK = await makeKEK();
    const newKEK = await makeKEK();

    // Encrypt a record with the original DEK before rotation
    const blob = await encryptString(dek, 'prior record');

    // Simulate key rotation: unwrap DEK with old KEK, re-wrap with new KEK
    const wrapped1 = await wrapDEK(dek, oldKEK);
    const unwrapped = await unwrapDEK(wrapped1, oldKEK);
    const wrapped2 = await wrapDEK(unwrapped, newKEK);

    // Unwrap with the new KEK and verify prior record is still readable
    const rotatedDEK = await unwrapDEK(wrapped2, newKEK);
    const recovered = await decryptString(rotatedDEK, blob);
    expect(recovered).toBe('prior record');
  });

  it('unwrap with wrong KEK throws', async () => {
    const dek = await generateDEK();
    const kek = await makeKEK();
    const wrongKEK = await makeKEK();

    const wrapped = await wrapDEK(dek, kek);
    await expect(unwrapDEK(wrapped, wrongKEK)).rejects.toThrow();
  });
});

// ─── Backup Codes ────────────────────────────────────────────────────────────

describe('backup codes', () => {
  it('generateBackupCodes returns 10 codes in XXXX-XXXX-XXXX format', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(isValidCodeFormat(code)).toBe(true);
    }
  });

  it('hashBackupCode + verifyBackupCode round-trip', async () => {
    const [code] = generateBackupCodes();
    const hash = await hashBackupCode(code);

    expect(await verifyBackupCode(code, hash)).toBe(true);
  });

  it('verifyBackupCode rejects wrong code', async () => {
    const [code] = generateBackupCodes();
    const hash = await hashBackupCode(code);
    const [otherCode] = generateBackupCodes();

    expect(await verifyBackupCode(otherCode, hash)).toBe(false);
  });

  it('normalizeCode strips dashes and uppercases for consistent hashing', () => {
    expect(normalizeCode('abcd-efgh-ijkl')).toBe('ABCDEFGHIJKL');
    expect(normalizeCode('ABCD-EFGH-IJKL')).toBe('ABCDEFGHIJKL');
  });

  it('same code with different formatting hashes identically', async () => {
    const raw = 'ABCD-EFGH-1234';
    const withDashes = await hashBackupCode('ABCD-EFGH-1234');
    const noDashes = await hashBackupCode('abcdefgh1234');
    expect(withDashes).toBe(noDashes);
  });
});

// ─── Concurrency ─────────────────────────────────────────────────────────────

describe('concurrent encrypt safety', () => {
  it('10 concurrent encrypt calls all succeed and produce distinct ciphertexts', async () => {
    const key = await generateDEK();
    const plaintext = 'concurrent test payload';

    const blobs = await Promise.all(
      Array.from({ length: 10 }, () => encryptString(key, plaintext))
    );

    // All must succeed (no throws)
    expect(blobs).toHaveLength(10);

    // All IVs must be unique (each call generates fresh random IV)
    const ivs = new Set(blobs.map(b => b.iv));
    expect(ivs.size).toBe(10);

    // All must decrypt correctly
    const recovered = await Promise.all(blobs.map(b => decryptString(key, b)));
    expect(recovered.every(t => t === plaintext)).toBe(true);
  });
});
