import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dir: string;

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/app-paths', () => ({ APP_DATA_DIR: dir }));
  return import('../../teams-integration/lib/notification-secret');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-secret-'));
  delete process.env.TEAMS_NOTIFICATION_SECRET;
});
afterEach(() => {
  delete process.env.TEAMS_NOTIFICATION_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.doUnmock('@/lib/app-paths');
});

describe('Teams notification secret', () => {
  it('uses TEAMS_NOTIFICATION_SECRET when it is set', async () => {
    process.env.TEAMS_NOTIFICATION_SECRET = ' from-the-environment ';
    const { teamsNotificationSecret } = await load();
    expect(teamsNotificationSecret()).toBe('from-the-environment');
    expect(fs.existsSync(path.join(dir, 'teams-notification-secret'))).toBe(false);
  });

  it('otherwise makes a random secret once, keeps it private, and never uses the old built-in default', async () => {
    const { teamsNotificationSecret, resetTeamsNotificationSecretForTests } = await load();
    const first = teamsNotificationSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe('devflow-teams-bridge');
    const file = path.join(dir, 'teams-notification-secret');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    resetTeamsNotificationSecretForTests();                      // as after a restart
    expect(teamsNotificationSecret()).toBe(first);
  });

  it('two installs get different secrets', async () => {
    const a = (await load()).teamsNotificationSecret();
    fs.rmSync(path.join(dir, 'teams-notification-secret'));
    const b = (await load()).teamsNotificationSecret();
    expect(a).not.toBe(b);
  });

  it('a stored value that is too short is replaced', async () => {
    fs.writeFileSync(path.join(dir, 'teams-notification-secret'), 'short\n');
    const secret = (await load()).teamsNotificationSecret();
    expect(secret.length).toBe(64);
  });

  it('a short stored file keeps mode 0600 after it is replaced, and an existing good secret is never overwritten', async () => {
    const file = path.join(dir, 'teams-notification-secret');
    fs.writeFileSync(file, 'short\n', { mode: 0o644 });
    const first = (await load()).teamsNotificationSecret();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await load()).teamsNotificationSecret()).toBe(first);
  });

  it('a symlink planted at the secret path is not written through', async () => {
    const target = path.join(dir, 'victim');
    fs.writeFileSync(target, 'keep-me');
    fs.symlinkSync(target, path.join(dir, 'teams-notification-secret'));
    const secret = (await load()).teamsNotificationSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep-me');                       // the link's target was not written
    expect(fs.lstatSync(path.join(dir, 'teams-notification-secret')).isSymbolicLink()).toBe(false);
  });

  it('matchesTeamsNotificationSecret accepts only the exact secret and only strings', async () => {
    process.env.TEAMS_NOTIFICATION_SECRET = 'exact-secret';
    const { matchesTeamsNotificationSecret } = await load();
    expect(matchesTeamsNotificationSecret('exact-secret')).toBe(true);
    for (const bad of ['exact-secre', 'exact-secret ', 'Exact-secret', '', undefined, null, 123, ['exact-secret']]) expect(matchesTeamsNotificationSecret(bad)).toBe(false);
  });

  it('no source file carries the old default any more', () => {
    const grep = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : grep(p);
      return /\.(ts|tsx)$/.test(e.name) && !p.endsWith('teams-notification-secret.test.ts') && fs.readFileSync(p, 'utf8').includes('devflow-teams-bridge') ? [p] : [];
    });
    const root = path.resolve(__dirname, '../..');
    expect([...grep(path.join(root, 'app')), ...grep(path.join(root, 'teams-integration')), ...grep(path.join(root, 'lib'))]).toEqual([]);
  });
});
