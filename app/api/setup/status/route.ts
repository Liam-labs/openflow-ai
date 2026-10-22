/**
 * GET /api/setup/status
 *
 * Returns which setup steps are complete. Used by the wizard to resume
 * from the last incomplete step if the user closes and returns.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { promises as fs } from 'fs';
import path from 'path';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { tracked } from '@/lib/api-tracking';

interface StepStatus {
  complete: boolean;
  data?: Record<string, unknown>;
}

interface SetupStatusResponse {
  setupComplete: boolean;
  steps: Record<number, StepStatus>;
  nextStep: number;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export const GET = tracked('/api/setup/status', async (request: NextRequest) => {
  // Anyone may ask whether setup is finished (the first-run redirect needs that). What was entered during setup (names, the
  // integrations step with its API keys) goes only to a caller with a token or a trusted same-machine request.
  const trusted = (await requireAuthOrLocal(request, 'read')) === null;
  // Check each step's config file
  const bridgeConfigPath = path.join(path.dirname(DataPaths.user.profile), 'bridge-config.json');
  const [hasProfile, hasCredentials, hasIntegrations, hasTeam, hasBridgeConfig] =
    await Promise.all([
      fileExists(DataPaths.user.profile),
      fileExists(DataPaths.user.credentials),
      fileExists(DataPaths.user.integrations),
      fileExists(DataPaths.user.team),
      fileExists(bridgeConfigPath),
    ]);

  // Read existing data for completed steps (for pre-population)
  const steps: Record<number, StepStatus> = {};

  if (hasProfile) {
    const data = await readJsonFile<Record<string, unknown>>(DataPaths.user.profile, {});
    steps[1] = trusted ? { complete: true, data } : { complete: true };
  } else {
    steps[1] = { complete: false };
  }

  if (hasCredentials) {
    const data = await readJsonFile<Record<string, unknown>>(DataPaths.user.credentials, {});
    // Strip actual key values, only return metadata
    const safe: Record<string, unknown> = {
      hasAnthropic: !!data.anthropicApiKey,
      hasOpenRouter: !!data.openrouterApiKey,
      hasGrok: !!data.grokApiKey,
      hasOllama: !!data.ollamaUrl,
      createdAt: data.createdAt,
    };
    steps[2] = trusted ? { complete: true, data: safe } : { complete: true };
  } else {
    steps[2] = { complete: false };
  }

  if (hasIntegrations) {
    const data = await readJsonFile<Record<string, unknown>>(DataPaths.user.integrations, {});
    steps[3] = trusted ? { complete: true, data } : { complete: true };
  } else {
    steps[3] = { complete: false };
  }

  if (hasTeam) {
    const data = await readJsonFile<Record<string, unknown>>(DataPaths.user.team, {});
    steps[4] = trusted ? { complete: true, data } : { complete: true };
  } else {
    steps[4] = { complete: false };
  }

  // Step 5 is "complete" if bridge-config.json exists (step 5 data was saved)
  steps[5] = { complete: hasBridgeConfig };

  // Check for explicit completion marker (set by /api/setup/complete or manually)
  const markerPath = path.join(path.dirname(DataPaths.user.profile), 'setup-complete.json');
  const hasMarker = await fileExists(markerPath);

  // Find first incomplete step
  let nextStep = 6; // past end = all complete
  for (let i = 1; i <= 5; i++) {
    if (!steps[i].complete) {
      nextStep = i;
      break;
    }
  }

  // Setup is complete if: all steps done, OR completion marker exists, OR profile exists
  const setupComplete = nextStep > 5 || hasMarker || hasProfile;

  const response: SetupStatusResponse = {
    setupComplete,
    steps,
    nextStep: setupComplete ? Math.min(nextStep, 5) : Math.min(nextStep, 5),
  };

  return NextResponse.json(response);
});
