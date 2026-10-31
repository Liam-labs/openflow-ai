import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { checkExposureAtStartup, exposureReasons, exposureVerdict, passwordStored, remoteAccessEnabled } from '@/lib/exposure-guard';

let authFile = '';
let remoteFile = '';
vi.mock('@/lib/data-paths', () => ({ DataPaths: { get dashboardAuth() { return authFile; }, get remoteAccess() { return remoteFile; } } }));

describe('exposureReasons', () => {
  it('is empty for a server that listens on this machine only', () => {
    expect(exposureReasons({}, false)).toEqual([]);
    expect(exposureReasons({ DEVFLOW_BIND_HOST: '127.0.0.1' }, false)).toEqual([]);
    expect(exposureReasons({ DEVFLOW_BIND_HOST: 'localhost' }, false)).toEqual([]);
    expect(exposureReasons({ WEBGATE_TUNNEL_SECRET: '   ' }, false)).toEqual([]);
  });
  it.each([
    [{ DEVFLOW_BIND_HOST: '0.0.0.0' }, false, /listens beyond this machine/],
    [{ DEVFLOW_BIND_HOST: '192.168.1.5' }, false, /listens beyond this machine/],
    [{}, true, /remote access is switched on/],
    [{ WEBGATE_TUNNEL_SECRET: 's' }, false, /tunnel/],
  ])('names the reason for %j (remote %s)', (env, remote, why) => {
    const reasons = exposureReasons(env, remote as boolean);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(why as RegExp);
  });
  it('lists every reason', () => {
    expect(exposureReasons({ DEVFLOW_BIND_HOST: '0.0.0.0', WEBGATE_TUNNEL_SECRET: 's' }, true)).toHaveLength(3);
  });
});

describe('exposureVerdict', () => {
  const exposed = ['it listens beyond this machine (DEVFLOW_BIND_HOST=0.0.0.0)'];
  it('refuses an exposed server with no password and says how to fix it', () => {
    const v = exposureVerdict({ exposures: exposed, passwordSet: false, allowOpen: false });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/scripts\/devflow-password set/);
    expect(v.message).toMatch(/DEVFLOW_ALLOW_OPEN_REMOTE=1/);
    expect(v.message).toMatch(/DEVFLOW_BIND_HOST=0.0.0.0/);
  });
  it('allows it with a password, with the explicit opt-out, or when nothing is exposed', () => {
    expect(exposureVerdict({ exposures: exposed, passwordSet: true, allowOpen: false }).ok).toBe(true);
    expect(exposureVerdict({ exposures: exposed, passwordSet: false, allowOpen: true }).ok).toBe(true);
    expect(exposureVerdict({ exposures: [], passwordSet: false, allowOpen: false }).ok).toBe(true);
  });
});

describe('what is read from disk', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'expo-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const write = (name: string, body: string) => fs.writeFile(path.join(dir, name), body);

  it('passwordStored: a stored hash only; missing, unreadable, empty or hash-less files are "not set"', async () => {
    const f = path.join(dir, 'a.json');
    expect(await passwordStored(f)).toBe(false);
    await write('a.json', '{not json');
    expect(await passwordStored(f)).toBe(false);
    await write('a.json', JSON.stringify({ password: { hash: '' } }));
    expect(await passwordStored(f)).toBe(false);
    await write('a.json', JSON.stringify({ password: {} }));
    expect(await passwordStored(f)).toBe(false);
    await write('a.json', JSON.stringify({ password: { hash: 'scrypt$1$2$3$aa$bb' } }));
    expect(await passwordStored(f)).toBe(true);
  });

  it('remoteAccessEnabled: only an explicit true', async () => {
    const f = path.join(dir, 'r.json');
    const none = path.join(dir, 'no-cloudflare.json');
    expect(await remoteAccessEnabled(f, none)).toBe(false);
    await write('r.json', JSON.stringify({ enabled: 'yes' }));
    expect(await remoteAccessEnabled(f, none)).toBe(false);
    await write('r.json', JSON.stringify({ enabled: true }));
    expect(await remoteAccessEnabled(f, none)).toBe(true);
  });

  it('remoteAccessEnabled: the Cloudflare wizard switching on counts too', async () => {
    const tailscale = path.join(dir, 'r2.json');
    const cf = path.join(dir, 'cf.json');
    expect(await remoteAccessEnabled(tailscale, cf)).toBe(false);
    await write('cf.json', JSON.stringify({ enabled: false, stage: 'none' }));
    expect(await remoteAccessEnabled(tailscale, cf)).toBe(false);
    await write('cf.json', JSON.stringify({ enabled: true, stage: 'dns' }));
    expect(await remoteAccessEnabled(tailscale, cf)).toBe(true);
  });

  it('checkExposureAtStartup puts the files and the environment together', async () => {
    authFile = path.join(dir, 'auth.json');
    remoteFile = path.join(dir, 'remote.json');
    // nothing exposed: fine with no password
    expect((await checkExposureAtStartup({})).ok).toBe(true);
    // a later edit of a settings file: remote access on, no password -> refused
    await write('remote.json', JSON.stringify({ enabled: true }));
    const refused = await checkExposureAtStartup({});
    expect(refused.ok).toBe(false);
    expect(refused.exposures).toEqual(['remote access is switched on']);
    // the same with the explicit opt-out
    expect((await checkExposureAtStartup({ DEVFLOW_ALLOW_OPEN_REMOTE: '1' })).ok).toBe(true);
    expect((await checkExposureAtStartup({ DEVFLOW_ALLOW_OPEN_REMOTE: 'true' })).ok).toBe(false);   // exactly "1"
    // a password fixes it
    await write('auth.json', JSON.stringify({ password: { hash: 'scrypt$1$2$3$aa$bb' } }));
    expect((await checkExposureAtStartup({})).ok).toBe(true);
    // and an exposed bind alone is refused when the password file goes away
    await fs.rm(path.join(dir, 'auth.json'));
    await fs.rm(path.join(dir, 'remote.json'));
    expect((await checkExposureAtStartup({ DEVFLOW_BIND_HOST: '0.0.0.0' })).ok).toBe(false);
  });
});

describe('server mode', () => {
  const base = { exposures: [] as string[], passwordSet: true, allowOpen: false };
  it('refuses to start in server mode without DEVFLOW_REQUIRE_TOKEN=1, even with a password and nothing else exposed', () => {
    const v = exposureVerdict({ ...base, serverMode: true, requireToken: false });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/DEVFLOW_REQUIRE_TOKEN=1/);
    expect(v.message).toMatch(/setup --server/);
  });
  it('refuses the same even with DEVFLOW_ALLOW_OPEN_REMOTE=1', () => {
    expect(exposureVerdict({ ...base, allowOpen: true, serverMode: true, requireToken: false }).ok).toBe(false);
  });
  it('starts in server mode when the token is required, and a desktop install is unchanged', () => {
    expect(exposureVerdict({ ...base, serverMode: true, requireToken: true }).ok).toBe(true);
    expect(exposureVerdict({ ...base }).ok).toBe(true);
  });
  it('checkExposureAtStartup reads both settings from the environment', async () => {
    const off = await checkExposureAtStartup({ DEVFLOW_SERVER_MODE: '1' });
    expect(off.ok).toBe(false);
    const on = await checkExposureAtStartup({ DEVFLOW_SERVER_MODE: '1', DEVFLOW_REQUIRE_TOKEN: '1' });
    expect(on.exposures).toEqual([]);
  });
});
