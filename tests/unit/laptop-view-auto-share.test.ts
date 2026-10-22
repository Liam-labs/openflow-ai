import { describe, expect, it } from 'vitest';
import { LaptopViewError, prepareLaptopLaunch, type LaptopViewDeps } from '@/lib/laptop-view';

const WD = '/home/user/DaVinci-Resolve-Automation/Team/Jack';
const MEM = '/home/user/.claude/projects/-home-user-DaVinci-Resolve-Automation-Team-Jack';
const input = { workingDirectory: WD, agentName: 'Jack' };

function fakeDeps(opts: { shareAppears?: boolean; requestFails?: string; probeCodes?: Array<{ code: number; stderr: string }> } = {}) {
  let registry: Record<string, { desktopPath: string }> = { sg1: { desktopPath: '/home/user/SG-1' } };
  let clock = 0;
  const calls = { requests: 0, probes: 0 };
  const probeCodes = opts.probeCodes ?? [{ code: 0, stderr: '' }];
  const deps: LaptopViewDeps = {
    readRegistry: async () => ({ roots: registry }),
    probe: async () => probeCodes[Math.min(calls.probes++, probeCodes.length - 1)],
    requestShare: async () => {
      calls.requests++;
      if (opts.requestFails) throw new Error(opts.requestFails);
      if (opts.shareAppears !== false) registry = { ...registry, 'agent-jack': { desktopPath: WD }, 'mem-jack': { desktopPath: MEM } };
    },
    sleep: async ms => { clock += ms; },
    now: () => clock,
  };
  return { deps, calls };
}

describe('prepareLaptopLaunch asks the desktop to share a new agent folder', () => {
  it('shares, waits, and starts when the folders were not shared', async () => {
    const { deps, calls } = fakeDeps();
    const launch = await prepareLaptopLaunch(input, deps);
    expect(calls.requests).toBe(1);
    expect(launch.roots).toEqual(['agent-jack', 'mem-jack']);
  });

  it('does not ask when everything is already shared', async () => {
    const { deps, calls } = fakeDeps();
    await deps.requestShare!({ agentName: 'Jack', workingDirectory: WD });
    calls.requests = 0;
    await prepareLaptopLaunch(input, deps);
    expect(calls.requests).toBe(0);
  });

  it('keeps the plain reason and the manual command when the desktop refuses', async () => {
    const { deps } = fakeDeps({ requestFails: 'path not allowed' });
    const err = await prepareLaptopLaunch(input, deps).catch(e => e);
    expect(err).toBeInstanceOf(LaptopViewError);
    expect(err.code).toBe('NOT_SHARED');
    expect(err.message).toContain('devflow-share agent Jack');
    expect(err.message).toContain('path not allowed');
  });

  it('fails closed, not open, when the desktop accepts but the folders never answer', async () => {
    const { deps, calls } = fakeDeps({ shareAppears: false });
    const err = await prepareLaptopLaunch(input, deps).catch(e => e);
    expect(err).toBeInstanceOf(LaptopViewError);
    expect(err.code).toBe('NOT_SHARED');
    expect(calls.requests).toBe(1);
  });

  it('never asks the desktop when it is off or asleep', async () => {
    const { deps, calls } = fakeDeps({ probeCodes: [{ code: 2, stderr: 'devflow-agent-view: folder agent-jack is not available' }] });
    await deps.requestShare!({ agentName: 'Jack', workingDirectory: WD });
    calls.requests = 0;
    const err = await prepareLaptopLaunch(input, deps).catch(e => e);
    expect(err.code).toBe('UNAVAILABLE');
    expect(calls.requests).toBe(0);
  });

  it('waits through a share that is registered but not mounted yet', async () => {
    const { deps } = fakeDeps({ probeCodes: [{ code: 2, stderr: 'devflow-agent-view: folder agent-jack is not available' }, { code: 0, stderr: '' }] });
    const launch = await prepareLaptopLaunch(input, deps);
    expect(launch.roots).toContain('agent-jack');
  });
});
