/**
 * GET /api/setup/detect
 *
 * Auto-detect system info and existing config for the setup wizard.
 * Returns username, OS, home dir, and which config files already exist.
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

interface DetectResponse {
  username: string;
  homeDir: string;
  hostname: string;
  platform: 'linux' | 'darwin' | 'win32' | string;
  arch: 'x64' | 'arm64' | string;
  isWSL: boolean;
  isDocker: boolean;
  isMacOS: boolean;
  isLinuxNative: boolean;
  existingConfig: {
    userProfile: boolean;
    credentials: boolean;
    integrations: boolean;
    team: boolean;
    scaffoldingConfig: boolean;
    secrets: boolean;
  };
  detected: {
    /** Last 4 chars of Anthropic key if found in ~/.secrets */
    anthropicKeyHint?: string;
    /** Last 4 chars of OpenRouter key if found */
    openrouterKeyHint?: string;
    /** Last 4 chars of Grok key if found */
    grokKeyHint?: string;
    /** Ollama URL if found */
    ollamaUrl?: string;
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function maskKey(key: string | undefined): string | undefined {
  if (!key || key.length < 8) return undefined;
  return key.slice(-4);
}

async function parseSecrets(): Promise<Record<string, string>> {
  const secretsPath = `${os.homedir()}/.secrets`;
  const result: Record<string, string> = {};
  try {
    const content = await fs.readFile(secretsPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^export\s+(\w+)=["']?(.+?)["']?\s*$/);
      if (match) {
        result[match[1]] = match[2];
      }
    }
  } catch {
    // No secrets file — fine
  }
  return result;
}

async function detectWSL(): Promise<boolean> {
  try {
    const version = await fs.readFile('/proc/version', 'utf-8');
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}

async function detectDocker(): Promise<boolean> {
  try {
    await fs.access('/.dockerenv');
    return true;
  } catch {
    try {
      const cgroup = await fs.readFile('/proc/1/cgroup', 'utf-8');
      return /docker|containerd/i.test(cgroup);
    } catch {
      return false;
    }
  }
}

export const GET = tracked('/api/setup/detect', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  const [
    hasProfile,
    hasCredentials,
    hasIntegrations,
    hasTeam,
    hasScaffoldingConfig,
    hasSecrets,
    secrets,
    isWSL,
    isDocker,
  ] = await Promise.all([
    fileExists(DataPaths.user.profile),
    fileExists(DataPaths.user.credentials),
    fileExists(DataPaths.user.integrations),
    fileExists(DataPaths.user.team),
    fileExists(DataPaths.user.scaffoldingConfig),
    fileExists(`${os.homedir()}/.secrets`),
    parseSecrets(),
    detectWSL(),
    detectDocker(),
  ]);

  const isMacOS = process.platform === 'darwin';
  const isLinuxNative = process.platform === 'linux' && !isWSL && !isDocker;

  const response: DetectResponse = {
    username: os.userInfo().username,
    homeDir: os.homedir(),
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    isWSL,
    isDocker,
    isMacOS,
    isLinuxNative,
    existingConfig: {
      userProfile: hasProfile,
      credentials: hasCredentials,
      integrations: hasIntegrations,
      team: hasTeam,
      scaffoldingConfig: hasScaffoldingConfig,
      secrets: hasSecrets,
    },
    detected: {
      anthropicKeyHint: maskKey(secrets['ANTHROPIC_API_KEY']),
      openrouterKeyHint: maskKey(secrets['OPENROUTER_API_KEY']),
      grokKeyHint: maskKey(secrets['XAI_API_KEY']),
      ollamaUrl: secrets['OLLAMA_URL'] || undefined,
    },
  };

  return NextResponse.json(response);
});
