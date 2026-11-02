import { describe, expect, it } from 'vitest';
import { authLabel, connectionBadge } from '@/lib/connection-status';

describe('connectionBadge', () => {
  it('shows each status the catalog uses with a clear word and a sensible colour', () => {
    expect(connectionBadge('active')).toEqual({ badge: 'active', label: 'Active' });
    expect(connectionBadge('configured')).toEqual({ badge: 'configured', label: 'Key set' });
    expect(connectionBadge('configured_not_active')).toEqual({ badge: 'configured', label: 'Not in use' });
    expect(connectionBadge('needs_attention')).toEqual({ badge: 'errored', label: 'Needs attention' });
    expect(connectionBadge('needs_login')).toEqual({ badge: 'warning', label: 'Needs sign-in' });
    expect(connectionBadge('not_configured')).toEqual({ badge: 'warning', label: 'Not configured' });
    expect(connectionBadge('retired')).toEqual({ badge: 'stopped', label: 'Retired' });
    expect(connectionBadge('pending').badge).toBe('pending');
  });
  it('never invents a state for a word it does not know', () => {
    expect(connectionBadge('whatever')).toEqual({ badge: 'unknown', label: 'Unknown' });
    expect(connectionBadge('')).toEqual({ badge: 'unknown', label: 'Unknown' });
  });
});

describe('authLabel', () => {
  it('writes the sign-in method in words', () => {
    expect(authLabel('api_key')).toBe('API key');
    expect(authLabel('oauth')).toBe('OAuth');
    expect(authLabel('subscription')).toBe('Subscription');
    expect(authLabel('service_principal')).toBe('Service principal');
    expect(authLabel('browser sign-in')).toBe('Browser sign-in');
    expect(authLabel('desktop_app')).toBe('Desktop app');
    expect(authLabel(undefined)).toBe('—');
  });
});
