import { describe, expect, it, vi } from 'vitest';

import { projectFolderExists, readProjectDoc, type ProjectDocDeps } from '@/lib/project-doc';

const SG1 = '/home/user/SG-1';
const hostError = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

function deps(overrides: Partial<ProjectDocDeps> = {}): ProjectDocDeps {
  return {
    hostCall: vi.fn(async () => { throw new Error('hostCall not expected'); }) as unknown as ProjectDocDeps['hostCall'],
    readFile: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
    isDirectory: vi.fn(async () => false),
    ...overrides,
  };
}

describe('the Project Docs panel reads PROJECT.md from the machine where the project lives', () => {
  const OLD = process.env.DEVFLOW_AGENT_HOST;
  const onServer = (host: string | undefined, run: () => Promise<void>) => async () => {
    if (host === undefined) delete process.env.DEVFLOW_AGENT_HOST; else process.env.DEVFLOW_AGENT_HOST = host;
    try { await run(); } finally { if (OLD === undefined) delete process.env.DEVFLOW_AGENT_HOST; else process.env.DEVFLOW_AGENT_HOST = OLD; }
  };

  it('asks the desktop host when DevFlow runs on the server, instead of looking on its own disk', onServer('desktophost-wsl', async () => {
    const d = deps({ hostCall: vi.fn(async () => ({ exists: true, folderExists: true, content: '# SG-1\n' })) as unknown as ProjectDocDeps['hostCall'] });
    const result = await readProjectDoc(SG1, null, d);
    expect(result).toEqual({ projectPath: SG1, content: '# SG-1\n', exists: true, status: 'ok' });
    expect(d.hostCall).toHaveBeenCalledWith('desktophost-wsl', 'project-doc-read', { dir: SG1 }, expect.any(Number));
    expect(d.readFile).not.toHaveBeenCalled();
  }));

  it('reads from disk where the projects are on this machine (no agent host configured)', onServer(undefined, async () => {
    const d = deps({ readFile: vi.fn(async () => '# local') });
    expect(await readProjectDoc(SG1, null, d)).toMatchObject({ exists: true, content: '# local', status: 'ok' });
    expect(d.readFile).toHaveBeenCalledWith('/home/user/SG-1/PROJECT.md');
  }));

  it('reads from disk for an agent that runs on the server itself', onServer('desktophost-wsl', async () => {
    const d = deps({ readFile: vi.fn(async () => '# server project') });
    expect(await readProjectDoc('/home/user/DevFlow', { runLocation: 'server' }, d)).toMatchObject({ exists: true, status: 'ok' });
    expect(d.hostCall).not.toHaveBeenCalled();
  }));

  it('tells a missing document from a missing folder', onServer('desktophost-wsl', async () => {
    const reply = (value: object) => deps({ hostCall: vi.fn(async () => value) as unknown as ProjectDocDeps['hostCall'] });
    expect(await readProjectDoc(SG1, null, reply({ exists: false, folderExists: true }))).toMatchObject({ exists: false, status: 'not-found', content: null });
    const noFolder = await readProjectDoc(SG1, null, reply({ exists: false, folderExists: false }));
    expect(noFolder).toMatchObject({ exists: false, status: 'no-folder' });
    expect(noFolder.message).toContain(SG1);
  }));

  it('explains an unreachable or out-of-date agent machine instead of saying the file is not found', onServer('desktophost-wsl', async () => {
    const failing = (error: Error) => deps({ hostCall: vi.fn(async () => { throw error; }) as unknown as ProjectDocDeps['hostCall'] });
    const offline = await readProjectDoc(SG1, null, failing(hostError('host did not answer', 'EHOSTTIMEOUT')));
    expect(offline).toMatchObject({ exists: false, status: 'host-offline' });
    expect(offline.message).toMatch(/isn't answering/);
    const outdated = await readProjectDoc(SG1, null, failing(hostError('unknown op')));
    expect(outdated).toMatchObject({ exists: false, status: 'host-outdated' });
    expect(outdated.message).toMatch(/restart/);
    expect(await readProjectDoc(SG1, null, failing(hostError('folder not allowed')))).toMatchObject({ status: 'error', message: expect.stringContaining('folder not allowed') });
  }));

  it('checks that a folder exists where the project lives, and reports an unreachable host rather than "no such folder"', onServer('desktophost-wsl', async () => {
    const reply = (value: object) => deps({ hostCall: vi.fn(async () => value) as unknown as ProjectDocDeps['hostCall'] });
    expect(await projectFolderExists(SG1, null, reply({ exists: false, folderExists: true }))).toEqual({ ok: true, exists: true });
    expect(await projectFolderExists(SG1, null, reply({ exists: false, folderExists: false }))).toEqual({ ok: true, exists: false });
    const down = deps({ hostCall: vi.fn(async () => { throw hostError('x', 'EHOSTTIMEOUT'); }) as unknown as ProjectDocDeps['hostCall'] });
    expect(await projectFolderExists(SG1, null, down)).toMatchObject({ ok: false, status: 'host-offline' });
  }));

  it('checks the local disk for the folder when the projects are here', onServer(undefined, async () => {
    expect(await projectFolderExists(SG1, null, deps({ isDirectory: vi.fn(async () => true) }))).toEqual({ ok: true, exists: true });
    expect(await projectFolderExists(SG1, null, deps({ isDirectory: vi.fn(async () => { throw new Error('ENOENT'); }) }))).toEqual({ ok: true, exists: false });
  }));
});
