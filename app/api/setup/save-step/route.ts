/**
 * POST /api/setup/save-step
 *
 * Saves configuration for a single wizard step. Each step writes to its own
 * file in .UserData/ so progress is preserved across browser sessions.
 *
 * Body: { step: 1-5, data: { ...step-specific fields } }
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import { createToken as createApiToken, hashToken, loadTokensData, requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Step1Data {
  name: string;
  businessName?: string;
  role: string;
  keyClients?: string;
}

interface Step2Data {
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  grokApiKey?: string;
  ollamaUrl?: string;
}

interface ServiceConfig {
  enabled: boolean;
  fields: Record<string, string>;
}

interface Step3Data {
  services: Record<string, ServiceConfig>;
}

interface Step4Data {
  teamName: string;
  workspaceDir: string;
  personalityTheme?: string;
}

interface Step5Data {
  bridgeUrl?: string;
  bridgeToken?: string;
  bridgeEnabled?: boolean;
}

interface SaveStepRequest {
  step: number;
  data: Step1Data | Step2Data | Step3Data | Step4Data | Step5Data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

function validateStep1(data: unknown): data is Step1Data {
  const d = data as Step1Data;
  return typeof d.name === 'string' && d.name.trim().length >= 2 && typeof d.role === 'string';
}

function validateStep2(data: unknown): data is Step2Data {
  const d = data as Step2Data;
  // At least one field should be provided (Anthropic is "required" but we don't block)
  return typeof d === 'object' && d !== null;
}

function validateStep3(data: unknown): data is Step3Data {
  const d = data as Step3Data;
  return typeof d === 'object' && d !== null && typeof d.services === 'object';
}

function validateStep4(data: unknown): data is Step4Data {
  const d = data as Step4Data;
  return (
    typeof d.teamName === 'string' &&
    d.teamName.trim().length >= 2 &&
    typeof d.workspaceDir === 'string' &&
    d.workspaceDir.trim().length > 0
  );
}

function validateStep5(data: unknown): data is Step5Data {
  return typeof data === 'object' && data !== null;
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

async function saveStep1(data: Step1Data): Promise<void> {
  const profile = {
    name: data.name.trim(),
    businessName: data.businessName?.trim() || '',
    role: data.role,
    keyClients: data.keyClients
      ? data.keyClients
          .split('\n')
          .map((c: string) => c.trim())
          .filter(Boolean)
      : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await ensureDir(path.dirname(DataPaths.user.profile));
  await writeJsonFile(DataPaths.user.profile, profile);
}

async function saveStep2(data: Step2Data): Promise<{ devflowApiToken: string }> {
  // Read existing credentials to preserve auto-generated keys across re-saves
  const existing = await readJsonFile<Record<string, string>>(DataPaths.user.credentials, {});

  // Reuse valid DevFlow API token or create a new one via the proper auth system
  let devflowApiToken: string | undefined;

  if (existing.devflowApiToken?.startsWith('dvf_')) {
    // Verify the token is still registered and not revoked
    const tokensData = await loadTokensData();
    const hash = hashToken(existing.devflowApiToken);
    const record = tokensData.tokens.find(t => t.tokenHash === hash && !t.revokedAt);
    if (record) {
      devflowApiToken = existing.devflowApiToken;
    }
  }

  if (!devflowApiToken) {
    // Generate a proper dvf_live_* token registered in api-tokens.json
    const { token } = await createApiToken('Setup Wizard', 'admin', 'setup-wizard', {
      description: 'Auto-generated during first-run setup',
      environment: 'production',
    });
    devflowApiToken = token;
  }

  // Preserve existing encryption key or generate new
  const encryptionMasterKey = existing.encryptionMasterKey || generateToken(32);

  const credentials = {
    anthropicApiKey: data.anthropicApiKey?.trim() || '',
    openrouterApiKey: data.openrouterApiKey?.trim() || '',
    grokApiKey: data.grokApiKey?.trim() || '',
    ollamaUrl: data.ollamaUrl?.trim() || '',
    devflowApiToken,
    encryptionMasterKey,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await ensureDir(path.dirname(DataPaths.user.credentials));
  await writeJsonFile(DataPaths.user.credentials, credentials);

  return { devflowApiToken };
}

async function saveStep3(data: Step3Data): Promise<void> {
  const integrations = {
    services: data.services,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await ensureDir(path.dirname(DataPaths.user.integrations));
  await writeJsonFile(DataPaths.user.integrations, integrations);
}

async function saveStep4(data: Step4Data): Promise<void> {
  const team = {
    teamName: data.teamName.trim(),
    workspaceDir: data.workspaceDir.trim(),
    personalityTheme: data.personalityTheme || 'generic',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await ensureDir(path.dirname(DataPaths.user.team));
  await writeJsonFile(DataPaths.user.team, team);

  // Also update scaffolding-config with workspace path
  const scaffoldingConfig = {
    teamDir: data.workspaceDir.trim(),
    personalityTheme: data.personalityTheme || 'generic',
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(DataPaths.user.scaffoldingConfig, scaffoldingConfig);
}

async function saveStep5(data: Step5Data): Promise<void> {
  // Step 5 stores bridge config — actual bridge install happens on host side
  const bridgeConfig = {
    enabled: data.bridgeEnabled ?? false,
    url: data.bridgeUrl?.trim() || '',
    token: data.bridgeToken?.trim() || '',
    configuredAt: new Date().toISOString(),
  };

  // Store in .UserData/ as part of user's config
  const bridgeConfigPath = path.join(
    path.dirname(DataPaths.user.profile),
    'bridge-config.json'
  );
  await writeJsonFile(bridgeConfigPath, bridgeConfig);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST = tracked('/api/setup/save-step', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'admin');
  if (authDenied) return authDenied;
  try {
    const body: SaveStepRequest = await request.json();
    const { step, data } = body;

    if (!step || step < 1 || step > 5) {
      return NextResponse.json(
        { success: false, error: 'Invalid step number (1-5)' },
        { status: 400 }
      );
    }

    if (!data || typeof data !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Missing step data' },
        { status: 400 }
      );
    }

    // Validate and save based on step
    switch (step) {
      case 1:
        if (!validateStep1(data)) {
          return NextResponse.json(
            { success: false, error: 'Name (min 2 chars) and role are required' },
            { status: 400 }
          );
        }
        await saveStep1(data as Step1Data);
        break;

      case 2: {
        if (!validateStep2(data)) {
          return NextResponse.json(
            { success: false, error: 'Invalid credentials data' },
            { status: 400 }
          );
        }
        const step2Result = await saveStep2(data as Step2Data);
        // Return the generated API token so the frontend can display it
        return NextResponse.json({
          success: true,
          step,
          devflowApiToken: step2Result.devflowApiToken,
        });
      }

      case 3:
        if (!validateStep3(data)) {
          return NextResponse.json(
            { success: false, error: 'Services object required' },
            { status: 400 }
          );
        }
        await saveStep3(data as Step3Data);
        break;

      case 4:
        if (!validateStep4(data)) {
          return NextResponse.json(
            { success: false, error: 'Team name (min 2 chars) and workspace directory required' },
            { status: 400 }
          );
        }
        await saveStep4(data as Step4Data);
        break;

      case 5:
        if (!validateStep5(data)) {
          return NextResponse.json(
            { success: false, error: 'Invalid bridge config' },
            { status: 400 }
          );
        }
        await saveStep5(data as Step5Data);
        break;
    }

    return NextResponse.json({ success: true, step });
  } catch (error) {
    console.error('[Setup save-step] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
});
