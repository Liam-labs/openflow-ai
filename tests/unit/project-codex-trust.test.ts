import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn().mockResolvedValue(undefined),
  trustCodexWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/config', () => ({
  loadConfig: mocks.loadConfig,
  saveConfig: mocks.saveConfig,
}));

vi.mock('@/lib/codex-workspace-trust', () => ({
  trustCodexWorkspace: mocks.trustCodexWorkspace,
}));

vi.mock('@/lib/health-checks', () => ({
  runProjectHealthChecks: vi.fn(),
}));

import { create, update } from '@/app/api/agent/actions/projects';

const auth = { requestId: 'request-1' } as never;

function emptyConfig() {
  return {
    projects: [],
    settings: { refreshInterval: 2000, defaultCategory: 'all' },
  };
}

describe('project Codex trust registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveConfig.mockResolvedValue(undefined);
    mocks.trustCodexWorkspace.mockResolvedValue(undefined);
  });

  it('trusts a new project path before persisting the project', async () => {
    mocks.loadConfig.mockResolvedValue(emptyConfig());

    await create({
      name: 'New Project',
      path: '/home/user/New-Project',
      category: 'development',
    } as never, auth);

    expect(mocks.trustCodexWorkspace).toHaveBeenCalledWith('/home/user/New-Project');
    expect(mocks.trustCodexWorkspace.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.saveConfig.mock.invocationCallOrder[0]);
  });

  it('trusts a replacement project path on update', async () => {
    const config = emptyConfig();
    config.projects.push({
      id: 'existing',
      name: 'Existing',
      description: '',
      path: '/home/user/Existing',
      category: 'development',
      tags: [],
      healthChecks: [],
      links: {},
    } as never);
    mocks.loadConfig.mockResolvedValue(config);

    await update({
      projectId: 'existing',
      path: '/home/user/Renamed',
    } as never, auth);

    expect(mocks.trustCodexWorkspace).toHaveBeenCalledWith('/home/user/Renamed');
  });
});
