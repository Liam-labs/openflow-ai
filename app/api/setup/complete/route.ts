/**
 * POST /api/setup/complete — Finalise setup (wizard completion)
 * GET  /api/setup/complete — Set cookie for existing installs (browser visit)
 *
 * Both verify config exists, set the devflow-setup-done cookie, and return summary.
 * POST also generates ~/.secrets and writes the completion marker.
 * GET is lightweight — just checks profile exists and sets the cookie.
 *
 * Safe to call on already-configured instances — only appends, never overwrites.
 */

import { applySecrets } from '@/lib/secrets-file';
import { resolveSecretStore } from '@/lib/secret-store';
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CompleteResponse {
  success: boolean;
  summary?: {
    userName: string;
    teamName: string;
    providers: string[];
    services: string[];
    bridgeConfigured: boolean;
  };
  error?: string;
}

interface CredentialsData {
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  grokApiKey?: string;
  ollamaUrl?: string;
  devflowApiToken?: string;
  encryptionMasterKey?: string;
}

interface IntegrationsData {
  services?: Record<string, { enabled: boolean; fields: Record<string, string> }>;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST = tracked('/api/setup/complete', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'admin');
  if (authDenied) return authDenied;
  try {
    // 1. Verify profile exists — minimum requirement for "setup done"
    const profile = await readJsonFile<Record<string, unknown>>(
      DataPaths.user.profile,
      {}
    );

    if (!profile.name) {
      return NextResponse.json<CompleteResponse>(
        { success: false, error: 'User profile not configured (Step 1 required)' },
        { status: 400 }
      );
    }

    // 2. Read all config files
    const credentials = await readJsonFile<CredentialsData>(
      DataPaths.user.credentials,
      {}
    );
    const integrations = await readJsonFile<IntegrationsData>(
      DataPaths.user.integrations,
      {}
    );
    const team = await readJsonFile<Record<string, string>>(
      DataPaths.user.team,
      {}
    );
    const bridgeConfigPath = path.join(
      path.dirname(DataPaths.user.profile),
      'bridge-config.json'
    );
    const bridgeConfig = await readJsonFile<Record<string, unknown>>(
      bridgeConfigPath,
      {}
    );

    // 3. Generate/update ~/.secrets with any new API keys
    await appendToSecretsFile(credentials, integrations);

    // 4. Write completion marker
    const markerPath = path.join(
      path.dirname(DataPaths.user.profile),
      'setup-complete.json'
    );
    await writeJsonFile(markerPath, {
      completedAt: new Date().toISOString(),
      version: '1.0.0',
    });

    // 5. Build summary
    const providers: string[] = [];
    if (credentials.anthropicApiKey) providers.push('Anthropic');
    if (credentials.openrouterApiKey) providers.push('OpenRouter');
    if (credentials.grokApiKey) providers.push('Grok');
    if (credentials.ollamaUrl) providers.push('Ollama');

    const services: string[] = [];
    if (integrations.services) {
      for (const [name, cfg] of Object.entries(integrations.services)) {
        if (cfg.enabled) services.push(name);
      }
    }

    const summary = {
      userName: profile.name as string,
      teamName: team.teamName || '',
      providers,
      services,
      bridgeConfigured: bridgeConfig.enabled === true,
    };

    // 6. Set cookie and return
    const response = NextResponse.json<CompleteResponse>({
      success: true,
      summary,
    });
    response.cookies.set('devflow-setup-done', '1', {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365 * 10, // 10 years
    });

    return response;
  } catch (error) {
    console.error('[Setup complete] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json<CompleteResponse>(
      { success: false, error: message },
      { status: 500 }
    );
  }
});

/**
 * GET /api/setup/complete
 *
 * Serves an HTML page that sets the bypass cookie via JavaScript then redirects.
 * This avoids the 307 + Set-Cookie race condition on mobile/tunnel browsers.
 * Visiting this URL in a browser unblocks the first-run redirect.
 */
export const GET = tracked('/api/setup/complete', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  const profile = await readJsonFile<Record<string, unknown>>(
    DataPaths.user.profile,
    {}
  );

  if (!profile.name) {
    const html = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/setup"></head>
<body>Redirecting to setup...</body></html>`;
    return new NextResponse(html, {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Set cookie via JS then redirect — guaranteed to persist before navigation
  const html = `<!DOCTYPE html>
<html><head>
<script>
document.cookie="devflow-setup-done=1;path=/;max-age=315360000;samesite=lax";
window.location.replace("/");
</script>
</head>
<body>Setup complete. Redirecting...</body>
</html>`;

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html' },
  });
});

// ---------------------------------------------------------------------------
// ~/.secrets management
// ---------------------------------------------------------------------------

/**
 * Store the wizard's API keys: in the app's private secrets file by default, and (only when DEVFLOW_WRITE_SHELL_SECRETS=1) also in
 * ~/.secrets as shell-sourceable `export KEY='value'` lines, without overwriting existing entries.
 */
async function appendToSecretsFile(
  credentials: CredentialsData,
  integrations: IntegrationsData
): Promise<void> {
  const secretsPath = path.join(os.homedir(), '.secrets');

  // Build map of secrets to write
  const newSecrets: Record<string, string> = {};

  if (credentials.anthropicApiKey) {
    newSecrets['ANTHROPIC_API_KEY'] = credentials.anthropicApiKey;
    // Claude agents drop the key unless told otherwise (they normally use a Claude subscription login). A person who gave a key and
    // has no login on this machine wants the key used; someone who is signed in keeps the login unless they set this themselves.
    if (!existsSync(path.join(os.homedir(), '.claude', '.credentials.json'))) newSecrets['DEVFLOW_CLAUDE_AUTH'] = 'api-key';
  }
  if (credentials.openrouterApiKey) {
    newSecrets['OPENROUTER_API_KEY'] = credentials.openrouterApiKey;
  }
  if (credentials.grokApiKey) {
    newSecrets['GROK_API_KEY'] = credentials.grokApiKey;
  }
  if (credentials.ollamaUrl) {
    newSecrets['OLLAMA_URL'] = credentials.ollamaUrl;
  }
  if (credentials.devflowApiToken) {
    newSecrets['DEVFLOW_API_TOKEN'] = credentials.devflowApiToken;
  }

  // Service integration keys
  if (integrations.services) {
    for (const [name, cfg] of Object.entries(integrations.services)) {
      if (!cfg.enabled) continue;
      const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      for (const [field, value] of Object.entries(cfg.fields || {})) {
        if (value) {
          const envKey = `${prefix}_${field.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
          newSecrets[envKey] = value;
        }
      }
    }
  }

  if (Object.keys(newSecrets).length === 0) return;

  // Default: the app's own private secrets file (lib/secret-store.ts), which nothing sources. The shell-sourceable ~/.secrets below is
  // opt-in (DEVFLOW_WRITE_SHELL_SECRETS=1) for people who want their terminals to have the keys too.
  try {
    const store = resolveSecretStore();
    if (store.kind === 'file') {
      for (const [name, value] of Object.entries(newSecrets)) {
        try {
          if (store.get(name) !== value) store.set(name, value);
          // Same rule as at app start: a value already in the environment wins, otherwise the running app sees it at once.
          if (process.env[name] === undefined) process.env[name] = value;
        } catch (error) {
          console.warn(`[setup] ${name} not stored: ${error instanceof Error ? error.message : 'error'}`);
        }
      }
    }
  } catch (error) {
    console.warn('[setup] secret store not written:', error instanceof Error ? error.message : error);
  }
  if (process.env.DEVFLOW_WRITE_SHELL_SECRETS !== '1') return;

  // Read existing file (may not exist on fresh installs)
  let existingContent = '';
  try {
    existingContent = await fs.readFile(secretsPath, 'utf-8');
  } catch {
    // File doesn't exist — we'll create it
  }

  // Values are single-quoted and names checked (lib/secrets-file.ts): this file is sourced by shells, so it must never run input.
  const update = applySecrets(existingContent, newSecrets);
  if (update.refused.length) console.warn(`[setup] not written to ~/.secrets (unsafe name or value): ${update.refused.join(', ')}`);
  if (update.added.length === 0 && update.updated.length === 0) return;
  const content = update.content;

  await fs.writeFile(secretsPath, content, { mode: 0o600 });
  await fs.chmod(secretsPath, 0o600);
}
