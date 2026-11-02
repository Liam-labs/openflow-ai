import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let dir: string;
vi.mock('@/lib/data-paths', async () => ({
  DataPaths: {
    get dashboardAuth() { return path.join(dir, 'dashboard-auth.json'); },
    get remoteAccess() { return path.join(dir, 'remote-access.json'); },
    get apiTokens() { return path.join(dir, 'api-tokens.json'); },
  },
}));

const mod = () => import('@/lib/wizards/tailscale');
type TS = typeof import('@/lib/wizards/tailscale');

interface FakeState {
  installed: boolean; state: string; dns: string; certs: string[] | null; operator: boolean;
  serve: Record<string, { https: boolean; target: string }>;
  calls: string[][]; failServe?: string; ignoreServe?: boolean; failOff?: boolean; noopOff?: boolean; wrongTarget?: boolean;
}

function fake(init: Partial<FakeState> = {}) {
  const st: FakeState = { installed: true, state: 'Running', dns: 'my-box.tail1234.ts.net.', certs: null, operator: true, serve: {}, calls: [], ...init };
  const serveJson = () => JSON.stringify({
    TCP: Object.fromEntries(Object.entries(st.serve).map(([p, e]) => [p, e.https ? { HTTPS: true } : { HTTP: true }])),
    Web: Object.fromEntries(Object.entries(st.serve).map(([p, e]) => [`${st.dns.replace(/\.$/, '')}:${p}`, { Handlers: { '/': { Proxy: e.target } } }])),
  });
  const run = vi.fn(async (args: string[]) => {
    st.calls.push(args);
    const key = args.join(' ');
    if (!st.installed) return { code: 127, stdout: '', stderr: 'not found' };
    if (key === 'version') return { code: 0, stdout: '1.102.4\n  tailscale commit: abc\n', stderr: '' };
    if (key === 'status --json') return { code: 0, stdout: JSON.stringify({ BackendState: st.state, Self: { DNSName: st.dns, TailscaleIPs: ['100.64.1.2', 'fd7a:115c:a1e0::1'] }, CertDomains: st.certs }), stderr: '' };
    if (key === 'debug prefs') return { code: 0, stdout: JSON.stringify(st.operator ? { OperatorUser: 'me' } : {}), stderr: '' };
    if (key === 'serve status --json') return { code: 0, stdout: Object.keys(st.serve).length ? serveJson() : '{}', stderr: '' };
    if (args[0] === 'serve' && args[1] === '--bg') {
      if (st.failServe) return { code: 1, stdout: '', stderr: st.failServe };
      const m = /^--(https?)=(\d+)$/.exec(args[2])!;
      if (!st.ignoreServe) st.serve[m[2]] = { https: m[1] === 'https', target: st.wrongTarget ? 'http://127.0.0.1:1' : args[3] };
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'serve' && args[2] === 'off') {
      if (st.failOff) return { code: 1, stdout: '', stderr: 'boom' };
      if (st.noopOff) return { code: 0, stdout: '', stderr: '' };
      delete st.serve[/=(\d+)$/.exec(args[1])![1]];
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 126, stdout: '', stderr: 'not allowed' };
  });
  return { st, run };
}

function deps(t: TS, f: ReturnType<typeof fake>, over: Partial<import('@/lib/wizards/tailscale').Deps> = {}, record = { enabled: false } as import('@/lib/wizards/tailscale').RemoteRecord) {
  const box = { record };
  const d: import('@/lib/wizards/tailscale').Deps = {
    run: f.run, env: { PORT: '3000' }, passwordSet: async () => true,
    readRecord: async () => box.record, writeRecord: async (r) => { box.record = r; }, now: () => '2026-10-22T12:00:00.000Z', ...over,
  };
  return { d, box };
}

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tswiz-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('which commands may run', () => {
  it('allows exactly the commands the wizard uses', async () => {
    const { allowedTailscaleArgs: ok } = await mod();
    for (const a of [['version'], ['status', '--json'], ['serve', 'status', '--json'], ['debug', 'prefs'],
      ['serve', '--bg', '--https=443', 'http://127.0.0.1:3000'], ['serve', '--bg', '--http=8080', 'http://127.0.0.1:3000'], ['serve', '--http=8080', 'off'], ['serve', '--https=443', 'off']]) {
      expect(ok(a), a.join(' ')).toBe(true);
    }
  });
  it.each([
    ['funnel'], ['funnel', '443', 'on'], ['serve', 'funnel'], ['funnel', '--bg', '3000'],
    ['serve', 'reset'], ['serve', 'clear'], ['up'], ['down'], ['logout'], ['set', '--operator=me'], ['serve', 'set-config', 'x'],
    ['serve', '--bg', '--https=443', 'http://127.0.0.1:3000', '--funnel'],
    ['serve', '--bg', '--https=443', 'http://example.com:3000'], ['serve', '--bg', '--https=443', 'http://127.0.0.1:3000/x'],
    ['serve', '--bg', '--https=443', 'http://127.0.0.1:3000; rm -rf /'], ['serve', '--bg', '--http=0', 'http://127.0.0.1:3000'],
    ['serve', '--bg', '--http=70000', 'http://127.0.0.1:3000'], ['serve', '--bg', '--tcp=22', 'http://127.0.0.1:3000'], ['serve', '--bg', '--http=80', 'http://127.0.0.1:0'],
    ['serve', '--http=8080', 'on'], ['up', '--http=8080', 'off'], ['funnel', '--http=8080', 'off'], ['serve', '--http=x', 'off'], ['status'], [],
  ])('refuses %j', async (...args) => {
    const { allowedTailscaleArgs } = await mod();
    expect(allowedTailscaleArgs(args)).toBe(false);
  });
  it('the real runner never starts a program for a refused command', async () => {
    const { defaultRunTs } = await mod();
    expect(await defaultRunTs(['funnel', '443', 'on'])).toEqual({ code: 126, stdout: '', stderr: 'command not allowed' });
  });
  it('no code in the wizard names the public-internet command outside comments', async () => {
    for (const file of ['lib/wizards/tailscale.ts', 'lib/wizards/tailscale-visits.ts', 'app/api/wizards/tailscale/route.ts', 'components/wizards/TailscaleWizard.tsx']) {
      const src = await fs.readFile(path.join(process.cwd(), file), 'utf8').catch(() => '');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/ .*$/gm, '');
      // The UI may explain in words that nothing goes on the public internet; no quoted argument or identifier may spell the command.
      expect(code, file).not.toMatch(/['"`]funnel['"`]|funnel\s*\(|--funnel/i);
    }
  });
});

describe('parsing what Tailscale says', () => {
  it('reads status', async () => {
    const t = await mod();
    expect(t.parseStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'a.b.ts.net.', TailscaleIPs: ['100.1.1.1'] }, CertDomains: ['a.b.ts.net'] }))).toEqual({ state: 'Running', dnsName: 'a.b.ts.net', ips: ['100.1.1.1'], httpsReady: true });
    expect(t.parseStatus(JSON.stringify({ BackendState: 'NeedsLogin', CertDomains: null }))).toMatchObject({ state: 'NeedsLogin', dnsName: null, httpsReady: false });
    expect(t.parseStatus(JSON.stringify({ BackendState: 'Running', CertDomains: [] })).httpsReady).toBe(false);
    expect(t.parseStatus('not json')).toEqual({ state: null, dnsName: null, ips: [], httpsReady: false });
    expect(t.parseStatus(JSON.stringify({ Self: { TailscaleIPs: [1, '100.2.2.2'] }, CertDomains: [] })).ips).toEqual(['100.2.2.2']);
  });
  it('reads Serve status, including an empty one and a real captured one', async () => {
    const t = await mod();
    expect(t.parseServe('{}')).toEqual([]);
    expect(t.parseServe('garbage')).toEqual([]);
    const real = '{"TCP":{"8095":{"HTTP":true},"443":{"HTTPS":true}},"Web":{"my-box.example.ts.net:8095":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3099"}}},"my-box.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}';
    expect(t.parseServe(real)).toEqual([{ port: 443, https: true, target: 'http://127.0.0.1:3000' }, { port: 8095, https: false, target: 'http://127.0.0.1:3099' }]);
  });
  it('gatherFacts reports not installed when the program is missing', async () => {
    const t = await mod();
    const f = fake({ installed: false });
    expect(await t.gatherFacts(f.run)).toMatchObject({ installed: false, state: null, serve: [] });
    expect(f.st.calls).toHaveLength(1);
  });
  it('gatherFacts in a container runs no Tailscale command at all', async () => {
    const t = await mod();
    const f = fake();
    expect(await t.gatherFacts(f.run, true)).toMatchObject({ inContainer: true, installed: false });
    expect(f.st.calls).toEqual([]);
    expect((await t.gatherFacts(f.run, false)).inContainer).toBe(false);
  });
  it('gatherFacts asks for the operator permission when prefs lack it', async () => {
    const t = await mod();
    expect((await t.gatherFacts(fake({ operator: false }).run)).operatorOk).toBe(false);
    expect((await t.gatherFacts(fake({ operator: true }).run)).operatorOk).toBe(true);
  });
});

describe('planServe', () => {
  const facts = (over: Partial<import('@/lib/wizards/tailscale').TailscaleFacts> = {}): import('@/lib/wizards/tailscale').TailscaleFacts =>
    ({ installed: true, version: '1', state: 'Running', dnsName: 'my-box.t.ts.net', ips: [], httpsReady: false, operatorOk: true, inContainer: false, serve: [], ...over });
  it('refuses each missing prerequisite with the fix to show', async () => {
    const { planServe } = await mod();
    expect(planServe(facts({ installed: false }), 3000)).toMatchObject({ ok: false, fix: 'install' });
    expect(planServe(facts({ state: 'NeedsLogin' }), 3000)).toMatchObject({ ok: false, fix: 'login' });
    expect(planServe(facts({ dnsName: null }), 3000)).toMatchObject({ ok: false, fix: 'login' });
    expect(planServe(facts({ operatorOk: false }), 3000)).toMatchObject({ ok: false, fix: 'operator' });
    expect(planServe(facts({ inContainer: true, installed: false }), 3000)).toMatchObject({ ok: false, fix: 'container' });
    expect(planServe(facts({ inContainer: true }), 3000)).toMatchObject({ ok: false, fix: 'container' });
  });
  it('uses https on 443 when the tailnet has certificates, plain http on 8080 otherwise', async () => {
    const { planServe } = await mod();
    expect(planServe(facts({ httpsReady: true }), 3000)).toEqual({ ok: true, https: true, port: 443, target: 'http://127.0.0.1:3000', url: 'https://my-box.t.ts.net' });
    expect(planServe(facts(), 4100)).toEqual({ ok: true, https: false, port: 8080, target: 'http://127.0.0.1:4100', url: 'http://my-box.t.ts.net:8080' });
  });
  it('never plans over a port that something else already serves', async () => {
    const { planServe } = await mod();
    const used = (ports: number[]) => ports.map((port) => ({ port, https: false, target: 'http://127.0.0.1:1' }));
    expect(planServe(facts({ httpsReady: true, serve: used([443]) }), 3000)).toMatchObject({ ok: true, port: 8443, url: 'https://my-box.t.ts.net:8443' });
    expect(planServe(facts({ serve: used([8080, 8081]) }), 3000)).toMatchObject({ ok: true, port: 8082 });
    expect(planServe(facts({ serve: used([8080, 8081, 8082, 8083]) }), 3000)).toMatchObject({ ok: false });
  });
});

describe('enableTailscale', () => {
  it('switches Serve on, checks it appeared, and records exactly what it did', async () => {
    const t = await mod();
    const f = fake(); const { d, box } = deps(t, f);
    const r = await t.enableTailscale(d);
    expect(r).toEqual({ ok: true, url: 'http://my-box.tail1234.ts.net:8080' });
    expect(f.st.serve).toEqual({ '8080': { https: false, target: 'http://127.0.0.1:3000' } });
    expect(f.st.calls.find((c) => c[0] === 'serve' && c[1] === '--bg')).toEqual(['serve', '--bg', '--http=8080', 'http://127.0.0.1:3000']);
    expect(box.record).toEqual({ enabled: true, tailscale: { port: 8080, https: false, target: 'http://127.0.0.1:3000', url: 'http://my-box.tail1234.ts.net:8080', at: '2026-10-22T12:00:00.000Z' } });
  });
  it('uses https when certificates are on and the app port from PORT', async () => {
    const t = await mod();
    const f = fake({ certs: ['my-box.tail1234.ts.net'] }); const { d } = deps(t, f, { env: { PORT: '4100' } });
    expect(await t.enableTailscale(d)).toMatchObject({ ok: true, url: 'https://my-box.tail1234.ts.net' });
    expect(f.st.serve).toEqual({ '443': { https: true, target: 'http://127.0.0.1:4100' } });
  });
  it('refuses with no password, and runs nothing that changes Tailscale', async () => {
    const t = await mod();
    const f = fake(); const { d, box } = deps(t, f, { passwordSet: async () => false });
    expect(await t.enableTailscale(d)).toMatchObject({ ok: false, fix: 'password' });
    expect(f.st.calls).toEqual([]);
    expect(box.record.enabled).toBe(false);
  });
  it('refuses when the app listens beyond this computer', async () => {
    const t = await mod();
    const f = fake(); const { d } = deps(t, f, { env: { PORT: '3000', DEVFLOW_BIND_HOST: '0.0.0.0' } });
    const r = await t.enableTailscale(d);
    expect(r.ok).toBe(false);
    expect(f.st.serve).toEqual({});
  });
  it.each([['not installed', { installed: false }, 'install'], ['signed out', { state: 'NeedsLogin' }, 'login'], ['no operator permission', { operator: false }, 'operator']] as const)('%s: stops with the fix', async (_n, over, fix) => {
    const t = await mod();
    const f = fake(over); const { d } = deps(t, f);
    expect(await t.enableTailscale(d)).toMatchObject({ ok: false, fix });
    expect(f.st.calls.some((c) => c[1] === '--bg')).toBe(false);
  });
  it('turns an access-denied answer into the operator fix', async () => {
    const t = await mod();
    const f = fake({ failServe: 'Access denied: serve config denied' }); const { d, box } = deps(t, f);
    expect(await t.enableTailscale(d)).toMatchObject({ ok: false, fix: 'operator' });
    expect(box.record.enabled).toBe(false);
  });
  it('reports another failure plainly', async () => {
    const t = await mod();
    const f = fake({ failServe: 'something odd\nsecond line' }); const { d } = deps(t, f);
    const r = await t.enableTailscale(d);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toContain('something odd');
    expect(r.ok === false && r.fix).toBeUndefined();
  });
  it('removes the entry again when it did not appear as expected', async () => {
    const t = await mod();
    const f = fake({ ignoreServe: true }); const { d, box } = deps(t, f);
    expect(await t.enableTailscale(d)).toMatchObject({ ok: false });
    expect(f.st.calls.some((c) => c[0] === 'serve' && c[2] === 'off')).toBe(true);
    expect(box.record.enabled).toBe(false);
  });
  it('switches Serve off again when the setting cannot be saved', async () => {
    const t = await mod();
    const f = fake(); const { d } = deps(t, f, { writeRecord: async () => { throw new Error('disk full'); } });
    const r = await t.enableTailscale(d);
    expect(r.ok === false && r.error).toMatch(/disk full/);
    expect(f.st.serve).toEqual({});
  });
  it('removes the entry when Tailscale shows a different target than we asked for', async () => {
    const t = await mod();
    const f = fake({ wrongTarget: true }); const { d, box } = deps(t, f);
    expect(await t.enableTailscale(d)).toMatchObject({ ok: false });
    expect(f.st.calls.some((c) => c[2] === 'off')).toBe(true);
    expect(box.record.enabled).toBe(false);
  });
  it('is idempotent: already on changes nothing; a second wizard run does not stack entries', async () => {
    const t = await mod();
    const f = fake(); const { d } = deps(t, f);
    await t.enableTailscale(d);
    const callsBefore = f.st.calls.filter((c) => c[1] === '--bg').length;
    expect(await t.enableTailscale(d)).toMatchObject({ ok: true, note: 'Already switched on.' });
    expect(f.st.calls.filter((c) => c[1] === '--bg')).toHaveLength(callsBefore);
    expect(Object.keys(f.st.serve)).toEqual(['8080']);
  });
  it('leaves another Serve entry alone and picks the next port', async () => {
    const t = await mod();
    const f = fake({ serve: { '8080': { https: false, target: 'http://127.0.0.1:9999' } } }); const { d } = deps(t, f);
    expect(await t.enableTailscale(d)).toMatchObject({ ok: true, url: 'http://my-box.tail1234.ts.net:8081' });
    expect(f.st.serve['8080']).toEqual({ https: false, target: 'http://127.0.0.1:9999' });
  });
});

describe('disableTailscale', () => {
  it('removes only our entry and records that it is off', async () => {
    const t = await mod();
    const f = fake({ serve: { '9000': { https: false, target: 'http://127.0.0.1:1' } } }); const { d, box } = deps(t, f);
    await t.enableTailscale(d);
    expect(Object.keys(f.st.serve).sort()).toEqual(['8080', '9000']);
    expect(await t.disableTailscale(d)).toEqual({ ok: true, note: 'Switched off.' });
    expect(f.st.serve).toEqual({ '9000': { https: false, target: 'http://127.0.0.1:1' } });
    expect(box.record).toEqual({ enabled: false });
  });
  it('does nothing when it never switched anything on', async () => {
    const t = await mod();
    const f = fake(); const { d } = deps(t, f);
    const r = await t.disableTailscale(d);
    expect(r).toEqual({ ok: true, note: 'Remote access through Tailscale was not switched on here.' });
    expect(f.st.calls).toEqual([]);
  });
  it('leaves Tailscale alone when our entry was changed by someone else', async () => {
    const t = await mod();
    const f = fake(); const { d, box } = deps(t, f);
    await t.enableTailscale(d);
    f.st.serve['8080'] = { https: false, target: 'http://127.0.0.1:7777' };       // the user repointed it
    const r = await t.disableTailscale(d);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.note).toMatch(/already been changed/);
    expect(f.st.serve['8080'].target).toBe('http://127.0.0.1:7777');
    expect(f.st.calls.some((c) => c[2] === 'off')).toBe(false);
    expect(box.record).toEqual({ enabled: false });
  });
  it('removes an https entry with the https flag', async () => {
    const t = await mod();
    const f = fake({ certs: ['x'] }); const { d } = deps(t, f);
    await t.enableTailscale(d);
    await t.disableTailscale(d);
    expect(f.st.calls.find((c) => c[2] === 'off')).toEqual(['serve', '--https=443', 'off']);
    expect(f.st.serve).toEqual({});
  });
  it('does not claim success when Tailscale says ok but the entry is still there', async () => {
    const t = await mod();
    const f = fake(); const { d, box } = deps(t, f);
    await t.enableTailscale(d);
    f.st.noopOff = true;
    const r = await t.disableTailscale(d);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/did not look as expected/);
    expect(box.record.enabled).toBe(true);
  });
  it('keeps the record and says so when Tailscale refuses to remove it', async () => {
    const t = await mod();
    const f = fake(); const { d, box } = deps(t, f);
    await t.enableTailscale(d);
    f.st.failOff = true;
    const r = await t.disableTailscale(d);
    expect(r.ok === false && r.error).toMatch(/could not remove the Serve entry: boom/);
    expect(box.record.enabled).toBe(true);
  });
  it('notices when removing it disturbed another entry', async () => {
    const t = await mod();
    const f = fake({ serve: { '9000': { https: false, target: 'http://127.0.0.1:1' } } }); const { d } = deps(t, f);
    await t.enableTailscale(d);
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (args: string[]) => { const r = await original(args); if (args[2] === 'off') delete f.st.serve['9000']; return r; });
    expect(await t.disableTailscale(d)).toMatchObject({ ok: false });
  });
});

describe('recordMatches', () => {
  it('needs port, mode and target all to match', async () => {
    const { recordMatches } = await mod();
    const rec = { enabled: true, tailscale: { port: 8080, https: false, target: 'http://127.0.0.1:3000', url: 'u', at: 'x' } };
    expect(recordMatches(rec, [{ port: 8080, https: false, target: 'http://127.0.0.1:3000' }])).toBe(true);
    expect(recordMatches(rec, [{ port: 8081, https: false, target: 'http://127.0.0.1:3000' }])).toBe(false);
    expect(recordMatches(rec, [{ port: 8080, https: true, target: 'http://127.0.0.1:3000' }])).toBe(false);
    expect(recordMatches(rec, [{ port: 8080, https: false, target: 'http://127.0.0.1:3001' }])).toBe(false);
    expect(recordMatches({ enabled: false }, [])).toBe(false);
    expect(recordMatches(rec, [{ port: 22, https: false, target: 'x' }, { port: 8080, https: false, target: 'http://127.0.0.1:3000' }])).toBe(true);
    expect(recordMatches(rec, [{ port: 22, https: false, target: 'http://127.0.0.1:3000' }])).toBe(false);
  });
});

describe('proveReachable', () => {
  it('passes when the tailnet address answers, and asks the session route (no data, no redirect)', async () => {
    const { proveReachable } = await mod();
    const seen: string[] = [];
    const r = await proveReachable('http://x:8080', async (u) => { seen.push(u); return { status: 200 }; });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['http://x:8080/api/auth/session']);
  });
  it('fails on any other answer', async () => {
    const { proveReachable } = await mod();
    for (const status of [404, 500, 502, 307]) expect((await proveReachable('http://x', async () => ({ status }))).ok, String(status)).toBe(false);
  });
  it('reports an unreachable address as a failed step', async () => {
    const { proveReachable } = await mod();
    const r = await proveReachable('http://x', async () => { throw new Error('ECONNREFUSED'); });
    expect(r.ok).toBe(false);
    expect(r.steps[0].detail).toMatch(/ECONNREFUSED/);
  });
});

describe('judgeSecondDevice', () => {
  it('waits when nothing came from another device', async () => {
    const { judgeSecondDevice } = await mod();
    expect(judgeSecondDevice([]).state).toBe('waiting');
  });
  it('is ok when every other device was turned away, naming the latest', async () => {
    const { judgeSecondDevice } = await mod();
    const r = judgeSecondDevice([{ device: '100.64.0.1', allowed: false }, { device: '100.64.0.2', allowed: false }]);
    expect(r.state).toBe('ok');
    expect(r.detail).toContain('100.64.0.2');
  });
  it('is a failure when any other device got in without signing in, even after others were turned away', async () => {
    const { judgeSecondDevice } = await mod();
    const r = judgeSecondDevice([{ device: '100.64.0.1', allowed: false }, { device: '100.64.0.9', allowed: true }, { device: '100.64.0.2', allowed: false }]);
    expect(r.state).toBe('open');
    expect(r.detail).toContain('100.64.0.9');
    expect(r.detail).toMatch(/WITHOUT signing in/);
  });
});

describe('second-device visits', () => {
  it('notes a tailnet device, ignores others, and leaves out this computer', async () => {
    const v = await import('@/lib/wizards/tailscale-visits');
    v.clearVisitsForTests();
    const h = (m: Record<string, string>) => ({ get: (n: string) => m[n.toLowerCase()] ?? null });
    v.noteTailnetVisit(h({ 'x-forwarded-for': '100.64.9.9', 'tailscale-user-login': 'me@example.com' }), false, 1000);
    v.noteTailnetVisit(h({ 'x-forwarded-for': '100.64.1.2' }), true, 1000);                       // this computer's own test
    v.noteTailnetVisit(h({ 'x-forwarded-for': '203.0.113.5' }), false, 1000);                      // not a tailnet address
    v.noteTailnetVisit(h({ 'x-forwarded-for': '1.2.3.4, 100.101.0.1' }), true, 1000);             // last entry is the real peer
    v.noteTailnetVisit(h({}), false, 1000);
    const seen = v.recentOtherDeviceVisits(['100.64.1.2'], 60000, 2000);
    expect(seen.map((x) => x.device)).toEqual(['100.64.9.9', '100.101.0.1']);
    expect(seen[0].user).toBe('me@example.com');
    expect(seen.map((x) => x.allowed)).toEqual([false, true]);
    expect(v.recentOtherDeviceVisits(['100.64.1.2'], 500, 2000)).toEqual([]);              // too old
    v.clearVisitsForTests();
    for (let i = 0; i < 25; i++) v.noteTailnetVisit(h({ 'x-forwarded-for': `100.64.0.${i + 1}` }), false, 1000);
    expect(v.recentOtherDeviceVisits([], 60000, 2000)).toHaveLength(20);
  });
  it('tailnet address ranges', async () => {
    const { isTailnetAddress } = await import('@/lib/wizards/tailscale-visits');
    for (const ip of ['100.64.0.1', '100.127.255.1', '::ffff:100.100.1.1', 'fd7a:115c:a1e0::2b3b:ad28']) expect(isTailnetAddress(ip), ip).toBe(true);
    for (const ip of ['100.63.0.1', '100.128.0.1', '101.64.0.1', '99.64.0.1', '10.0.0.1', '203.0.113.1', 'fd7b::1', '']) expect(isTailnetAddress(ip), ip).toBe(false);
  });
});

describe('/api/wizards/tailscale and the session hook', () => {
  const NextRequest = async () => (await import('next/server')).NextRequest;
  const req = async (method: 'GET' | 'POST', body?: unknown, headers: Record<string, string> = {}) =>
    new (await NextRequest())(`http://127.0.0.1:3000/api/wizards/tailscale`, { method, headers: { host: '127.0.0.1:3000', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('refuses a caller that is not on this machine and has no token, before touching Tailscale', async () => {
    vi.resetModules();
    const ran = vi.fn();
    vi.doMock('@/lib/wizards/tailscale', async (orig) => ({ ...(await orig<typeof import('@/lib/wizards/tailscale')>()), defaultRunTs: ran, gatherFacts: ran, enableTailscale: ran, disableTailscale: ran }));
    const route = await import('@/app/api/wizards/tailscale/route');
    const outside = { 'x-forwarded-for': '203.0.113.7' };
    expect((await route.GET(await req('GET', undefined, outside))).status).toBe(401);
    for (const action of ['enable', 'disable', 'prove']) expect((await route.POST(await req('POST', { action }, outside))).status).toBe(401);
    expect(ran).not.toHaveBeenCalled();
    vi.doUnmock('@/lib/wizards/tailscale');
  });
  it('answers an unknown action and a missing body plainly; prove needs it switched on first', async () => {
    vi.resetModules();
    const route = await import('@/app/api/wizards/tailscale/route');
    expect((await route.POST(await req('POST', { action: 'bogus' }))).status).toBe(400);
    const bad = new (await NextRequest())('http://127.0.0.1:3000/api/wizards/tailscale', { method: 'POST', headers: { host: '127.0.0.1:3000' }, body: 'nope' });
    expect((await route.POST(bad)).status).toBe(400);
    const proved = await route.POST(await req('POST', { action: 'prove' }));
    expect(proved.status).toBe(409);
  });
  it('the gate notes a tailnet visitor with the answer it gave, and still answers the same', async () => {
    vi.resetModules();
    const visits = await import('@/lib/wizards/tailscale-visits');
    visits.clearVisitsForTests();
    const gate = await import('@/app/api/auth/gate/route');
    const R = await NextRequest();
    const res = await gate.GET(new R('http://127.0.0.1:3000/api/auth/gate', { headers: { host: '127.0.0.1:3000', 'x-forwarded-for': '100.64.9.9', 'tailscale-user-login': 'me@example.com' } }));
    expect(await res.json()).toEqual({ allow: false });
    expect(visits.recentOtherDeviceVisits([]).map((v) => [v.device, v.allowed])).toEqual([['100.64.9.9', false]]);
  });
});

describe('/api/wizards/tailscale with the Tailscale layer mocked', () => {
  const mk = async (over: Record<string, unknown>) => {
    vi.resetModules();
    vi.doMock('@/lib/wizards/tailscale', async (orig) => ({ ...(await orig<typeof import('@/lib/wizards/tailscale')>()), ...over }));
    return import('@/app/api/wizards/tailscale/route');
  };
  const post = async (route: { POST: (r: import('next/server').NextRequest) => Promise<Response> }, body: unknown) => {
    const { NextRequest } = await import('next/server');
    return route.POST(new NextRequest('http://127.0.0.1:3000/api/wizards/tailscale', { method: 'POST', headers: { host: '127.0.0.1:3000' }, body: JSON.stringify(body) }));
  };
  afterEach(() => { vi.doUnmock('@/lib/wizards/tailscale'); });
  const facts = { installed: true, version: '1', state: 'Running', dnsName: 'a.ts.net', ips: [], httpsReady: false, operatorOk: true, inContainer: false, serve: [] };

  it('enable and disable answer 200 on success and 409 when the step failed', async () => {
    const good = await mk({ gatherFacts: async () => facts, enableTailscale: async () => ({ ok: true, url: 'u' }), disableTailscale: async () => ({ ok: true }) });
    expect((await post(good, { action: 'enable' })).status).toBe(200);
    expect((await post(good, { action: 'disable' })).status).toBe(200);
    const bad = await mk({ gatherFacts: async () => facts, enableTailscale: async () => ({ ok: false, error: 'no' }), disableTailscale: async () => ({ ok: false, error: 'no' }) });
    expect((await post(bad, { action: 'enable' })).status).toBe(409);
    expect((await post(bad, { action: 'disable' })).status).toBe(409);
  });
  it('prove is refused when nothing is switched on, or when Serve no longer has our entry; it runs when both are true', async () => {
    const prove = vi.fn(async () => ({ ok: true, steps: [] }));
    const entry = { port: 8080, https: false, target: 'http://127.0.0.1:3000', url: 'http://a.ts.net:8080', at: 'x' };
    const gather = vi.fn(async () => facts);
    const none = await mk({ gatherFacts: gather, readRecord: async () => ({ enabled: false }), proveReachable: prove });
    expect((await post(none, { action: 'prove' })).status).toBe(409);
    expect(gather).not.toHaveBeenCalled();                       // nothing to check, so Tailscale is not even asked
    const gone = await mk({ gatherFacts: async () => facts, readRecord: async () => ({ enabled: true, tailscale: entry }), proveReachable: prove });
    expect((await post(gone, { action: 'prove' })).status).toBe(409);
    expect(prove).not.toHaveBeenCalled();
    const live = await mk({ gatherFacts: async () => ({ ...facts, serve: [{ port: 8080, https: false, target: 'http://127.0.0.1:3000' }] }), readRecord: async () => ({ enabled: true, tailscale: entry }), proveReachable: prove });
    const res = await post(live, { action: 'prove' });
    expect(res.status).toBe(200);
    expect(prove).toHaveBeenCalledWith('http://a.ts.net:8080');
  });

  it('GET reports the second-device verdict from other devices only, and only while it is switched on', async () => {
    const entry = { port: 8080, https: false, target: 'http://127.0.0.1:3000', url: 'http://a.ts.net:8080', at: 'x' };
    const serve = [{ port: 8080, https: false, target: 'http://127.0.0.1:3000' }];
    const get = async (route: { GET: (r: import('next/server').NextRequest) => Promise<Response> }) => {
      const { NextRequest } = await import('next/server');
      return (await route.GET(new NextRequest('http://127.0.0.1:3000/api/wizards/tailscale', { headers: { host: '127.0.0.1:3000' } }))).json();
    };
    const on = await mk({ gatherFacts: async () => ({ ...facts, ips: ['100.64.1.2'], serve }), readRecord: async () => ({ enabled: true, tailscale: entry }) });
    const visits = await import('@/lib/wizards/tailscale-visits');
    visits.clearVisitsForTests();
    const h = (m: Record<string, string>) => ({ get: (n: string) => m[n.toLowerCase()] ?? null });
    visits.noteTailnetVisit(h({ 'x-forwarded-for': '100.64.1.2' }), true);                 // this computer: ignored
    expect((await get(on)).secondDevice).toMatchObject({ state: 'waiting' });
    visits.noteTailnetVisit(h({ 'x-forwarded-for': '100.64.9.9' }), false);
    const turnedAway = await get(on);
    expect(turnedAway.secondDevice).toMatchObject({ state: 'ok' });
    expect(turnedAway.visits).toEqual([expect.objectContaining({ device: '100.64.9.9', allowed: false })]);
    visits.noteTailnetVisit(h({ 'x-forwarded-for': '100.64.9.8' }), true);
    expect((await get(on)).secondDevice).toMatchObject({ state: 'open' });
    const off = await mk({ gatherFacts: async () => ({ ...facts, ips: ['100.64.1.2'] }), readRecord: async () => ({ enabled: false }) });
    const stateOff = await get(off);
    expect(stateOff.secondDevice).toBeNull();
    expect(stateOff.visits).toEqual([]);
    const box = await mk({ gatherFacts: async () => ({ ...facts, inContainer: true, installed: false }), readRecord: async () => ({ enabled: false }) });
    visits.clearVisitsForTests();
    visits.noteTailnetVisit(h({ 'x-forwarded-for': '100.64.9.9' }), false);
    expect((await get(box)).secondDevice).toMatchObject({ state: 'ok' });
  });
});
