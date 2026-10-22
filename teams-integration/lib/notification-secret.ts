/**
 * The shared secret Microsoft Graph echoes back in every Teams notification (clientState), so we can tell a real
 * notification from a forged one.
 *
 * TEAMS_NOTIFICATION_SECRET if it is set. Otherwise a random secret is made once and kept in the app's data folder (mode
 * 0600): there is no built-in default, because a default is known to everyone who reads the source and would let anyone who
 * can reach the webhook put messages into a channel.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { APP_DATA_DIR } from '@/lib/app-paths';

let cached: string | null = null;

export function teamsNotificationSecret(): string {
  const fromEnv = process.env.TEAMS_NOTIFICATION_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (cached) return cached;
  const file = path.join(APP_DATA_DIR, 'teams-notification-secret');
  try {
    const stored = fs.readFileSync(file, 'utf8').trim();
    if (stored.length >= 32) return (cached = stored);
  } catch {
    // none yet: make one
  }
  const made = randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, made + '\n', { mode: 0o600, flag: 'wx' });      // 'wx': never overwrite, never follow a planted link
    return (cached = made);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Another worker made it first (or an unusable file is there): use what is stored, or replace a short/garbage file safely.
  const stored = fs.readFileSync(file, 'utf8').trim();
  if (stored.length >= 32) return (cached = stored);
  fs.rmSync(file);
  fs.writeFileSync(file, made + '\n', { mode: 0o600, flag: 'wx' });
  return (cached = made);
}

/** Compare a value from a request with the secret without leaking where they differ (or the secret's length). */
export function matchesTeamsNotificationSecret(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const sha = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(sha(candidate), sha(teamsNotificationSecret()));
}

export function resetTeamsNotificationSecretForTests(): void {
  cached = null;
}
