import { describe, expect, it, vi } from 'vitest';

import { projectFolderExists, readProjectDoc, writeProjectDoc, type ProjectDocDeps } from '@/lib/project-doc';

const SG1 = '/home/user/SG-1';
const hostError = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

function deps(overrides: Partial<ProjectDocDeps> = {}): ProjectDocDeps {
  return {
    hostCall: vi.fn(async () => { throw new Error('hostCall not expected'); }) as unknown as ProjectDocDeps['hostCall'],
    readFile: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
    writeFile: vi.fn(async () => undefined),
    mtimeSeconds: vi.fn(async () => null),
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

  it('still reads through the desktop host for an agent that runs on the server, because its folders stay on the desktop', onServer('desktophost-wsl', async () => {
    const d = deps({ hostCall: vi.fn(async () => ({ exists: true, folderExists: true, content: '# server project' })) as unknown as ProjectDocDeps['hostCall'] });
    expect(await readProjectDoc('/home/user/DevFlow', { runLocation: 'server' }, d)).toMatchObject({ exists: true, status: 'ok' });
    expect(d.readFile).not.toHaveBeenCalled();
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

describe('saving PROJECT.md from the Project Docs panel', () => {
  const OLD = process.env.DEVFLOW_AGENT_HOST;
  const onServer = (host: string | undefined, run: () => Promise<void>) => async () => {
    if (host === undefined) delete process.env.DEVFLOW_AGENT_HOST; else process.env.DEVFLOW_AGENT_HOST = host;
    try { await run(); } finally { if (OLD === undefined) delete process.env.DEVFLOW_AGENT_HOST; else process.env.DEVFLOW_AGENT_HOST = OLD; }
  };

  it('sends the text and the modified time it read to the desktop host', onServer('desktophost-wsl', async () => {
    const d = deps({ hostCall: vi.fn(async () => ({ saved: true, conflict: false, mtime: 200 })) as unknown as ProjectDocDeps['hostCall'] });
    expect(await writeProjectDoc(SG1, '# New\n', 100, null, d)).toEqual({ ok: true, mtime: 200 });
    expect(d.hostCall).toHaveBeenCalledWith('desktophost-wsl', 'project-doc-write', { dir: SG1, content: '# New\n', expectedMtime: 100 }, expect.any(Number));
  }));

  it('returns the current text, and writes nothing, when an agent changed the file meanwhile', onServer('desktophost-wsl', async () => {
    const d = deps({ hostCall: vi.fn(async () => ({ saved: false, conflict: true, content: '# Theirs\n', mtime: 300 })) as unknown as ProjectDocDeps['hostCall'] });
    expect(await writeProjectDoc(SG1, '# Mine\n', 100, null, d)).toEqual({ ok: false, conflict: true, content: '# Theirs\n', mtime: 300 });
  }));

  it('says the helper needs a restart when it does not know the save op yet', onServer('desktophost-wsl', async () => {
    const d = deps({ hostCall: vi.fn(async () => { throw hostError('unknown op'); }) as unknown as ProjectDocDeps['hostCall'] });
    const result = await writeProjectDoc(SG1, 'x', null, null, d);
    expect(result).toMatchObject({ ok: false, status: 'host-outdated' });
  }));

  it('writes on this machine when it holds the project, and refuses to overwrite a newer file', onServer(undefined, async () => {
    const ok = deps({ mtimeSeconds: vi.fn(async () => 100) });
    expect(await writeProjectDoc(SG1, 'a', 100, null, ok)).toEqual({ ok: true, mtime: 100 });
    expect(ok.writeFile).toHaveBeenCalledWith(`${SG1}/PROJECT.md`, 'a');
    const stale = deps({ mtimeSeconds: vi.fn(async () => 150), readFile: vi.fn(async () => 'theirs') });
    expect(await writeProjectDoc(SG1, 'a', 100, null, stale)).toEqual({ ok: false, conflict: true, content: 'theirs', mtime: 150 });
    expect(stale.writeFile).not.toHaveBeenCalled();
  }));
});
