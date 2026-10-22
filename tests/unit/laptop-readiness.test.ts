import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ channels: { channels: [] as unknown[], lastUpdated: '' }, registry: {} as unknown }));
vi.mock('@/lib/data-io', () => ({ readJsonFile: async (file: string) => (String(file).endsWith('service-locations.json') ? h.registry : h.channels) }));
vi.mock('@/lib/data-paths', () => ({ DataPaths: { collabChannels: '/x/channels.json', base: '/x' } }));
vi.mock('@/lib/app-paths', () => ({ appPath: (...parts: string[]) => `/app/${parts.join('/')}` }));

import {
  decideRunLocationChange, evaluateReadiness, laptopReadiness, refuseRunLocationChange,
  type ReadinessDeps, type Readiness,
} from '@/lib/laptop-readiness';

const probes = (claude: string | null, codex: string | null = null) => ({
  claude: claude ? { state: claude, detail: 'x' } : null, codex: codex ? { state: codex, detail: 'x' } : null,
});
const ready: Readiness = evaluateReadiness({ probes: probes('ok'), fileShare: true, desktopCommands: false });
const notReady: Readiness = evaluateReadiness({ probes: probes('unknown', 'unknown'), fileShare: false, desktopCommands: false });

describe('evaluateReadiness', () => {
  it('names the root cause first: nothing installed', () => {
    const r = evaluateReadiness({ probes: probes('unknown', 'unknown'), fileShare: false, desktopCommands: false });
    expect(r.ready).toBe(false);
    expect(r.checks.map(c => [c.id, c.ok])).toEqual([['program', false], ['signed-in', false], ['file-share', false]]);
    expect(r.checks[0].detail).toMatch(/not installed/);
  });
  it('then installed but nobody signed in', () => {
    const r = evaluateReadiness({ probes: probes('needs_login', 'unknown'), fileShare: true, desktopCommands: false });
    expect(r.checks.map(c => c.ok)).toEqual([true, false, true]);
    expect(r.checks[1].detail).toBe('Nothing is signed in on the Remote server yet.');
  });
  it('then the shared folders', () => {
    const r = evaluateReadiness({ probes: probes('ok'), fileShare: false, desktopCommands: false });
    expect(r.checks.map(c => c.ok)).toEqual([true, true, false]);
    expect(r.checks[2].detail).toMatch(/shared desktop folders/);
  });
  it('is ready when one program is signed in and the folders are shared', () => {
    expect(evaluateReadiness({ probes: probes('ok', 'unknown'), fileShare: true, desktopCommands: false }).ready).toBe(true);
    expect(evaluateReadiness({ probes: probes(null, 'ok'), fileShare: true, desktopCommands: false }).ready).toBe(true);
  });
  it('treats a program that could not be checked as not installed, never as ok', () => {
    expect(evaluateReadiness({ probes: probes(null, null), fileShare: true, desktopCommands: false }).checks[0].ok).toBe(false);
  });
  it('reports files-only until command access is switched on', () => {
    expect(evaluateReadiness({ probes: probes('ok'), fileShare: true, desktopCommands: false }).mode).toBe('files-only');
    expect(evaluateReadiness({ probes: probes('ok'), fileShare: true, desktopCommands: true }).mode).toBe('files-and-commands');
  });
});

describe('decideRunLocationChange', () => {
  const base = { status: 'stopped', spawnMode: 'wsl', readiness: ready };
  it('allows no change at all, even for a running agent', () => {
    expect(decideRunLocationChange({ ...base, wanted: 'server', current: 'server', status: 'running' })).toBeNull();
    expect(decideRunLocationChange({ ...base, wanted: 'desktop', current: 'desktop', status: 'running' })).toBeNull();
  });
  it('refuses to move a running agent in either direction, 409 REQUIRES_STOP', () => {
    for (const status of ['running', 'starting', 'stopping', undefined]) {
      for (const [wanted, current] of [['server', 'desktop'], ['desktop', 'server']] as const) {
        expect(decideRunLocationChange({ ...base, wanted, current, status })).toMatchObject({ status: 409, code: 'RUN_LOCATION_REQUIRES_STOP', message: 'Stop the agent to move it.' });
      }
    }
  });
  it('treats stopped and crashed agents as movable', () => {
    for (const status of ['stopped', 'crashed']) expect(decideRunLocationChange({ ...base, status, wanted: 'server', current: 'desktop' })).toBeNull();
  });
  it('refuses PowerShell on the laptop with 400', () => {
    expect(decideRunLocationChange({ ...base, spawnMode: 'powershell', wanted: 'server', current: 'desktop' })).toMatchObject({ status: 400, code: 'RUN_LOCATION_POWERSHELL' });
  });
  it('refuses the laptop while it is not ready, with the failing checks as details', () => {
    const r = decideRunLocationChange({ ...base, readiness: notReady, wanted: 'server', current: 'desktop' });
    expect(r).toMatchObject({ status: 409, code: 'LAPTOP_NOT_READY', message: notReady.checks[0].detail });
    expect(r?.details?.map(c => c.id)).toEqual(['program', 'signed-in', 'file-share']);
  });
  it('lets an agent move back to the desktop even when the laptop is not ready', () => {
    expect(decideRunLocationChange({ ...base, readiness: notReady, wanted: 'desktop', current: 'server' })).toBeNull();
  });
  it('checks stop before the others, so the message is the simplest fix', () => {
    expect(decideRunLocationChange({ status: 'running', spawnMode: 'powershell', readiness: notReady, wanted: 'server', current: 'desktop' })?.code).toBe('RUN_LOCATION_REQUIRES_STOP');
  });
});

describe('refuseRunLocationChange', () => {
  let probeCalls = 0;
  const deps = (r: 'ready' | 'not'): ReadinessDeps => ({
    probes: async () => { probeCalls += 1; return r === 'ready' ? probes('ok') : probes('unknown', 'unknown'); },
    flags: async () => ({ fileShare: r === 'ready', desktopCommands: false }),
  });
  const channel = (agent: Record<string, unknown>) => { h.channels = { channels: [{ id: 'c1', roster: { agents: [agent] } }], lastUpdated: '' }; };
  beforeEach(() => { probeCalls = 0; h.channels = { channels: [], lastUpdated: '' }; h.registry = {}; });

  it('an add for the laptop is refused until the laptop is ready, and allowed after', async () => {
    expect(await refuseRunLocationChange({ channelId: 'c1', runLocation: 'server', spawnMode: 'wsl' }, deps('not'))).toMatchObject({ code: 'LAPTOP_NOT_READY' });
    expect(await refuseRunLocationChange({ channelId: 'c1', runLocation: 'server', spawnMode: 'wsl' }, deps('ready'))).toBeNull();
  });
  it('an add for the laptop with PowerShell is refused even when ready', async () => {
    expect(await refuseRunLocationChange({ channelId: 'c1', runLocation: 'server', spawnMode: 'powershell' }, deps('ready'))).toMatchObject({ code: 'RUN_LOCATION_POWERSHELL' });
  });
  it('an add for the desktop never looks at the laptop', async () => {
    expect(await refuseRunLocationChange({ channelId: 'c1', runLocation: null }, deps('not'))).toBeNull();
    expect(await refuseRunLocationChange({ channelId: 'c1' }, deps('not'))).toBeNull();
    expect(probeCalls).toBe(0);
  });
  it('an update compares with what the agent is now', async () => {
    channel({ id: 'a1', status: 'stopped', runLocation: undefined, spawnMode: 'wsl' });
    expect(await refuseRunLocationChange({ channelId: 'c1', agentId: 'a1', runLocation: 'server' }, deps('ready'))).toBeNull();
    expect(await refuseRunLocationChange({ channelId: 'c1', agentId: 'a1', runLocation: 'server' }, deps('not'))).toMatchObject({ code: 'LAPTOP_NOT_READY' });
  });
  it('an update that changes nothing is never refused, even for a running agent, and does not probe', async () => {
    channel({ id: 'a1', status: 'running', runLocation: 'server' });
    expect(await refuseRunLocationChange({ channelId: 'c1', agentId: 'a1', runLocation: 'server' }, deps('not'))).toBeNull();
    channel({ id: 'a1', status: 'running' });
    expect(await refuseRunLocationChange({ channelId: 'c1', agentId: 'a1', runLocation: null }, deps('not'))).toBeNull();
    expect(probeCalls).toBe(0);
  });
  it('a running agent cannot be moved', async () => {
    channel({ id: 'a1', status: 'running' });
    expect(await refuseRunLocationChange({ channelId: 'c1', agentId: 'a1', runLocation: 'server' }, deps('ready'))).toMatchObject({ status: 409, code: 'RUN_LOCATION_REQUIRES_STOP' });
    channel({ id: 'a1', status: 'running', runLocation: 'server' });
    expect(await refuseRunLocationChange({ channelId: 'c1', agentId: 'a1', runLocation: null }, deps('ready'))).toMatchObject({ code: 'RUN_LOCATION_REQUIRES_STOP' });
  });
  it('uses the agent\'s stored PowerShell mode when the update does not mention it, and the request when it does', async () => {
    channel({ id: 'a1', status: 'stopped', spawnMode: 'powershell' });
    expect(await refuseRunLocationChange({ channelId: 'c1', agentId: 'a1', runLocation: 'server' }, deps('ready'))).toMatchObject({ code: 'RUN_LOCATION_POWERSHELL' });
    expect(await refuseRunLocationChange({ channelId: 'c1', agentId: 'a1', runLocation: 'server', spawnMode: 'wsl' }, deps('ready'))).toBeNull();
  });
  it('an unknown agent is left for the update handler to report', async () => {
    expect(await refuseRunLocationChange({ channelId: 'c1', agentId: 'nope', runLocation: 'server' }, deps('not'))).toBeNull();
  });
});

describe('laptopReadiness with the registry flags', () => {
  it('reads fileShare and desktopCommands from the registry, defaulting to off', async () => {
    h.registry = { remote: { fileShare: true, desktopCommands: true } };
    const real = await laptopReadiness({ probes: async () => probes('ok'), flags: (await import('@/lib/laptop-readiness')).defaultReadinessDeps.flags });
    expect(real).toMatchObject({ ready: true, mode: 'files-and-commands' });
    h.registry = {};
    const off = await laptopReadiness({ probes: async () => probes('ok'), flags: (await import('@/lib/laptop-readiness')).defaultReadinessDeps.flags });
    expect(off).toMatchObject({ ready: false, mode: 'files-only' });
    h.registry = { remote: { fileShare: 'yes' } };
    const loose = await laptopReadiness({ probes: async () => probes('ok'), flags: (await import('@/lib/laptop-readiness')).defaultReadinessDeps.flags });
    expect(loose.ready).toBe(false);                      // only a real boolean true counts
  });
});
