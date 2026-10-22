import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabChannel } from '@/lib/types';
import manifestCases from '../fixtures/channel-tools-manifest-cases.json';

const hostCall = vi.fn();
let host: string | null = 'desktophost-wsl';
let channels: CollabChannel[] = [];

vi.mock('@/lib/host-executor', () => ({ defaultHost: () => host, hostCall: (...a: unknown[]) => hostCall(...a) }));
vi.mock('@/lib/data-io', () => ({ readJsonFile: async () => ({ channels }) }));

const lib = await import('@/lib/channel-tools');
const { safeToolPath, channelToolsDir, parseToolManifest, buildResult, listChannelTools, readChannelToolFile, contentTypeFor, clearChannelToolsCache } = lib;

const ch = (id: string, name: string, projectPath?: string, extra: Partial<CollabChannel> = {}) =>
  ({ id, name, projectPath, participants: [], messages: [], settings: { autoRespond: false }, ...extra }) as unknown as CollabChannel;
const who = { id: 'c1', name: 'Commander' };

describe('channel tools paths', () => {
  it('accepts plain relative paths and rejects anything that could leave the tool folder', () => {
    expect(safeToolPath('index.html')).toEqual(['index.html']);
    expect(safeToolPath('assets/app.js')).toEqual(['assets', 'app.js']);
    for (const bad of ['', '..', '../x', 'a/../b', '/abs', 'a//b', './a', '.env', 'a/.git/config', 'a\\b', 'a\0b']) {
      expect(safeToolPath(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('puts channel-tools in the channel project folder and a sub-channel uses its parent\'s', () => {
    const list = [ch('a', 'A', '/home/user/Proj'), ch('b', 'B', undefined, { parentChannelId: 'a' }), ch('c', 'C'), ch('d', 'D', 'relative/path')];
    expect(channelToolsDir('a', list)).toBe('/home/user/Proj/channel-tools');
    expect(channelToolsDir('b', list)).toBe('/home/user/Proj/channel-tools');
    expect(channelToolsDir('c', list)).toBeNull();
    expect(channelToolsDir('d', list)).toBeNull();
    expect(channelToolsDir('missing', list)).toBeNull();
  });
});

describe('tool.json parsing', () => {
  const parse = (m: unknown) => parseToolManifest('t', typeof m === 'string' ? m : JSON.stringify(m), who);

  it('parses link, html and script tools with defaults', () => {
    expect(parse({ name: 'Board', type: 'link', url: 'http://localhost:3000/tasks', icon: '📋' })).toMatchObject({ tool: { id: 't', name: 'Board', type: 'link', url: 'http://localhost:3000/tasks', icon: '📋', order: 100 } });
    expect(parse({ type: 'link', url: '/system' })).toMatchObject({ tool: { name: 't', url: '/system' } });
    expect(parse({ name: 'App', type: 'html' })).toMatchObject({ tool: { entry: 'index.html', launchPath: '/api/channel-tools/file/c1/t/index.html' } });
    expect(parse({ type: 'html', entry: 'ui/main page.html' })).toMatchObject({ tool: { launchPath: '/api/channel-tools/file/c1/t/ui/main%20page.html' } });
    expect(parse({ name: 'Run', type: 'script', run: 'python3 app.py', cwd: 'src', description: 'd' })).toMatchObject({ tool: { type: 'script', run: 'python3 app.py', cwd: 'src', description: 'd' } });
  });

  it('infers the type from the fields when it is left out', () => {
    expect(parse({ url: 'https://example.com' })).toMatchObject({ tool: { type: 'link' } });
    expect(parse({ run: 'node x.js' })).toMatchObject({ tool: { type: 'script' } });
    expect(parse({ entry: 'a.html' })).toMatchObject({ tool: { type: 'html' } });
  });

  it('turns bad manifests into warnings', () => {
    const bad: Array<[unknown, RegExp]> = [
      ['{nope', /not valid JSON/], ['[]', /JSON object/], [{}, /"type"/], [{ type: 'exe' }, /"type"/],
      [{ type: 'link' }, /url/], [{ type: 'link', url: 'javascript:alert(1)' }, /url/], [{ type: 'link', url: '//evil.test' }, /url/],
      [{ type: 'link', url: 'file:///etc/passwd' }, /url/], [{ type: 'html', entry: '../x.html' }, /entry/], [{ type: 'html', entry: 'app.js' }, /entry/],
      [{ type: 'script' }, /run/], [{ type: 'script', run: 'x', cwd: '../..' }, /cwd/], [{ type: 'link', url: '/x', channels: 'all' }, /channels/],
    ];
    for (const [manifest, re] of bad) expect(parse(manifest), JSON.stringify(manifest)).toMatchObject({ warning: expect.stringMatching(re) });
  });

  it('hides a tool meant for other channels (by name or id) and shows one that names this channel', () => {
    expect(parse({ type: 'link', url: '/x', channels: ['Other'] })).toEqual({ hidden: true });
    expect(parse({ type: 'link', url: '/x', channels: ['commander'] })).toMatchObject({ tool: { id: 't' } });
    expect(parse({ type: 'link', url: '/x', channels: ['c1'] })).toMatchObject({ tool: { id: 't' } });
    expect(parse({ type: 'link', url: '/x', channels: [] })).toMatchObject({ tool: { id: 't' } });
  });

  it('builds a sorted result, keeps good tools next to broken ones and reports a missing folder', () => {
    const result = buildResult(who, '/p/channel-tools', {
      exists: true,
      tools: [
        { id: 'zeta', manifest: JSON.stringify({ name: 'Zeta', type: 'link', url: '/z' }), error: null },
        { id: 'alpha', manifest: JSON.stringify({ name: 'Alpha', type: 'link', url: '/a', order: 1 }), error: null },
        { id: 'broken', manifest: '{', error: null },
        { id: 'empty', manifest: null, error: 'missing tool.json' },
        { id: 'other', manifest: JSON.stringify({ type: 'link', url: '/o', channels: ['Nope'] }), error: null },
      ],
    });
    expect(result.status).toBe('ok');
    expect(result.tools.map(t => t.id)).toEqual(['alpha', 'zeta']);
    expect(result.warnings.map(w => w.id)).toEqual(['broken', 'empty']);
    expect(buildResult(who, '/p/channel-tools', { exists: false, tools: [] })).toMatchObject({ status: 'no-folder', tools: [] });
  });

  it('serves known types and downloads the rest', () => {
    expect(contentTypeFor('a/b.HTML')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('x.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('x.exe')).toBe('application/octet-stream');
  });
});

describe('shared manifest cases (also run against scripts/channel-tools-index.py)', () => {
  for (const c of manifestCases.cases as Array<{ name: string; manifest: unknown; expect: { tool?: Record<string, unknown>; warning?: string; hidden?: boolean } }>) {
    it(c.name, () => {
      const raw = typeof c.manifest === 'string' ? c.manifest : JSON.stringify(c.manifest);
      const got = parseToolManifest('t', raw, manifestCases.channel);
      if (c.expect.tool) expect(got).toMatchObject({ tool: c.expect.tool });
      else if (c.expect.warning) expect(got).toMatchObject({ warning: expect.stringContaining(c.expect.warning) });
      else expect(got).toEqual({ hidden: true });
    });
  }

  it('returns whenToUse in the listing and ignores the generated tools.json file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-when-'));
    try {
      const tools = path.join(dir, 'channel-tools');
      await fs.mkdir(path.join(tools, 'board'), { recursive: true });
      await fs.writeFile(path.join(tools, 'board', 'tool.json'), '{"type":"link","url":"/x","whenToUse":"When Owner asks."}');
      await fs.writeFile(path.join(tools, 'tools.json'), '{"tools":[],"errors":[]}');
      const list = await lib.listToolsOnDisk(tools);
      expect(list.tools.map(t => t.id)).toEqual(['board']);
      expect(lib.buildResult(who, tools, list).tools[0]).toMatchObject({ id: 'board', whenToUse: 'When Owner asks.' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('listing through the agent host', () => {
  beforeEach(() => {
    hostCall.mockReset();
    clearChannelToolsCache();
    host = 'desktophost-wsl';
    channels = [ch('c1', 'Commander', '/home/user/SG-1'), ch('np', 'NoProject')];
  });

  it('asks the host for the channel folder and parses the answer', async () => {
    hostCall.mockResolvedValue({ exists: true, tools: [{ id: 'board', manifest: '{"name":"Board","type":"link","url":"/tasks"}', error: null }] });
    const r = await listChannelTools('c1');
    expect(hostCall).toHaveBeenCalledWith('desktophost-wsl', 'channel-tools-list', { dir: '/home/user/SG-1/channel-tools' }, expect.any(Number));
    expect(r).toMatchObject({ status: 'ok', dir: '/home/user/SG-1/channel-tools', tools: [{ id: 'board' }] });
  });

  it('reports no project, unknown channel, offline host and an outdated host without throwing', async () => {
    expect(await listChannelTools('np')).toMatchObject({ status: 'no-project', dir: null, tools: [] });
    expect(await listChannelTools('missing')).toBeNull();
    hostCall.mockRejectedValueOnce(Object.assign(new Error('host did not answer'), { code: 'EHOSTTIMEOUT' }));
    expect(await listChannelTools('c1')).toMatchObject({ status: 'host-offline' });
    hostCall.mockRejectedValueOnce(Object.assign(new Error('unknown op'), { code: 'EHOSTOP' }));
    expect(await listChannelTools('c1')).toMatchObject({ status: 'host-outdated' });
    hostCall.mockRejectedValueOnce(new Error('boom'));
    expect(await listChannelTools('c1')).toMatchObject({ status: 'error', message: 'boom' });
  });

  it('serves a file only from a declared html tool and passes a clean relative path to the host', async () => {
    hostCall.mockImplementation(async (_h: string, op: string) => op === 'channel-tools-list'
      ? { exists: true, tools: [
        { id: 'app', manifest: '{"type":"html"}', error: null },
        { id: 'board', manifest: '{"type":"link","url":"/tasks"}', error: null },
        { id: 'bad', manifest: '{', error: null }] }
      : { b64: Buffer.from('<h1>x</h1>').toString('base64') });
    const ok = await readChannelToolFile('c1', 'app', 'assets/app.js');
    expect(ok).toMatchObject({ ok: true });
    expect(hostCall).toHaveBeenCalledWith('desktophost-wsl', 'channel-tools-read', { dir: '/home/user/SG-1/channel-tools', tool: 'app', path: 'assets/app.js' }, expect.any(Number));
    for (const [tool, rel] of [['board', 'index.html'], ['bad', 'index.html'], ['ghost', 'index.html'], ['app', '../x'], ['app', '.env'], ['../app', 'index.html']] as const) {
      expect(await readChannelToolFile('c1', tool, rel), `${tool}/${rel}`).toMatchObject({ ok: false });
    }
    expect(await readChannelToolFile('missing', 'app', 'index.html')).toMatchObject({ ok: false, statusCode: 404 });
    expect(hostCall.mock.calls.filter(c => c[1] === 'channel-tools-read')).toHaveLength(1);
  });

  it('maps host read failures to safe statuses', async () => {
    hostCall.mockImplementation(async (_h: string, op: string) => {
      if (op === 'channel-tools-list') return { exists: true, tools: [{ id: 'app', manifest: '{"type":"html"}', error: null }] };
      throw Object.assign(new Error('FileNotFoundError: no such file'), { code: 'EHOSTOP' });
    });
    expect(await readChannelToolFile('c1', 'app', 'gone.html')).toMatchObject({ ok: false, statusCode: 404 });
  });
});

describe('listing straight from disk (DevFlow on the agent machine)', () => {
  let root: string;
  let outside: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-out-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    const tools = path.join(root, 'channel-tools');
    await fs.mkdir(path.join(tools, 'app', 'assets'), { recursive: true });
    await fs.writeFile(path.join(tools, 'app', 'tool.json'), '{"name":"App","type":"html"}');
    await fs.writeFile(path.join(tools, 'app', 'index.html'), '<p>ok</p>');
    await fs.writeFile(path.join(tools, 'app', 'assets', 'a.css'), 'body{}');
    await fs.writeFile(path.join(tools, 'app', '.env'), 'X=1');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(tools, 'app', 'leak.txt'));
    await fs.symlink(outside, path.join(tools, 'app', 'up'));
    await fs.symlink(outside, path.join(tools, 'linked'));
    await fs.mkdir(path.join(tools, 'nomanifest'));
    await fs.mkdir(path.join(tools, 'has space'));
    await fs.writeFile(path.join(tools, 'README.md'), 'x');
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  beforeEach(() => {
    hostCall.mockReset();
    clearChannelToolsCache();
    host = null;
    channels = [ch('c1', 'Commander', root), ch('empty', 'Empty', outside)];
  });

  it('lists tools, skips symlinked and hidden folders, and flags problems', async () => {
    const r = await listChannelTools('c1');
    expect(r?.status).toBe('ok');
    expect(r?.tools.map(t => t.id)).toEqual(['app']);
    expect(r?.warnings.map(w => w.id).sort()).toEqual(['has space', 'nomanifest']);
    expect(hostCall).not.toHaveBeenCalled();
  });

  it('a project without the folder is a friendly empty state', async () => {
    expect(await listChannelTools('empty')).toMatchObject({ status: 'no-folder', tools: [], warnings: [] });
  });

  it('serves files inside the tool and nothing that escapes it', async () => {
    const ok = await readChannelToolFile('c1', 'app', 'assets/a.css');
    expect(ok.ok && ok.data.toString()).toBe('body{}');
    for (const rel of ['leak.txt', 'up/secret.txt', '../linked/secret.txt', '.env', 'tool.json/../../README.md', 'assets']) {
      const r = await readChannelToolFile('c1', 'app', rel);
      expect(r.ok, rel).toBe(false);
    }
  });
});

describe('DevFlow and agent-hostd agree (real hostd ops, folder under a fake home)', () => {
  let home: string;
  const hostd = path.resolve(__dirname, '../../scripts/agent-hostd.py');
  const runOp = (op: string, args: Record<string, unknown>) => {
    const code = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("hostd", ${JSON.stringify(hostd)})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'print(json.dumps(m.run_command({"op": sys.argv[1], "args": json.loads(sys.argv[2])})))',
    ].join('\n');
    const out = execFileSync('python3', ['-B', '-c', code, op, JSON.stringify(args)], {
      env: { PATH: process.env.PATH ?? '', HOME: home, HOSTD_CONFIG: path.join(home, 'none.json') },
      encoding: 'utf-8',
    });
    return JSON.parse(out) as { ok: boolean; result?: unknown; error?: string };
  };

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-home-')));
    const tools = path.join(home, 'Proj', 'channel-tools');
    await fs.mkdir(path.join(tools, 'guide'), { recursive: true });
    await fs.mkdir(path.join(tools, 'board'));
    await fs.mkdir(path.join(tools, 'broken'));
    await fs.writeFile(path.join(tools, 'guide', 'tool.json'), '{"name":"Guide","type":"html"}');
    await fs.writeFile(path.join(tools, 'guide', 'index.html'), '<h1>Guide</h1>');
    await fs.writeFile(path.join(tools, 'board', 'tool.json'), '{"name":"Board","type":"link","url":"/backups"}');
    await fs.writeFile(path.join(home, 'secret.txt'), 'secret');
  });
  afterAll(() => fs.rm(home, { recursive: true, force: true }));
  beforeEach(() => {
    clearChannelToolsCache();
    host = 'desktophost-wsl';
    channels = [ch('c1', 'Commander', path.join(home, 'Proj'))];
    hostCall.mockReset();
    hostCall.mockImplementation(async (_host: string, op: string, args: Record<string, unknown>) => {
      const r = runOp(op, args);
      if (!r.ok) throw Object.assign(new Error(r.error), { code: 'EHOSTOP' });
      return r.result;
    });
  });

  it('lists the folder through hostd and serves a file through hostd', async () => {
    const r = await listChannelTools('c1');
    expect(r?.status).toBe('ok');
    expect(r?.tools.map(t => [t.id, t.type])).toEqual([['board', 'link'], ['guide', 'html']]);
    expect(r?.warnings).toEqual([{ id: 'broken', message: 'missing tool.json' }]);
    const file = await readChannelToolFile('c1', 'guide', 'index.html');
    expect(file.ok && file.data.toString()).toBe('<h1>Guide</h1>');
  });

  it('hostd refuses a folder outside home or not named channel-tools', async () => {
    expect(runOp('channel-tools-list', { dir: '/etc/channel-tools' }).ok).toBe(false);
    expect(runOp('channel-tools-list', { dir: path.join(home, 'Proj') }).ok).toBe(false);
    expect(runOp('channel-tools-read', { dir: path.join(home, 'Proj', 'channel-tools'), tool: 'guide', path: '../../../secret.txt' }).ok).toBe(false);
  });
});
