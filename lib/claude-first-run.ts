/**
 * Claude Code asks a new user a few questions before it will take a message: pick a colour theme, say whether to use the API key it
 * found in the environment, (when started with permissions bypassed) accept a warning, and on recent versions "Try the new fullscreen
 * renderer?". On a person's own machine they answer once. An agent DevFlow starts for them cannot, so a person who finished the setup
 * wizard would see their first agent stuck on a menu.
 *
 * The fullscreen-renderer question is the worst of these for an agent. Its Enter eats the hello message, and picking "Yes" makes Claude
 * save the renderer choice and relaunch itself WITHOUT the wrapper's arguments (no --dangerously-skip-permissions, no --allowedTools, no
 * transport prompt), so the agent then answers in its own terminal where nobody is reading (BUG-51, 2026-10-30). We answer it in advance
 * by writing an explicit renderer choice and marking the upsell as seen, exactly as an established working agent already has them.
 *
 * This fills in the answers in Claude Code's own settings files, only where they are missing, for every auth mode (subscription mode
 * passes no key, so the key approval is skipped). It never changes a value that is already there, and never touches a login.
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
  // "Try the new fullscreen renderer?" is shown until it has been seen a few times. Marking it seen stops the question appearing, which
  // stops its Enter eating the hello and stops the renderer "switch" that relaunches Claude without the wrapper's arguments (BUG-51).
  if (next.fullscreenUpsellSeenCount === undefined) {
    next.fullscreenUpsellSeenCount = 3;
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
  const next: Record<string, unknown> = { ...current };
  let changed = false;
  if (next.skipDangerousModePermissionPrompt === undefined) {
    next.skipDangerousModePermissionPrompt = true;
    changed = true;
  }
  // Pin the renderer so Claude never shows the fullscreen-renderer upsell and never relaunches itself to "switch" (BUG-51). "fullscreen"
  // is what every established working agent runs with; the wrapper's pane capture and startup-dialog detection are tuned against it.
  if (next.tui === undefined) {
    next.tui = 'fullscreen';
    changed = true;
  }
  return { next, changed };
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
