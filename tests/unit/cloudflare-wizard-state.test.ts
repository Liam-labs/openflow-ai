import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/dashboard-auth', () => ({ hasPassword: async () => true }));
vi.mock('@/lib/data-paths', () => ({ DataPaths: { wizards: {} , user: { profile: '/tmp/none' } } }));

import { wizardState, gitEmail } from '@/lib/wizards/cloudflare-service';
import { tokenLink } from '@/lib/wizards/cloudflare-token-link';

const runner = { installed: async () => ({ path: null, version: null }), running: async () => false } as never;
const io = (env: Record<string, string | undefined>) => ({ env, readRecord: async () => ({ enabled: false, stage: 'none' }) }) as never;

describe('wizardState carries the pre-filled token link', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('names the token OpenFlow, or OpenFlow with the instance label of a test copy', async () => {
    const plain = await wizardState(io({}), runner);
    expect(plain.tokenName).toBe('OpenFlow');
    expect(plain.tokenLink).toBe(tokenLink('OpenFlow'));
    const test = await wizardState(io({ DEVFLOW_INSTANCE_LABEL: 'test' }), runner);
    expect(test.tokenName).toBe('OpenFlow test');
    expect(new URL(test.tokenLink).searchParams.get('name')).toBe('OpenFlow test');
  });

  it('lists the four permissions the link asks for', async () => {
    const s = await wizardState(io({}), runner);
    expect(s.permissions.map(p => p.key)).toEqual(['argotunnel', 'access', 'dns', 'zone']);
  });

  it('offers DEVFLOW_DEFAULT_EMAIL first, trimmed, and falls back to git when it is empty or blank', async () => {
    expect((await wizardState(io({ DEVFLOW_DEFAULT_EMAIL: '  me@example.com ' }), runner)).defaultEmail).toBe('me@example.com');
    const git = await gitEmail();
    expect((await wizardState(io({ DEVFLOW_DEFAULT_EMAIL: '   ' }), runner)).defaultEmail).toBe(git);
    expect((await wizardState(io({ DEVFLOW_DEFAULT_EMAIL: '' }), runner)).defaultEmail).toBe(git);
  });

  it('offers an email address that is empty or looks like one, and never throws', async () => {
    const e = await gitEmail();
    expect(e === '' || /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e)).toBe(true);
    const s = await wizardState(io({}), runner);
    expect(typeof s.defaultEmail).toBe('string');
  });
});
