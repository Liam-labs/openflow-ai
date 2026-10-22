import { describe, expect, it, vi } from 'vitest';
import type { Config, Project } from '@/lib/types';
import {
  ensureChannelProject,
  type ChannelProjectBootstrapDeps,
} from '@/lib/channel-project-bootstrap';
import { resolveChannelWorkingDirectory } from '@/lib/channel-working-directory';
import { homedir } from 'node:os';
const HOME = homedir();

function emptyConfig(): Config {
  return {
    projects: [],
    settings: { refreshInterval: 2000, defaultCategory: 'all' },
  };
}

function deps(config = emptyConfig()): ChannelProjectBootstrapDeps & {
  mkdir: ReturnType<typeof vi.fn>;
  saveConfig: ReturnType<typeof vi.fn>;
  trustWorkspace: ReturnType<typeof vi.fn>;
} {
  return {
    homeDirectory: HOME,
    loadConfig: vi.fn().mockResolvedValue(config),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    trustWorkspace: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ensureChannelProject', () => {
  it('creates and registers a project directory from a new channel name', async () => {
    const io = deps();

    const result = await ensureChannelProject({
      channelName: "Email's and Marketing.",
    }, io);

    expect(result).toEqual({
      projectId: 'email-s-and-marketing',
      projectPath: `${HOME}/Emails-and-Marketing`,
      created: true,
    });
    expect(io.mkdir).toHaveBeenCalledWith(
      `${HOME}/Emails-and-Marketing`,
      { recursive: true },
    );
    expect(io.saveConfig).toHaveBeenCalledOnce();
    expect(io.trustWorkspace).toHaveBeenCalledWith(`${HOME}/Emails-and-Marketing`);
    const saved = io.saveConfig.mock.calls[0][0] as Config;
    expect(saved.projects).toContainEqual(expect.objectContaining({
      id: 'email-s-and-marketing',
      name: "Email's and Marketing.",
      path: `${HOME}/Emails-and-Marketing`,
    }));
  });

  it('links an explicitly selected project and resolves its path', async () => {
    const project: Project = {
      id: 'acmework',
      name: 'Acmework',
      description: '',
      path: `${HOME}/Acmework`,
      category: 'tool',
      tags: [],
      healthChecks: [],
      links: {},
    };
    const io = deps({ ...emptyConfig(), projects: [project] });

    const result = await ensureChannelProject({
      channelName: 'Campaign',
      projectId: 'acmework',
    }, io);

    expect(result).toEqual({
      projectId: 'acmework',
      projectPath: `${HOME}/Acmework`,
      created: false,
    });
    expect(io.mkdir).not.toHaveBeenCalled();
    expect(io.saveConfig).not.toHaveBeenCalled();
    expect(io.trustWorkspace).toHaveBeenCalledWith(`${HOME}/Acmework`);
  });

  it('reuses an existing same-name project instead of creating a duplicate', async () => {
    const project: Project = {
      id: 'email-s-and-marketing',
      name: "Email's and Marketing.",
      description: '',
      path: `${HOME}/Existing-Marketing`,
      category: 'tool',
      tags: [],
      healthChecks: [],
      links: {},
    };
    const io = deps({ ...emptyConfig(), projects: [project] });

    const result = await ensureChannelProject({
      channelName: "Email's and Marketing.",
    }, io);

    expect(result).toEqual({
      projectId: project.id,
      projectPath: project.path,
      created: false,
    });
    expect(io.mkdir).not.toHaveBeenCalled();
    expect(io.saveConfig).not.toHaveBeenCalled();
    expect(io.trustWorkspace).toHaveBeenCalledWith(`${HOME}/Existing-Marketing`);
  });

  it('creates a new channel folder on the agent host too, and a host failure does not block creation', async () => {
    const io = { ...deps(), ensureHostFolder: vi.fn().mockRejectedValue(new Error('host offline')) };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await ensureChannelProject({ channelName: 'Spanish Learning' }, io);

    expect(result).toEqual({ projectId: 'spanish-learning', projectPath: `${HOME}/Spanish-Learning`, created: true });
    expect(io.ensureHostFolder).toHaveBeenCalledWith(`${HOME}/Spanish-Learning`);
    expect(io.saveConfig).toHaveBeenCalledOnce();
    errors.mockRestore();
  });

  it('trusts an explicit unregistered project path', async () => {
    const io = deps();

    const result = await ensureChannelProject({
      channelName: 'Campaign',
      projectPath: `${HOME}/New-Campaign`,
    }, io);

    expect(result).toEqual({
      projectPath: `${HOME}/New-Campaign`,
      created: false,
    });
    expect(io.trustWorkspace).toHaveBeenCalledWith(`${HOME}/New-Campaign`);
  });
});

describe('resolveChannelWorkingDirectory', () => {
  const projects = [{
    id: 'marketing',
    name: 'Marketing',
    path: `${HOME}/Marketing`,
  }];

  it('prefers the channel projectPath', () => {
    expect(resolveChannelWorkingDirectory(
      { projectId: 'marketing', projectPath: `${HOME}/Override` },
      projects,
    )).toBe(`${HOME}/Override`);
  });

  it('falls back to the linked project path', () => {
    expect(resolveChannelWorkingDirectory(
      { projectId: 'marketing' },
      projects,
    )).toBe(`${HOME}/Marketing`);
  });

  it('uses the home fallback only for legacy unlinked channels', () => {
    expect(resolveChannelWorkingDirectory({}, projects)).toBe(HOME);
  });
});
