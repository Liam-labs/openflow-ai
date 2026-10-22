/**
 * Claude Code asks a new user a few questions before it will take a message: pick a colour theme, say whether to use the API key it
 * found in the environment, and (when started with permissions bypassed) accept a warning. On a person's own machine they answer once.
 * An agent DevFlow starts for them cannot, so a person who chose "API key" in the setup wizard would see two agents stuck on a menu.
 *
 * This fills in those answers in Claude Code's own settings files, only where they are missing, and only for API-key mode
 * (DEVFLOW_CLAUDE_AUTH=api-key). It never changes a value that is already there, and never touches a login.
 */
import { promises as fs } from 'fs';
import path from 'path';

/** Claude Code identifies an approved key by its last 20 characters. */
export function apiKeyApprovalId(key: string): string {
  return key.slice(-20);
}

export interface FirstRunResult {
  claudeJson: boolean;
  settingsJson: boolean;
}

export function applyClaudeJson(current: Record<string, unknown>, apiKey: string): { next: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...current };
  let changed = false;
  if (next.hasCompletedOnboarding === undefined) {
    next.hasCompletedOnboarding = true;
    changed = true;
  }
  if (next.theme === undefined) {
    next.theme = 'dark';
    changed = true;
  }
  const id = apiKey ? apiKeyApprovalId(apiKey) : '';
  if (id) {
    const old = (next.customApiKeyResponses && typeof next.customApiKeyResponses === 'object' ? next.customApiKeyResponses : {}) as { approved?: unknown; rejected?: unknown };
    const approved = Array.isArray(old.approved) ? (old.approved as string[]) : [];
    const rejected = Array.isArray(old.rejected) ? (old.rejected as string[]) : [];
    // A person who said "no" to this key keeps their answer.
    if (!approved.includes(id) && !rejected.includes(id)) {
      next.customApiKeyResponses = { ...old, approved: [...approved, id], rejected };
      changed = true;
    }
  }
  return { next, changed };
}

export function applySettingsJson(current: Record<string, unknown>): { next: Record<string, unknown>; changed: boolean } {
  if (current.skipDangerousModePermissionPrompt !== undefined) return { next: current, changed: false };
  return { next: { ...current, skipDangerousModePermissionPrompt: true }, changed: true };
}

async function readObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return null; // unreadable or not an object: leave the file alone
  }
}

async function writeAtomic(file: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.openflow-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function ensureClaudeFirstRun(homeDir: string, apiKey: string): Promise<FirstRunResult> {
  const result: FirstRunResult = { claudeJson: false, settingsJson: false };
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  const claudeJson = await readObject(claudeJsonPath);
  if (claudeJson) {
    const { next, changed } = applyClaudeJson(claudeJson, apiKey);
    if (changed) {
      await writeAtomic(claudeJsonPath, next);
      result.claudeJson = true;
    }
  }
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  const settings = await readObject(settingsPath);
  if (settings) {
    const { next, changed } = applySettingsJson(settings);
    if (changed) {
      await writeAtomic(settingsPath, next);
      result.settingsJson = true;
    }
  }
  return result;
}
