import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { applyClaudeJson, applySettingsJson, apiKeyApprovalId, ensureClaudeFirstRun } from '@/lib/claude-first-run';

const KEY = 'sk-ant-api03-FAKE-aaaaaaaaaaaaaaaaaaaaaaaa-0123456789ABCDEFGHIJ';

describe('applyClaudeJson', () => {
  it('fills the missing answers and approves the key by its last 20 characters', () => {
    const { next, changed } = applyClaudeJson({}, KEY);
    expect(changed).toBe(true);
    expect(next.hasCompletedOnboarding).toBe(true);
    expect(next.theme).toBe('dark');
    expect(next.customApiKeyResponses).toEqual({ approved: [KEY.slice(-20)], rejected: [] });
    expect(next.fullscreenUpsellSeenCount).toBe(3);
    expect(apiKeyApprovalId(KEY)).toHaveLength(20);
  });

  it('never changes an answer the person already gave', () => {
    const current = { hasCompletedOnboarding: false, theme: 'light', other: 1, fullscreenUpsellSeenCount: 1, customApiKeyResponses: { approved: ['x'], rejected: [KEY.slice(-20)] } };
    const { next, changed } = applyClaudeJson(current, KEY);
    expect(changed).toBe(false);
    expect(next).toEqual(current);
  });

  it('keeps other approved keys and adds this one once', () => {
    const first = applyClaudeJson({ customApiKeyResponses: { approved: ['older'], rejected: [] } }, KEY).next;
    expect((first.customApiKeyResponses as { approved: string[] }).approved).toEqual(['older', KEY.slice(-20)]);
    expect(applyClaudeJson(first, KEY).changed).toBe(false);
  });

  it('does not approve anything without a key', () => {
    const { next } = applyClaudeJson({}, '');
    expect(next.customApiKeyResponses).toBeUndefined();
  });
});

describe('applySettingsJson', () => {
  it('turns the bypass warning off only when unset', () => {
    expect(applySettingsJson({}).next).toEqual({ skipDangerousModePermissionPrompt: true, tui: 'fullscreen' });
    // A person's explicit choices stay; nothing is added when both are already set.
    expect(applySettingsJson({ skipDangerousModePermissionPrompt: false, tui: 'default' })).toEqual({ next: { skipDangerousModePermissionPrompt: false, tui: 'default' }, changed: false });
  });

  it('pins the renderer so the fullscreen upsell never appears, keeping any explicit permission choice', () => {
    expect(applySettingsJson({ skipDangerousModePermissionPrompt: false })).toEqual({ next: { skipDangerousModePermissionPrompt: false, tui: 'fullscreen' }, changed: true });
    expect(applySettingsJson({ tui: 'default' })).toEqual({ next: { tui: 'default', skipDangerousModePermissionPrompt: true }, changed: true });
  });
});

describe('ensureClaudeFirstRun', () => {
  let home: string;
  beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'cfr-')); });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

  it('writes both files on a fresh machine, privately, and is idempotent', async () => {
    expect(await ensureClaudeFirstRun(home, KEY)).toEqual({ claudeJson: true, settingsJson: true });
    expect((await fs.stat(path.join(home, '.claude.json'))).mode & 0o777).toBe(0o600);
    expect(await ensureClaudeFirstRun(home, KEY)).toEqual({ claudeJson: false, settingsJson: false });
  });

  it('leaves a damaged file alone', async () => {
    await fs.writeFile(path.join(home, '.claude.json'), '{not json');
    const result = await ensureClaudeFirstRun(home, KEY);
    expect(result.claudeJson).toBe(false);
    expect(await fs.readFile(path.join(home, '.claude.json'), 'utf-8')).toBe('{not json');
  });

  it('subscription mode (no key): answers the welcome and the warning, keeps the login details, adds no key approval', async () => {
    const signedIn = { oauthAccount: { emailAddress: 'user@example.com' }, numStartups: 2 };
    await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify(signedIn));
    const result = await ensureClaudeFirstRun(home, '');
    expect(result).toEqual({ claudeJson: true, settingsJson: true });
    const after = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf-8'));
    expect(after).toEqual({ ...signedIn, hasCompletedOnboarding: true, theme: 'dark', fullscreenUpsellSeenCount: 3 });
    expect(JSON.parse(await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf-8'))).toEqual({ skipDangerousModePermissionPrompt: true, tui: 'fullscreen' });
  });

  it('keeps unrelated settings', async () => {
    await fs.mkdir(path.join(home, '.claude'));
    await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'x' }));
    await ensureClaudeFirstRun(home, '');
    expect(JSON.parse(await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf-8'))).toEqual({ model: 'x', skipDangerousModePermissionPrompt: true, tui: 'fullscreen' });
  });
});
