import { describe, it, expect } from 'vitest';
import {
  parseLaptopStatus, laptopTooltip, runsOnOf, runsOnFields, describeRunLocationError, LAPTOP_NOT_SET_UP,
} from '@/lib/laptop-agents';

describe('parseLaptopStatus', () => {
  it('treats a failed request (404 until the endpoint ships) as not ready', () => {
    expect(parseLaptopStatus(false, null)).toEqual({ ready: false, mode: null, reason: LAPTOP_NOT_SET_UP });
    expect(parseLaptopStatus(true, 'nonsense').ready).toBe(false);
  });
  it('is ready with its mode', () => {
    expect(parseLaptopStatus(true, { ready: true, mode: 'files-only', checks: [] })).toEqual({ ready: true, mode: 'files-only', reason: '' });
    expect(parseLaptopStatus(true, { ready: true, mode: 'files-and-commands' }).mode).toBe('files-and-commands');
  });
  it('explains with the first failing check', () => {
    const status = parseLaptopStatus(true, { ready: false, mode: 'files-only', checks: [
      { id: 'a', label: 'SSH', ok: true, detail: 'ok' },
      { id: 'b', label: 'Claude login', ok: false, detail: 'Claude is not logged in on the laptop' },
      { id: 'c', label: 'Share', ok: false, detail: 'share missing' },
    ] });
    expect(status).toEqual({ ready: false, mode: 'files-only', reason: 'Claude is not logged in on the laptop', failingCheckId: 'b' });
  });
  it('falls back to the label, then to the generic reason', () => {
    expect(parseLaptopStatus(true, { ready: false, checks: [{ ok: false, label: 'Share' }] }).reason).toBe('Share');
    expect(parseLaptopStatus(true, { ready: false, checks: [] }).reason).toBe(LAPTOP_NOT_SET_UP);
  });
});

describe('laptopTooltip', () => {
  it('has the contract wording for each mode', () => {
    expect(laptopTooltip('files-only')).toBe('Runs on the Remote server. Files are shared from the desktop; commands run on the server.');
    expect(laptopTooltip('files-and-commands')).toBe('Runs on the Remote server. Files and commands go to the desktop.');
    expect(laptopTooltip(null)).toContain('commands run on the server');
  });
});

describe('runsOnOf / runsOnFields', () => {
  it('reads an agent record', () => {
    expect(runsOnOf({})).toBe('wsl');
    expect(runsOnOf({ spawnMode: 'powershell' })).toBe('powershell');
    expect(runsOnOf({ runLocation: 'server' })).toBe('laptop');
    expect(runsOnOf({ runLocation: 'server', spawnMode: 'powershell' })).toBe('laptop');
  });
  it('produces the fields to send', () => {
    expect(runsOnFields('laptop')).toEqual({ spawnMode: 'wsl', runLocation: 'server' });
    expect(runsOnFields('wsl')).toEqual({ spawnMode: 'wsl', runLocation: null });
    expect(runsOnFields('powershell')).toEqual({ spawnMode: 'powershell', runLocation: null });
  });
});

describe('describeRunLocationError', () => {
  it('maps the three refusals', () => {
    expect(describeRunLocationError('RUN_LOCATION_REQUIRES_STOP', 'x')).toBe('Stop the agent to move it.');
    expect(describeRunLocationError('RUN_LOCATION_POWERSHELL', 'x')).toContain('PowerShell');
    expect(describeRunLocationError('LAPTOP_NOT_READY', 'x')).toContain('isn\'t ready');
  });
  it('keeps the server message for other errors', () => {
    expect(describeRunLocationError(undefined, 'Boom')).toBe('Boom');
    expect(describeRunLocationError(undefined, undefined)).toBe('Could not save where this agent runs.');
  });
});
