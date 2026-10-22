/**
 * DevFlow Vault WebAuthn PRF Extension
 *
 * Uses Windows Hello (or other platform authenticators) with the PRF extension
 * to derive encryption keys from the TPM.
 */

import type { WebAuthnRegistrationResult, WebAuthnAuthenticationResult } from './types';
import {
  generateRandomBytes,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  base64ToUint8Array,
  deriveKEK,
} from './crypto';
import { PRODUCT_NAME } from '@/lib/brand';

// ============================================================================
// Types for WebAuthn PRF Extension
// ============================================================================

interface PRFExtensionInputs {
  first: ArrayBuffer;
  second?: ArrayBuffer;
}

interface PRFExtensionOutputs {
  first: ArrayBuffer;
  second?: ArrayBuffer;
}

interface PRFExtensionResults {
  enabled?: boolean;
  results?: PRFExtensionOutputs;
}

interface AuthenticatorExtensionResults {
  prf?: PRFExtensionResults;
}

// ============================================================================
// Constants
// ============================================================================

const RP_NAME = `${PRODUCT_NAME} Vault`;
const PRF_SALT_LENGTH = 32;

// ============================================================================
// Support Detection
// ============================================================================

/**
 * Check if WebAuthn is supported
 */
export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.PublicKeyCredential !== undefined &&
    typeof window.PublicKeyCredential === 'function'
  );
}

/**
 * Check if platform authenticator (Windows Hello) is available
 */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;

  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * Check if WebAuthn PRF extension is supported
 *
 * PRF support is required for key derivation.
 * This attempts a registration to check for PRF support.
 */
export async function isWebAuthnPRFSupported(): Promise<boolean> {
  if (!isWebAuthnSupported()) {
    console.log('[WebAuthn] WebAuthn not supported');
    return false;
  }

  // Feature detection based on browser
  const ua = navigator.userAgent;
  const isChrome = /Chrome\/(\d+)/.exec(ua);
  const isEdge = /Edg\/(\d+)/.exec(ua);

  console.log('[WebAuthn] PRF Support Check:', {
    userAgent: ua,
    chromeMatch: isChrome,
    edgeMatch: isEdge,
  });

  if (isChrome) {
    const version = parseInt(isChrome[1], 10);
    console.log('[WebAuthn] Chrome version:', version);
    if (version >= 109) {
      const platformAvailable = await isPlatformAuthenticatorAvailable();
      console.log('[WebAuthn] Platform authenticator available:', platformAvailable);
      return platformAvailable;
    }
  }

  if (isEdge) {
    const version = parseInt(isEdge[1], 10);
    console.log('[WebAuthn] Edge version:', version);
    if (version >= 109) {
      const platformAvailable = await isPlatformAuthenticatorAvailable();
      console.log('[WebAuthn] Platform authenticator available:', platformAvailable);
      return platformAvailable;
    }
  }

  // Firefox and Safari have limited/no PRF support as of early 2025
  console.log('[WebAuthn] Browser not supported for PRF');
  return false;
}

/**
 * Get detailed WebAuthn support info
 */
export async function getWebAuthnSupport(): Promise<{
  supported: boolean;
  platformAuthenticator: boolean;
  prfSupported: boolean;
}> {
  const supported = isWebAuthnSupported();
  const platformAuthenticator = await isPlatformAuthenticatorAvailable();
  const prfSupported = await isWebAuthnPRFSupported();

  return { supported, platformAuthenticator, prfSupported };
}

// ============================================================================
// PRF Salt Generation
// ============================================================================

/**
 * Generate a new PRF salt for a passkey
 */
export function generatePRFSalt(): string {
  const salt = generateRandomBytes(PRF_SALT_LENGTH);
  return arrayBufferToBase64(salt.buffer);
}

// ============================================================================
// Passkey Registration
// ============================================================================

/**
 * Register a new passkey with PRF extension
 *
 * This triggers Windows Hello to create a new credential.
 * We register first to check PRF support, then immediately authenticate
 * to get the actual PRF output (since PRF eval during registration
 * isn't universally supported).
 *
 * @param deviceName - User-friendly name for this device
 * @param prfSalt - Salt for PRF key derivation (Base64)
 * @returns Registration result with credential ID and PRF output
 */
export async function registerPasskey(
  deviceName: string,
  prfSalt: string
): Promise<WebAuthnRegistrationResult> {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn is not supported in this browser');
  }

  const challenge = generateRandomBytes(32);
  const userId = generateRandomBytes(16);

  // Create fresh ArrayBuffer copies for WebAuthn API compatibility
  const challengeBuffer = new ArrayBuffer(challenge.byteLength);
  new Uint8Array(challengeBuffer).set(challenge);
  const userIdBuffer = new ArrayBuffer(userId.byteLength);
  new Uint8Array(userIdBuffer).set(userId);

  const publicKeyCredentialCreationOptions: PublicKeyCredentialCreationOptions = {
    challenge: challengeBuffer,
    rp: {
      name: RP_NAME,
      id: window.location.hostname,
    },
    user: {
      id: userIdBuffer,
      name: deviceName,
      displayName: deviceName,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },   // ES256 (ECDSA with P-256)
      { type: 'public-key', alg: -257 }, // RS256 (RSASSA-PKCS1-v1_5)
    ],
    authenticatorSelection: {
      // Removed 'platform' restriction to allow any authenticator with PRF support
      userVerification: 'required',
      residentKey: 'preferred',
    },
    timeout: 60000,
    attestation: 'none', // We don't need attestation
    // During registration, just check if PRF is supported (no eval)
    extensions: {
      prf: {},
    } as AuthenticationExtensionsClientInputs,
  };

  let credential: PublicKeyCredential;

  try {
    credential = await navigator.credentials.create({
      publicKey: publicKeyCredentialCreationOptions,
    }) as PublicKeyCredential;
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError') {
        throw new Error('Passkey registration was cancelled or timed out');
      }
      if (error.name === 'InvalidStateError') {
        throw new Error('A passkey already exists for this device');
      }
    }
    throw error;
  }

  if (!credential) {
    throw new Error('Failed to create passkey');
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  const extensionResults = credential.getClientExtensionResults();

  // Verbose logging for debugging
  console.log('[WebAuthn] Registration successful');
  console.log('[WebAuthn] Credential ID:', arrayBufferToBase64(credential.rawId));
  console.log('[WebAuthn] Extension results (raw):', extensionResults);
  console.log('[WebAuthn] Extension results (JSON):', JSON.stringify(extensionResults, null, 2));
  console.log('[WebAuthn] PRF in results:', 'prf' in extensionResults);
  console.log('[WebAuthn] PRF value:', (extensionResults as AuthenticatorExtensionResults).prf);

  const prfResult = (extensionResults as AuthenticatorExtensionResults).prf;

  // Verbose logging of PRF object
  console.log('[WebAuthn] PRF result object:', prfResult);
  console.log('[WebAuthn] PRF keys:', prfResult ? Object.keys(prfResult) : 'null');
  console.log('[WebAuthn] PRF.enabled:', prfResult?.enabled);
  console.log('[WebAuthn] PRF.results:', prfResult?.results);

  // Check if PRF is enabled OR if we got results directly (some implementations differ)
  const prfEnabled = prfResult?.enabled;
  const prfHasResults = prfResult?.results?.first;

  console.log('[WebAuthn] PRF enabled?', prfEnabled);
  console.log('[WebAuthn] PRF has results?', !!prfHasResults);

  if (!prfEnabled && !prfHasResults) {
    console.error('[WebAuthn] PRF not available. Full extension results:', extensionResults);
    console.error('[WebAuthn] PRF object stringified:', JSON.stringify(prfResult, null, 2));
    throw new Error(
      'Your device does not support the PRF extension required for secure key derivation. ' +
      `PRF result: ${JSON.stringify(prfResult)}. Please use a password instead.`
    );
  }

  console.log('[WebAuthn] PRF is enabled, proceeding to authenticate for PRF output');

  // Get public key for storage
  const publicKey = response.getPublicKey();
  if (!publicKey) {
    throw new Error('Failed to get public key from credential');
  }

  const credentialId = arrayBufferToBase64(credential.rawId);

  // Now immediately authenticate to get the actual PRF output
  // PRF evaluation only works during authentication, not registration
  const authResult = await authenticateWithPasskey(credentialId, prfSalt);

  return {
    credentialId,
    publicKey: arrayBufferToBase64(publicKey),
    prfOutput: authResult.prfOutput,
  };
}

// ============================================================================
// Passkey Authentication
// ============================================================================

/**
 * Authenticate with a specific passkey
 *
 * @param credentialId - Base64 encoded credential ID
 * @param prfSalt - Base64 encoded PRF salt
 * @returns Authentication result with PRF output
 */
export async function authenticateWithPasskey(
  credentialId: string,
  prfSalt: string
): Promise<WebAuthnAuthenticationResult> {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn is not supported in this browser');
  }

  const challenge = generateRandomBytes(32);
  const prfSaltBytes = base64ToUint8Array(prfSalt);

  // Create fresh ArrayBuffer copies for WebAuthn API compatibility
  const challengeBuffer = new ArrayBuffer(challenge.byteLength);
  new Uint8Array(challengeBuffer).set(challenge);
  const prfSaltBuffer = new ArrayBuffer(prfSaltBytes.byteLength);
  new Uint8Array(prfSaltBuffer).set(prfSaltBytes);

  const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
    challenge: challengeBuffer,
    rpId: window.location.hostname,
    allowCredentials: [{
      type: 'public-key',
      id: base64ToArrayBuffer(credentialId),
      // Allow any transport - platform, usb, ble, nfc
    }],
    userVerification: 'required',
    timeout: 60000,
    extensions: {
      prf: {
        eval: {
          first: prfSaltBuffer,
        },
      },
    } as AuthenticationExtensionsClientInputs,
  };

  let credential: PublicKeyCredential;

  try {
    credential = await navigator.credentials.get({
      publicKey: publicKeyCredentialRequestOptions,
    }) as PublicKeyCredential;
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError') {
        throw new Error('Authentication was cancelled or timed out');
      }
      if (error.name === 'SecurityError') {
        throw new Error('Authentication failed due to a security error');
      }
    }
    throw error;
  }

  if (!credential) {
    throw new Error('Failed to authenticate with passkey');
  }

  const extensionResults = credential.getClientExtensionResults() as AuthenticatorExtensionResults;

  if (!extensionResults.prf?.results?.first) {
    throw new Error('PRF extension output not available');
  }

  return {
    credentialId: arrayBufferToBase64(credential.rawId),
    prfOutput: extensionResults.prf.results.first,
  };
}

/**
 * Authenticate with any registered passkey
 *
 * Shows a picker if multiple passkeys are registered.
 *
 * @param passkeys - Array of registered passkeys
 * @returns Authentication result with credential ID and PRF output
 */
export async function authenticateWithAnyPasskey(
  passkeys: Array<{ credentialId: string; prfSalt: string }>
): Promise<WebAuthnAuthenticationResult> {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn is not supported in this browser');
  }

  if (passkeys.length === 0) {
    throw new Error('No passkeys registered');
  }

  const challenge = generateRandomBytes(32);

  // Create fresh ArrayBuffer for WebAuthn API compatibility
  const challengeBuffer = new ArrayBuffer(challenge.byteLength);
  new Uint8Array(challengeBuffer).set(challenge);

  // For multiple passkeys, we need to try with each salt
  // WebAuthn will show a picker, but we don't know which one the user will choose
  // So we use the first passkey's salt and let Windows Hello handle the selection
  // Note: This is a limitation - all passkeys should use the same salt, or
  // we need to authenticate and then verify with the correct salt

  // Simplified approach: Use empty allowCredentials to let the authenticator
  // show all available credentials, then match the returned credential
  const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
    challenge: challengeBuffer,
    rpId: window.location.hostname,
    allowCredentials: passkeys.map(p => ({
      type: 'public-key' as const,
      id: base64ToArrayBuffer(p.credentialId),
      // Allow any transport
    })),
    userVerification: 'required',
    timeout: 60000,
    // We'll need to retry with the correct salt after identifying the credential
  };

  let credential: PublicKeyCredential;

  try {
    credential = await navigator.credentials.get({
      publicKey: publicKeyCredentialRequestOptions,
    }) as PublicKeyCredential;
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError') {
        throw new Error('Authentication was cancelled or timed out');
      }
    }
    throw error;
  }

  if (!credential) {
    throw new Error('Failed to authenticate with passkey');
  }

  // Find which passkey was used
  const usedCredentialId = arrayBufferToBase64(credential.rawId);
  const matchedPasskey = passkeys.find(p => p.credentialId === usedCredentialId);

  if (!matchedPasskey) {
    throw new Error('Authenticated with unknown passkey');
  }

  // Now authenticate again with the correct PRF salt
  return authenticateWithPasskey(matchedPasskey.credentialId, matchedPasskey.prfSalt);
}

// ============================================================================
// KEK Derivation from PRF Output
// ============================================================================

/**
 * Derive KEK from WebAuthn PRF output
 *
 * @param prfOutput - PRF output from WebAuthn
 * @param salt - Additional salt for HKDF
 * @returns KEK as CryptoKey
 */
export async function deriveKEKFromPRF(
  prfOutput: ArrayBuffer,
  salt: Uint8Array
): Promise<CryptoKey> {
  return deriveKEK(prfOutput, salt, 'devflow-vault-passkey-kek');
}
