/**
 * DevFlow Vault Storage
 *
 * Handles vault file persistence via API.
 * The vault file is stored on the server filesystem.
 */

import type { VaultFile, VaultApiResponse } from './types';

// ============================================================================
// Constants
// ============================================================================

const VAULT_API_ENDPOINT = '/api/vault';

// ============================================================================
// Vault File Operations
// ============================================================================

/**
 * Check if a vault exists
 */
export async function vaultExists(): Promise<boolean> {
  try {
    const response = await fetch(VAULT_API_ENDPOINT, {
      method: 'HEAD',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Load vault file from server
 *
 * @returns Vault file or null if not found
 */
export async function loadVaultFile(): Promise<VaultFile | null> {
  try {
    const response = await fetch(VAULT_API_ENDPOINT, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to load vault: ${response.statusText}`);
    }

    const data: VaultApiResponse = await response.json();

    if (!data.success || !data.vault) {
      throw new Error(data.error || 'Failed to load vault');
    }

    return data.vault;
  } catch (error) {
    if (error instanceof Error && error.message.includes('404')) {
      return null;
    }
    throw error;
  }
}

/**
 * Save vault file to server
 *
 * @param vaultFile - Vault file to save
 */
export async function saveVaultFile(vaultFile: VaultFile): Promise<void> {
  const response = await fetch(VAULT_API_ENDPOINT, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(vaultFile),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Failed to save vault: ${response.statusText}`);
  }
}

/**
 * Delete vault file
 *
 * WARNING: This permanently deletes the vault and all secrets.
 *
 * @param confirmationToken - Must match a specific value to confirm deletion
 */
export async function deleteVault(confirmationToken: string): Promise<void> {
  if (confirmationToken !== 'DELETE_MY_VAULT') {
    throw new Error('Invalid confirmation token');
  }

  const response = await fetch(VAULT_API_ENDPOINT, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ confirmationToken }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Failed to delete vault: ${response.statusText}`);
  }
}

// ============================================================================
// Storage Events (for multi-tab sync)
// ============================================================================

type VaultChangeCallback = (vault: VaultFile | null) => void;

const vaultChangeListeners: Set<VaultChangeCallback> = new Set();

/**
 * Subscribe to vault changes (for multi-tab sync)
 *
 * When the vault is saved in another tab, listeners will be notified.
 */
export function onVaultChange(callback: VaultChangeCallback): () => void {
  vaultChangeListeners.add(callback);

  // Return unsubscribe function
  return () => {
    vaultChangeListeners.delete(callback);
  };
}

/**
 * Notify listeners of vault change
 */
export function notifyVaultChange(vault: VaultFile | null): void {
  vaultChangeListeners.forEach(callback => {
    try {
      callback(vault);
    } catch (error) {
      console.error('Error in vault change listener:', error);
    }
  });
}

// ============================================================================
// Clipboard Utilities
// ============================================================================

let clipboardClearTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Copy text to clipboard with auto-clear
 *
 * @param text - Text to copy
 * @param clearAfterMs - Clear clipboard after this many milliseconds (default 30000)
 */
export async function copyToClipboard(
  text: string,
  clearAfterMs: number = 30000
): Promise<void> {
  // Clear any existing timeout
  if (clipboardClearTimeout) {
    clearTimeout(clipboardClearTimeout);
    clipboardClearTimeout = null;
  }

  // Copy to clipboard
  await navigator.clipboard.writeText(text);

  // Set up auto-clear
  clipboardClearTimeout = setTimeout(async () => {
    try {
      // Only clear if the clipboard still contains the copied text
      const currentText = await navigator.clipboard.readText();
      if (currentText === text) {
        await navigator.clipboard.writeText('');
      }
    } catch {
      // Clipboard access may be denied, ignore
    }
    clipboardClearTimeout = null;
  }, clearAfterMs);
}

/**
 * Clear the auto-clear timeout (e.g., when user copies something else)
 */
export function cancelClipboardAutoClear(): void {
  if (clipboardClearTimeout) {
    clearTimeout(clipboardClearTimeout);
    clipboardClearTimeout = null;
  }
}

// ============================================================================
// Password Generator
// ============================================================================

const PASSWORD_CHARS = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  numbers: '0123456789',
  symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
};

export interface PasswordGeneratorOptions {
  length?: number;
  includeLowercase?: boolean;
  includeUppercase?: boolean;
  includeNumbers?: boolean;
  includeSymbols?: boolean;
}

/**
 * Generate a random password
 */
export function generatePassword(options: PasswordGeneratorOptions = {}): string {
  const {
    length = 20,
    includeLowercase = true,
    includeUppercase = true,
    includeNumbers = true,
    includeSymbols = true,
  } = options;

  let charset = '';
  const required: string[] = [];

  if (includeLowercase) {
    charset += PASSWORD_CHARS.lowercase;
    required.push(PASSWORD_CHARS.lowercase);
  }
  if (includeUppercase) {
    charset += PASSWORD_CHARS.uppercase;
    required.push(PASSWORD_CHARS.uppercase);
  }
  if (includeNumbers) {
    charset += PASSWORD_CHARS.numbers;
    required.push(PASSWORD_CHARS.numbers);
  }
  if (includeSymbols) {
    charset += PASSWORD_CHARS.symbols;
    required.push(PASSWORD_CHARS.symbols);
  }

  if (charset.length === 0) {
    charset = PASSWORD_CHARS.lowercase + PASSWORD_CHARS.uppercase + PASSWORD_CHARS.numbers;
  }

  // Generate random bytes
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);

  // Build password
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i] % charset.length];
  }

  // Ensure at least one character from each required set
  for (let i = 0; i < required.length && i < length; i++) {
    const set = required[i];
    const randomIndex = randomBytes[i] % set.length;
    const position = randomBytes[length - 1 - i] % length;

    password =
      password.substring(0, position) +
      set[randomIndex] +
      password.substring(position + 1);
  }

  return password;
}

// ============================================================================
// Secrets Sync to ~/.secrets
// ============================================================================

interface SecretForSync {
  name: string;
  value: string;
  category?: string;
  payloadUrl?: string;
  score?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Sync secrets to ~/.secrets file
 *
 * This sends decrypted secrets to the server API which writes them
 * to the user's ~/.secrets file as environment variables.
 *
 * @param secrets - Array of secrets to sync
 * @param action - Type of sync operation
 */
export async function syncSecretsToFile(
  secrets: SecretForSync[],
  action: 'sync' | 'add' | 'update' | 'delete' = 'sync',
  options?: { secret?: SecretForSync; oldName?: string }
): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    const body: Record<string, unknown> = { action };

    if (action === 'sync') {
      body.secrets = secrets;
    } else if (options?.secret) {
      body.secret = options.secret;
      if (options.oldName) {
        body.oldName = options.oldName;
      }
    }

    const response = await fetch('/api/vault/sync-secrets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[Vault Sync] Failed to sync secrets:', data.error);
      return { success: false, error: data.error };
    }

    console.log('[Vault Sync]', data.message);
    return { success: true, message: data.message };
  } catch (error) {
    console.error('[Vault Sync] Error syncing secrets:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Export Utilities
// ============================================================================

/**
 * Download data as a file
 */
export function downloadAsFile(
  content: string,
  filename: string,
  mimeType: string = 'text/plain'
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}
