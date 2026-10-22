// Harness sign-in (Claude Code and Codex logins): types and pure helpers for the badge and sign-in modal.
// Contract: an agent, 18 Oct 2026 (task "Sign-in flow backend"). A credential is one harness login on one machine.

/** Fired when a sign-in finishes or its dialog closes, so every login list, notice and readiness check refreshes at once. */
export const LOGINS_CHANGED_EVENT = 'devflow:logins-changed';
export function announceLoginsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LOGINS_CHANGED_EVENT));
}

/** What the UI calls the laptop that runs agents remotely. */
export const REMOTE_SERVER_NAME = 'Remote server';

const HARNESS_TITLE: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

/** Row and dialog title for a login, e.g. "Claude on the Remote server". */
export function credentialTitle(credential: Pick<HarnessCredential, 'harness' | 'host' | 'label'>): string {
  const name = HARNESS_TITLE[credential.harness];
  if (!name) return credential.label;
  return `${name} on ${credential.host === 'server' ? `the ${REMOTE_SERVER_NAME}` : 'the desktop'}`;
}

export type CredentialState = 'ok' | 'needs_login' | 'limit_reached' | 'unknown';
export type SignInKind = 'paste-code' | 'device-code';
export type SignInState = 'starting' | 'waiting' | 'verifying' | 'done' | 'failed' | 'expired';

export interface SignInSession {
  id: string;
  kind: SignInKind;
  state: SignInState;
  url?: string;
  userCode?: string;
  message?: string;
  expiresAt?: string;
}

export interface HarnessCredential {
  id: string;
  harness: 'claude' | 'codex' | 'antigravity';
  host: 'desktop' | 'server';
  label: string;
  state: CredentialState;
  detail: string;
  plan?: string;
  usage?: { percent: number; window: 'session' | 'weekly'; resetsAt: string };
  checkedAt?: string;
  signIn: SignInSession | null;
  /** Optional plain-text guidance (Codex today): which account to use, and one-time setup with its link. */
  /** The email this login last used (kept across sign-outs). */
  account?: string;
  accountHint?: string;
  setupHint?: string;
  setupUrl?: string;
  setupLabel?: string;
  setupTitle?: string;
  setupSteps?: string[];
  agents: Array<{ id: string; name: string; running: boolean; blocked: boolean }>;
}

export interface HarnessHealth {
  credentialId: string;
  state: 'needs_login' | 'limit_reached';
  detail: string;
  resetsAt?: string;
  since: string;
  /** When the watcher last reported this. A report older than 15 minutes is stale and not shown. */
  reportedAt?: string;
}

export const HEALTH_MAX_AGE_MS = 15 * 60_000;

/** False when the watcher's last report is older than 15 minutes (it may have died); true when there is no report time. */
export function isHealthFresh(health: Pick<HarnessHealth, 'reportedAt'>, now: number = Date.now()): boolean {
  if (!health.reportedAt) return true;
  const at = new Date(health.reportedAt).getTime();
  if (Number.isNaN(at)) return true;
  return now - at <= HEALTH_MAX_AGE_MS;
}

/** Local hour:minute, e.g. "15:50". Empty when the time is missing or not a date. */
export function formatResetTime(resetsAt: string | undefined | null): string {
  if (!resetsAt) return '';
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Text for the card badge. */
export function healthBadgeText(health: Pick<HarnessHealth, 'state' | 'resetsAt'>): string {
  if (health.state === 'needs_login') return 'Needs sign-in';
  const at = formatResetTime(health.resetsAt);
  return at ? `Limit reached · resets ${at}` : 'Limit reached';
}

/** The credential list from GET /api/system/harness-auth. A failed or missing endpoint means no data. */
export function parseCredentials(httpOk: boolean, body: unknown): HarnessCredential[] | null {
  if (!httpOk || !body || typeof body !== 'object') return null;
  const list = (body as { credentials?: unknown }).credentials;
  if (!Array.isArray(list)) return null;
  return list.filter((item): item is HarnessCredential => !!item && typeof (item as HarnessCredential).id === 'string');
}

/** A sign-in can be started for a credential that needs it (or whose state is unknown), when none is already running. */
export function canStartSignIn(credential: Pick<HarnessCredential, 'state' | 'signIn'>): boolean {
  if (credential.state === 'limit_reached' || credential.state === 'ok') return false;
  return !credential.signIn || ['done', 'failed', 'expired'].includes(credential.signIn.state);
}

export function isSignInActive(signIn: SignInSession | null | undefined): boolean {
  return !!signIn && ['starting', 'waiting', 'verifying'].includes(signIn.state);
}

/** Plain-English text for the sign-in routes' refusals. The pasted code is never part of any message. */
export function describeSignInError(code: unknown, fallback?: unknown): string {
  switch (code) {
    case 'BAD_CODE': return "That code didn't work. Check you copied all of it and try again.";
    case 'HOST_OFFLINE': return "That machine isn't answering. Check it is on and connected, then try again.";
    case 'SIGN_IN_ACTIVE': return 'A sign-in is already in progress for this login.';
    default: return typeof fallback === 'string' && fallback ? fallback : 'Something went wrong. Please try again.';
  }
}

/** Whole minutes left before a one-time code expires, or null when there is no expiry. */
export function minutesLeft(expiresAt: string | undefined, now: number = Date.now()): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 60000));
}

/** A login whose program is missing on that machine: nothing to sign in to, so no button. */
export function isNotInstalled(credential: Pick<HarnessCredential, 'state' | 'detail'>): boolean {
  return credential.state === 'unknown' && /not installed/i.test(credential.detail || '');
}

export type LoginAction = 'sign-in' | 'continue' | 'details' | 'none';

/** What the Logins list offers for a credential. */
export function loginAction(credential: HarnessCredential): LoginAction {
  if (isSignInActive(credential.signIn)) return 'continue';
  if (isNotInstalled(credential)) return 'none';
  if (credential.state === 'limit_reached') return 'details';
  if (credential.state === 'needs_login' || credential.state === 'unknown') return 'sign-in';
  return 'none';
}

/** True when the login needs a person (not signed in, at its limit, or a sign-in is waiting). */
export function needsAttention(credential: HarnessCredential): boolean {
  return credential.state === 'needs_login' || credential.state === 'limit_reached' || isSignInActive(credential.signIn);
}
