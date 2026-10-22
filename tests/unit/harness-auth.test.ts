import { describe, it, expect } from 'vitest';
import {
  formatResetTime, healthBadgeText, parseCredentials, canStartSignIn, isSignInActive, describeSignInError, minutesLeft,
  isHealthFresh, isNotInstalled, loginAction, needsAttention, type HarnessCredential,
} from '@/lib/harness-auth';

describe('healthBadgeText', () => {
  it('says Needs sign-in for needs_login', () => {
    expect(healthBadgeText({ state: 'needs_login' })).toBe('Needs sign-in');
  });
  it('adds the local reset time to Limit reached', () => {
    const at = new Date(2026, 9, 18, 15, 50).toISOString();
    expect(healthBadgeText({ state: 'limit_reached', resetsAt: at })).toBe('Limit reached · resets 15:50');
  });
  it('is plain Limit reached without a usable time', () => {
    expect(healthBadgeText({ state: 'limit_reached' })).toBe('Limit reached');
    expect(healthBadgeText({ state: 'limit_reached', resetsAt: 'soon' })).toBe('Limit reached');
  });
});

describe('formatResetTime', () => {
  it('pads hours and minutes', () => {
    expect(formatResetTime(new Date(2026, 0, 2, 7, 5).toISOString())).toBe('07:05');
    expect(formatResetTime(undefined)).toBe('');
  });
});

describe('parseCredentials', () => {
  it('treats a 404 or bad body as no data', () => {
    expect(parseCredentials(false, null)).toBeNull();
    expect(parseCredentials(true, {})).toBeNull();
    expect(parseCredentials(true, 'x')).toBeNull();
  });
  it('returns the credentials', () => {
    const list = parseCredentials(true, { credentials: [{ id: 'claude@server' }, { nope: 1 }] });
    expect(list).toEqual([{ id: 'claude@server' }]);
  });
});

describe('canStartSignIn / isSignInActive', () => {
  it('allows sign-in only for a login that needs it and has none running', () => {
    expect(canStartSignIn({ state: 'needs_login', signIn: null })).toBe(true);
    expect(canStartSignIn({ state: 'unknown', signIn: null })).toBe(true);
    expect(canStartSignIn({ state: 'limit_reached', signIn: null })).toBe(false);
    expect(canStartSignIn({ state: 'ok', signIn: null })).toBe(false);
    expect(canStartSignIn({ state: 'needs_login', signIn: { id: 's', kind: 'paste-code', state: 'waiting' } })).toBe(false);
    expect(canStartSignIn({ state: 'needs_login', signIn: { id: 's', kind: 'paste-code', state: 'expired' } })).toBe(true);
  });
  it('knows an active sign-in', () => {
    expect(isSignInActive({ id: 's', kind: 'device-code', state: 'verifying' })).toBe(true);
    expect(isSignInActive({ id: 's', kind: 'device-code', state: 'done' })).toBe(false);
    expect(isSignInActive(null)).toBe(false);
  });
});

describe('describeSignInError', () => {
  it('explains the known codes without echoing anything', () => {
    expect(describeSignInError('BAD_CODE')).toContain("didn't work");
    expect(describeSignInError('HOST_OFFLINE')).toContain("isn't answering");
    expect(describeSignInError('SIGN_IN_ACTIVE')).toContain('already in progress');
    expect(describeSignInError(undefined, 'Boom')).toBe('Boom');
  });
});

describe('minutesLeft', () => {
  it('counts whole minutes up to the expiry', () => {
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    expect(minutesLeft(new Date(now + 14 * 60000 + 1000).toISOString(), now)).toBe(15);
    expect(minutesLeft(new Date(now - 5000).toISOString(), now)).toBe(0);
    expect(minutesLeft(undefined, now)).toBeNull();
  });
});

describe('isHealthFresh', () => {
  const now = Date.UTC(2026, 9, 18, 12, 0, 0);
  it('hides a report older than 15 minutes', () => {
    expect(isHealthFresh({ reportedAt: new Date(now - 16 * 60000).toISOString() }, now)).toBe(false);
    expect(isHealthFresh({ reportedAt: new Date(now - 14 * 60000).toISOString() }, now)).toBe(true);
  });
  it('shows a report with no usable time', () => {
    expect(isHealthFresh({}, now)).toBe(true);
    expect(isHealthFresh({ reportedAt: 'nonsense' }, now)).toBe(true);
  });
});

const credential = (over: Partial<HarnessCredential>): HarnessCredential => ({
  id: 'claude@server', harness: 'claude', host: 'server', label: 'Claude on the laptop', state: 'needs_login', detail: '', signIn: null, agents: [], ...over,
});

describe('loginAction / needsAttention / isNotInstalled', () => {
  it('offers Sign in for a login that needs it', () => {
    expect(loginAction(credential({ state: 'needs_login' }))).toBe('sign-in');
    expect(loginAction(credential({ state: 'unknown', detail: 'Could not check' }))).toBe('sign-in');
  });
  it('offers no button when the program is not installed', () => {
    const missing = credential({ state: 'unknown', detail: 'Claude is not installed on this machine' });
    expect(isNotInstalled(missing)).toBe(true);
    expect(loginAction(missing)).toBe('none');
  });
  it('offers Continue while a sign-in runs, Details at a limit, nothing when fine', () => {
    expect(loginAction(credential({ signIn: { id: 's', kind: 'paste-code', state: 'waiting' } }))).toBe('continue');
    expect(loginAction(credential({ state: 'limit_reached' }))).toBe('details');
    expect(loginAction(credential({ state: 'ok' }))).toBe('none');
  });
  it('flags what needs a person', () => {
    expect(needsAttention(credential({ state: 'ok' }))).toBe(false);
    expect(needsAttention(credential({ state: 'needs_login' }))).toBe(true);
    expect(needsAttention(credential({ state: 'limit_reached' }))).toBe(true);
    expect(needsAttention(credential({ state: 'unknown', detail: 'Claude is not installed on this machine' }))).toBe(false);
  });
});
