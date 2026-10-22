/**
 * Vault Sync Secrets API
 *
 * Syncs secrets from DevFlow Vault to ~/.secrets file.
 * This endpoint receives plaintext secrets after client-side decryption
 * and updates the local environment secrets file.
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { withFileLock } from '@/lib/data-io';
import { tracked } from '@/lib/api-tracking';
import { resolveSecretStore, defaultSecretsFile } from '@/lib/secret-store';
import { secretNameAllowed, secretValueAllowed, shellQuote } from '@/lib/secrets-file';
import { PRODUCT_NAME } from '@/lib/brand';

// Force dynamic to prevent caching
export const dynamic = 'force-dynamic';

// Where vault secrets go. Default: the app's private secret store (lib/secret-store.ts), which no shell sources, with JSON secrets as
// private files beside it. Only with DEVFLOW_WRITE_SHELL_SECRETS=1 are they also written to the shell-sourced ~/.secrets and ~/.secrets.d.
const SHELL_MODE = process.env.DEVFLOW_WRITE_SHELL_SECRETS === '1';
const SECRETS_FILE_PATH = SHELL_MODE ? path.join(os.homedir(), '.secrets') : defaultSecretsFile();
const SECRETS_DIR_PATH = SHELL_MODE ? path.join(os.homedir(), '.secrets.d') : path.join(path.dirname(defaultSecretsFile()), 'secrets.d');

interface SecretEntry {
  name: string;
  value: string;
  type?: 'text' | 'json';  // JSON secrets get written to ~/.secrets.d/
  category?: string;
  payloadUrl?: string;
  score?: string;
  clientId?: string;       // OAuth Client ID
  clientSecret?: string;   // OAuth Client Secret
}

interface SyncRequest {
  action: 'sync' | 'add' | 'update' | 'delete';
  secrets?: SecretEntry[];
  secret?: SecretEntry;
  oldName?: string; // For rename operations
  oldType?: 'text' | 'json'; // For type change operations
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert a secret name to a valid environment variable name
 * Examples:
 *   "GitHub PAT" -> "GITHUB_PAT"
 *   "Anthropic API Key" -> "ANTHROPIC_API_KEY"
 *   "my-secret_key" -> "MY_SECRET_KEY"
 */
function toEnvVarName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')  // Replace non-alphanumeric with underscore
    .replace(/_+/g, '_')          // Collapse multiple underscores
    .replace(/^_|_$/g, '');       // Remove leading/trailing underscores
}

/** One line of text for a comment in the shell file: no line breaks or control characters, which would end the comment and run as commands. */
function commentText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').slice(0, 300);
}

/**
 * Convert secret name to a safe filename for JSON files
 * Examples:
 *   "Google ACME Service Account" -> "google-acme-service-account.json"
 *   "GA4 Config" -> "ga4-config.json"
 */
function toJsonFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with hyphen
    .replace(/-+/g, '-')          // Collapse multiple hyphens
    .replace(/^-|-$/g, '')        // Remove leading/trailing hyphens
    + '.json';
}

/**
 * Ensure ~/.secrets.d directory exists with proper permissions
 */
async function ensureSecretsDirExists(): Promise<void> {
  try {
    await fs.access(SECRETS_DIR_PATH);
  } catch {
    // Directory doesn't exist, create it
    await fs.mkdir(SECRETS_DIR_PATH, { recursive: true, mode: 0o700 });
  }
}

/**
 * Write a JSON secret to ~/.secrets.d/
 * Returns the full file path
 */
async function writeJsonSecret(name: string, jsonContent: string): Promise<string> {
  await ensureSecretsDirExists();

  const filename = toJsonFilename(name);
  const filepath = path.join(SECRETS_DIR_PATH, filename);

  // Validate and format JSON
  let formattedJson: string;
  try {
    const parsed = JSON.parse(jsonContent);
    formattedJson = JSON.stringify(parsed, null, 2);
  } catch {
    // If not valid JSON, write as-is (user might be storing something else)
    formattedJson = jsonContent;
  }

  await fs.writeFile(filepath, formattedJson, { mode: 0o600 });
  return filepath;
}

/**
 * Delete a JSON secret file from ~/.secrets.d/
 */
async function deleteJsonSecret(name: string): Promise<void> {
  const filename = toJsonFilename(name);
  const filepath = path.join(SECRETS_DIR_PATH, filename);

  try {
    await fs.unlink(filepath);
  } catch (error) {
    // Ignore if file doesn't exist
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Parse existing ~/.secrets file into a map of name -> value
 */
async function parseSecretsFile(): Promise<Map<string, { value: string; comment?: string }>> {
  const secrets = new Map<string, { value: string; comment?: string }>();

  if (!SHELL_MODE) {
    const store = resolveSecretStore();
    for (const name of store.names()) secrets.set(name, { value: store.get(name) ?? '' });
    return secrets;
  }

  try {
    const content = await fs.readFile(SECRETS_FILE_PATH, 'utf-8');
    const lines = content.split('\n');

    let lastComment = '';
    for (const line of lines) {
      // Track comments (lines starting with #)
      if (line.trim().startsWith('#')) {
        lastComment = line;
        continue;
      }

      // Parse export statements
      const match = line.match(/^export\s+([A-Z_][A-Z0-9_]*)="(.*)"\s*$/);
      const single = line.match(/^export\s+([A-Z_][A-Z0-9_]*)='((?:[^']|'\\'')*)'\s*$/);
      if (match) {
        const [, name, value] = match;
        secrets.set(name, {
          value: value.replace(/\\"/g, '"').replace(/\\\$/g, '$').replace(/\\`/g, '`').replace(/\\\\/g, '\\'),
          comment: lastComment || undefined
        });
        lastComment = '';
      } else if (single) {
        secrets.set(single[1], { value: single[2].replace(/'\\''/g, "'"), comment: lastComment || undefined });
        lastComment = '';
      } else {
        lastComment = '';
      }
    }
  } catch (error) {
    // File doesn't exist yet, return empty map
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return secrets;
}

/** The map as it was when read, to see afterwards what changed. */
function snapshot(map: Map<string, { value: string; comment?: string }>): Map<string, string> {
  return new Map(Array.from(map, ([k, v]) => [k, v.value]));
}

/**
 * Save the map. Default: only what changed goes into the private secret store (names and values that are not allowed are skipped and
 * logged by name). Shell mode: the whole ~/.secrets is rewritten, every value single-quoted and every comment kept to one line.
 */
async function writeSecretsFile(secrets: Map<string, { value: string; comment?: string }>, before: Map<string, string> = new Map()): Promise<void> {
  if (!SHELL_MODE) {
    const store = resolveSecretStore();
    if (store.kind !== 'file') throw new Error('the configured secret store is read-only');
    for (const [name, { value }] of secrets) {
      if (before.get(name) === value) continue;
      if (!secretNameAllowed(name) || !secretValueAllowed(value)) {
        console.warn(`[vault-sync] ${name} not stored: unsafe name or value`);
        continue;
      }
      store.set(name, value);
    }
    for (const name of before.keys()) if (!secrets.has(name)) store.delete(name);
    return;
  }

  const lines: string[] = [
    '# ~/.secrets - Auto-managed environment variables',
    `# This file is synced with ${PRODUCT_NAME} Vault`,
    `# Manual edits below the ${PRODUCT_NAME} section will be preserved`,
    '',
    '# ============================================================================',
    `# ${PRODUCT_NAME} Vault Secrets (auto-synced)`,
    '# ============================================================================',
    '',
  ];

  // Sort secrets alphabetically for consistency
  const sortedKeys = Array.from(secrets.keys()).sort();

  for (const key of sortedKeys) {
    const { value, comment } = secrets.get(key)!;
    if (!secretNameAllowed(key) || !secretValueAllowed(value)) {
      console.warn(`[vault-sync] ${key} not written to the shell file: unsafe name or value`);
      continue;
    }
    if (comment) {
      lines.push('# ' + commentText(comment.replace(/^#\s*/, '')));
    }
    lines.push(`export ${key}=${shellQuote(value)}`);
  }

  lines.push('');

  await fs.mkdir(path.dirname(SECRETS_FILE_PATH), { recursive: true, mode: 0o700 });
  await fs.writeFile(SECRETS_FILE_PATH, lines.join('\n'), { mode: 0o600 });
  await fs.chmod(SECRETS_FILE_PATH, 0o600);
}

/**
 * Merge vault secrets with existing ~/.secrets file
 * Preserves any manually-added secrets not in the vault
 * JSON secrets are written to ~/.secrets.d/ with env var pointing to file path
 */
async function syncSecretsToFile(vaultSecrets: SecretEntry[]): Promise<{ added: number; updated: number; jsonFiles: number }> {
  const existingSecrets = await parseSecretsFile();
  const before = snapshot(existingSecrets);

  // Track which secrets came from vault
  const vaultEnvNames = new Set<string>();
  let added = 0;
  let updated = 0;
  let jsonFiles = 0;

  for (const secret of vaultSecrets) {
    const isJson = secret.type === 'json';

    // For JSON secrets, env var name ends with _JSON to indicate it's a file path
    const envName = isJson
      ? toEnvVarName(secret.name).replace(/_JSON$/, '') + '_JSON'
      : toEnvVarName(secret.name);

    vaultEnvNames.add(envName);

    let valueToStore: string;

    if (isJson) {
      // Write JSON to file and store file path as env var value
      const filepath = await writeJsonSecret(secret.name, secret.value);
      valueToStore = filepath;
      jsonFiles++;
    } else {
      valueToStore = secret.value;
    }

    const existing = existingSecrets.get(envName);
    if (!existing) {
      added++;
    } else if (existing.value !== valueToStore) {
      updated++;
    }

    // Build comment from metadata if present
    const typeLabel = isJson ? ' (JSON file)' : '';
    const metadata: string[] = [];
    if (secret.category) metadata.push(secret.category);
    if (secret.payloadUrl) metadata.push(`Payload URL: ${secret.payloadUrl}`);
    if (secret.score) metadata.push(`Score: ${secret.score}`);
    const comment = metadata.length > 0
      ? `# ${secret.name}${typeLabel} — ${metadata.join(' | ')}`
      : `# ${secret.name}${typeLabel}`;

    existingSecrets.set(envName, { value: valueToStore, comment });

    // Write additional OAuth env vars if present
    if (secret.clientId) {
      const clientIdEnvName = toEnvVarName(secret.name) + '_CLIENT_ID';
      vaultEnvNames.add(clientIdEnvName);
      const cidExisting = existingSecrets.get(clientIdEnvName);
      if (!cidExisting) added++;
      else if (cidExisting.value !== secret.clientId) updated++;
      existingSecrets.set(clientIdEnvName, { value: secret.clientId, comment: `# ${secret.name}: Client ID` });
    }
    if (secret.clientSecret) {
      const clientSecretEnvName = toEnvVarName(secret.name) + '_CLIENT_SECRET';
      vaultEnvNames.add(clientSecretEnvName);
      const csExisting = existingSecrets.get(clientSecretEnvName);
      if (!csExisting) added++;
      else if (csExisting.value !== secret.clientSecret) updated++;
      existingSecrets.set(clientSecretEnvName, { value: secret.clientSecret, comment: `# ${secret.name}: Client Secret` });
    }
  }

  await writeSecretsFile(existingSecrets, before);

  return { added, updated, jsonFiles };
}

/**
 * Add or update a single secret
 */
async function upsertSecret(secret: SecretEntry, oldName?: string, oldType?: 'text' | 'json'): Promise<{ envName: string; isJson: boolean }> {
  const existingSecrets = await parseSecretsFile();
  const before = snapshot(existingSecrets);
  const isJson = secret.type === 'json';

  // If renaming or changing type, remove old entry and file
  if (oldName) {
    const wasJson = oldType === 'json';
    const oldEnvName = wasJson
      ? toEnvVarName(oldName).replace(/_JSON$/, '') + '_JSON'
      : toEnvVarName(oldName);
    existingSecrets.delete(oldEnvName);

    // Clean up old OAuth env vars
    existingSecrets.delete(toEnvVarName(oldName) + '_CLIENT_ID');
    existingSecrets.delete(toEnvVarName(oldName) + '_CLIENT_SECRET');

    // Delete old JSON file if it was a JSON secret
    if (wasJson) {
      await deleteJsonSecret(oldName);
    }
  }

  // For JSON secrets, env var name ends with _JSON to indicate it's a file path
  const envName = isJson
    ? toEnvVarName(secret.name).replace(/_JSON$/, '') + '_JSON'
    : toEnvVarName(secret.name);

  let valueToStore: string;
  if (isJson) {
    // Write JSON to file and store file path as env var value
    valueToStore = await writeJsonSecret(secret.name, secret.value);
  } else {
    valueToStore = secret.value;
  }

  const typeLabel = isJson ? ' (JSON file)' : '';
  const comment = secret.category
    ? `# ${secret.category}: ${secret.name}${typeLabel}`
    : `# ${secret.name}${typeLabel}`;

  existingSecrets.set(envName, { value: valueToStore, comment });

  // Write additional OAuth env vars if present
  if (secret.clientId) {
    const clientIdEnvName = toEnvVarName(secret.name) + '_CLIENT_ID';
    existingSecrets.set(clientIdEnvName, { value: secret.clientId, comment: `# ${secret.name}: Client ID` });
  }
  if (secret.clientSecret) {
    const clientSecretEnvName = toEnvVarName(secret.name) + '_CLIENT_SECRET';
    existingSecrets.set(clientSecretEnvName, { value: secret.clientSecret, comment: `# ${secret.name}: Client Secret` });
  }

  await writeSecretsFile(existingSecrets, before);

  return { envName, isJson };
}

/**
 * Delete a secret by name
 */
async function deleteSecretByName(name: string, type?: 'text' | 'json'): Promise<void> {
  const existingSecrets = await parseSecretsFile();
  const before = snapshot(existingSecrets);
  const isJson = type === 'json';

  const envName = isJson
    ? toEnvVarName(name).replace(/_JSON$/, '') + '_JSON'
    : toEnvVarName(name);

  existingSecrets.delete(envName);

  // Also delete OAuth-related env vars
  existingSecrets.delete(toEnvVarName(name) + '_CLIENT_ID');
  existingSecrets.delete(toEnvVarName(name) + '_CLIENT_SECRET');

  // Also delete JSON file if it's a JSON secret
  if (isJson) {
    await deleteJsonSecret(name);
  }

  await writeSecretsFile(existingSecrets, before);
}

// ============================================================================
// API Handlers
// ============================================================================

export const POST = tracked('/api/vault/sync-secrets', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body: SyncRequest = await request.json();

    switch (body.action) {
      case 'sync': {
        if (!body.secrets || !Array.isArray(body.secrets)) {
          return NextResponse.json(
            { success: false, error: 'Missing secrets array for sync action' },
            { status: 400 }
          );
        }

        const result = await withFileLock(SECRETS_FILE_PATH, () => syncSecretsToFile(body.secrets!));

        const jsonMsg = result.jsonFiles > 0 ? ` (${result.jsonFiles} JSON files written to ~/.secrets.d/)` : '';
        return NextResponse.json({
          success: true,
          message: `Synced ${body.secrets.length} secrets to ~/.secrets${jsonMsg}`,
          added: result.added,
          updated: result.updated,
          jsonFiles: result.jsonFiles,
        });
      }

      case 'add':
      case 'update': {
        if (!body.secret) {
          return NextResponse.json(
            { success: false, error: 'Missing secret for add/update action' },
            { status: 400 }
          );
        }

        const { envName, isJson } = await withFileLock(SECRETS_FILE_PATH, () => upsertSecret(body.secret!, body.oldName, body.oldType));

        const location = isJson ? `~/.secrets.d/${toJsonFilename(body.secret.name)}` : '~/.secrets';
        return NextResponse.json({
          success: true,
          message: `${body.action === 'add' ? 'Added' : 'Updated'} ${envName} in ${location}`,
          envName,
          isJson,
        });
      }

      case 'delete': {
        if (!body.secret?.name) {
          return NextResponse.json(
            { success: false, error: 'Missing secret name for delete action' },
            { status: 400 }
          );
        }

        await withFileLock(SECRETS_FILE_PATH, () => deleteSecretByName(body.secret!.name, body.secret!.type));

        const isJson = body.secret.type === 'json';
        const envName = isJson
          ? toEnvVarName(body.secret.name).replace(/_JSON$/, '') + '_JSON'
          : toEnvVarName(body.secret.name);

        return NextResponse.json({
          success: true,
          message: `Deleted ${envName} from ~/.secrets${isJson ? ' and JSON file from ~/.secrets.d/' : ''}`,
          envName,
        });
      }

      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${body.action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Error syncing secrets:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to sync secrets' },
      { status: 500 }
    );
  }
});

/**
 * GET - Check sync status and show current env var mappings
 */
export const GET = tracked('/api/vault/sync-secrets', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const secrets = await parseSecretsFile();
    const envVars = Array.from(secrets.keys());

    return NextResponse.json({
      success: true,
      secretsFile: SECRETS_FILE_PATH,
      envVarCount: envVars.length,
      envVars,
    });
  } catch (error) {
    console.error('Error reading secrets status:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to read secrets status' },
      { status: 500 }
    );
  }
});
