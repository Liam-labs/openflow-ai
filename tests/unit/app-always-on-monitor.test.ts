import { describe, expect, it, vi } from 'vitest';
import type { AppRegistryEntry } from '../../lib/types';
import {
  createAppAlwaysOnCycle,
  validateAlwaysOnConfig,
  type AlwaysOnMonitorDependencies,
} from '../../lib/app-always-on-monitor';

function app(overrides: Partial<AppRegistryEntry> = {}): AppRegistryEntry {
  return {
    id: 'app-1',
    name: 'Signal',
    description: '',
    icon: 'activity',
    iconType: 'lucide',
    color: '#3B82F6',
    category: 'development',
    tags: [],
    pm2Name: 'emails-and-marketing',
    healthCheck: { type: 'port', target: '3102' },
    alwaysOn: true,
    sortOrder: 0,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

function dependencies(overrides: Partial<AlwaysOnMonitorDependencies> = {}) {
  return {
    listApps: vi.fn(async () => [app()]),
    listProcesses: vi.fn(async () => [{ name: 'emails-and-marketing', status: 'online' }]),
    checkHealth: vi.fn(async () => ({ healthy: true, reason: 'Port 3102 is open' })),
    restartProcess: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    recordRecovery: vi.fn(async () => undefined),
    recordRestartResult: vi.fn(async () => undefined),
    now: vi.fn(() => 1_000_000),
    ...overrides,
  } satisfies AlwaysOnMonitorDependencies;
}

describe('validateAlwaysOnConfig', () => {
  it('requires PM2 and a health check when Always On is enabled', () => {
    expect(validateAlwaysOnConfig({ alwaysOn: true })).toMatch(/PM2/i);
    expect(validateAlwaysOnConfig({ alwaysOn: true, pm2Name: 'signal' })).toMatch(/health check/i);
  });

  it('validates the health-check target', () => {
    expect(validateAlwaysOnConfig({
      alwaysOn: true,
      pm2Name: 'signal',
      healthCheck: { type: 'port', target: '99999' },
    })).toMatch(/port/i);
    expect(validateAlwaysOnConfig({
      alwaysOn: true,
      pm2Name: 'signal',
      healthCheck: { type: 'http', target: 'not-a-url' },
    })).toMatch(/URL/i);
  });

  it('accepts a complete Always On configuration and ignores disabled entries', () => {
    expect(validateAlwaysOnConfig(app())).toBeNull();
    expect(validateAlwaysOnConfig({ alwaysOn: false })).toBeNull();
  });
});

describe('createAppAlwaysOnCycle', () => {
  it('ignores apps that are not Always On', async () => {
    const deps = dependencies({ listApps: vi.fn(async () => [app({ alwaysOn: false })]) });
    await createAppAlwaysOnCycle(deps)();
    expect(deps.checkHealth).not.toHaveBeenCalled();
    expect(deps.restartProcess).not.toHaveBeenCalled();
  });

  it('alerts and restarts immediately when the PM2 process is offline', async () => {
    const deps = dependencies({
      listProcesses: vi.fn(async () => [{ name: 'emails-and-marketing', status: 'stopped' }]),
    });
    await createAppAlwaysOnCycle(deps)();
    expect(deps.recordFailure).toHaveBeenCalledOnce();
    expect(deps.restartProcess).toHaveBeenCalledWith(expect.objectContaining({ id: 'app-1' }), true);
    expect(deps.recordRestartResult).toHaveBeenCalledWith(expect.anything(), true, undefined);
  });

  it('confirms two health failures before alerting and restarting an online process', async () => {
    const deps = dependencies({
      checkHealth: vi.fn(async () => ({ healthy: false, reason: 'Port 3102 is closed' })),
    });
    const cycle = createAppAlwaysOnCycle(deps);

    await cycle();
    expect(deps.recordFailure).not.toHaveBeenCalled();
    expect(deps.restartProcess).not.toHaveBeenCalled();

    await cycle();
    expect(deps.recordFailure).toHaveBeenCalledOnce();
    expect(deps.restartProcess).toHaveBeenCalledOnce();
  });

  it('deduplicates alerts during one incident and records recovery', async () => {
    let healthy = false;
    const deps = dependencies({
      listProcesses: vi.fn(async () => [{ name: 'emails-and-marketing', status: 'stopped' }]),
      checkHealth: vi.fn(async () => ({ healthy, reason: healthy ? 'ok' : 'offline' })),
    });
    const cycle = createAppAlwaysOnCycle(deps);

    await cycle();
    await cycle();
    expect(deps.recordFailure).toHaveBeenCalledOnce();

    healthy = true;
    vi.mocked(deps.listProcesses).mockResolvedValue([{ name: 'emails-and-marketing', status: 'online' }]);
    await cycle();
    expect(deps.recordRecovery).toHaveBeenCalledOnce();
  });

  it('does not restart repeatedly inside the cooldown', async () => {
    const deps = dependencies({
      listProcesses: vi.fn(async () => [{ name: 'emails-and-marketing', status: 'stopped' }]),
    });
    const cycle = createAppAlwaysOnCycle(deps);

    await cycle();
    await cycle();
    expect(deps.restartProcess).toHaveBeenCalledOnce();
  });
});

describe('runsOn host pin', () => {
  it('never restarts an app pinned to another host', async () => {
    vi.stubEnv('DEVFLOW_HOST_ID', 'devflow');
    const deps = dependencies({
      listApps: vi.fn(async () => [app({ runsOn: 'DesktopHost' })]),
      listProcesses: vi.fn(async () => []),
    });
    await createAppAlwaysOnCycle(deps)();
    expect(deps.restartProcess).not.toHaveBeenCalled();
    expect(deps.recordFailure).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('still manages an app pinned to this host or unpinned', async () => {
    vi.stubEnv('DEVFLOW_HOST_ID', 'devflow');
    for (const runsOn of ['Devflow', undefined]) {
      const deps = dependencies({
        listApps: vi.fn(async () => [app({ runsOn })]),
        listProcesses: vi.fn(async () => [{ name: 'emails-and-marketing', status: 'stopped' }]),
      });
      await createAppAlwaysOnCycle(deps)();
      expect(deps.restartProcess).toHaveBeenCalledOnce();
    }
    vi.unstubAllEnvs();
  });
});
