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
    get cloudflareAccess() { return path.join(dir, 'cloudflare-access.json'); },
    get cloudflareApiToken() { return path.join(dir, 'cloudflare-api-token'); },
    get cloudflaredToken() { return path.join(dir, 'cloudflared-tunnel-token'); },
    get cloudflaredPid() { return path.join(dir, 'cloudflared.pid'); },
    get cloudflaredLog() { return path.join(dir, 'cloudflared.log'); },
  },
}));

const api = () => import('@/lib/wizards/cloudflare-api');
const flow = () => import('@/lib/wizards/cloudflare');
type CfFetch = import('@/lib/wizards/cloudflare-api').CfFetch;
type Io = import('@/lib/wizards/cloudflare').Io;
type CfRecord = import('@/lib/wizards/cloudflare').CfRecord;

const TOKEN = 'cfut_' + 'A1b2C3d4E5'.repeat(4);

// ─── A pretend Cloudflare ────────────────────────────────────────────────────────────────────────────

interface World {
  tokenStatus: string; tokenId: string | null; tokenPolicies: unknown;
  zones: { id: string; name: string; account: { id: string } }[]; accounts: { id: string }[];
  allowed: Set<string>;                  // probe names the token may use
  noWorkersSubdomain?: boolean;          // the account never set up workers.dev: the subdomain probe answers 404 even with Workers
  org: boolean;
  orgRefused?: boolean;                  // the token may not read the organization (it lacks that permission): 403 code 10000
  dns: Map<string, { id: string; name: string; content: string }>;
  apps: Map<string, { id: string; domain: string; policies: { id: string }[] }>;
  policies: Map<string, { id: string }>;
  tunnels: Map<string, { id: string; status: string }>;
  tunnelStatus: string;
  failOn?: (method: string, path: string) => { status: number; message: string } | undefined;
  calls: { method: string; path: string; body: unknown }[];
}

const NARROW = ['Tunnels', 'Access applications', 'Access policies', 'DNS records'];

function world(over: Partial<World> = {}): World {
  return {
    tokenStatus: 'active', tokenId: 'tok1', tokenPolicies: undefined,
    zones: [{ id: 'z1', name: 'example.com', account: { id: 'a1' } }], accounts: [{ id: 'a1' }],
    allowed: new Set(NARROW), org: true, dns: new Map(), apps: new Map(), policies: new Map(), tunnels: new Map(), tunnelStatus: 'healthy', calls: [], ...over,
  };
}

function fakeFetch(w: World): CfFetch {
  const ok = (result: unknown, status = 200) => ({ status, json: async () => ({ success: true, result, errors: [] }) });
  const no = (status: number, message: string, code = 0) => ({ status, json: async () => ({ success: false, result: null, errors: [{ code, message }] }) });
  const denied = () => no(403, 'Authentication error', 10000);
  const probeFor = (p: string): string | null =>
    /\/cfd_tunnel\?/.test(p) ? 'Tunnels' : /\/access\/apps\?/.test(p) ? 'Access applications' : /\/access\/policies\?/.test(p) ? 'Access policies' : /\/dns_records\?per_page/.test(p) ? 'DNS records'
    : /\/workers\/subdomain/.test(p) ? 'Workers' : /\/storage\/kv/.test(p) ? 'Key-value storage' : /\/r2\/buckets/.test(p) ? 'R2 storage' : /\/d1\/database/.test(p) ? 'Databases (D1)' : /\/members/.test(p) ? 'Account members' : /\/zones\/[^/]+\/settings/.test(p) ? 'Domain settings' : null;
  return async (url, init) => {
    const p = url.replace('https://api.cloudflare.com/client/v4', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    w.calls.push({ method: init.method, path: p, body });
    const injected = w.failOn?.(init.method, p);
    if (injected) return no(injected.status, injected.message);
    if (init.method === 'GET' && p === '/user/tokens/verify') return ok({ id: w.tokenId, status: w.tokenStatus });
    if (init.method === 'GET' && /^\/user\/tokens\/tok/.test(p)) return w.tokenPolicies ? ok({ policies: w.tokenPolicies }) : denied();
    if (init.method === 'GET' && p.startsWith('/zones?')) return ok(w.zones);
    if (init.method === 'GET' && p.startsWith('/accounts?')) return ok(w.accounts);
    // Like the real API: the script list answers every token, and holds the scripts only for a token with Workers.
    if (init.method === 'GET' && /\/workers\/scripts$/.test(p)) return ok(w.allowed.has('Workers') ? [{ id: 'site-worker' }] : []);
    if (init.method === 'GET' && /\/workers\/subdomain$/.test(p) && w.noWorkersSubdomain) return w.allowed.has('Workers') ? no(404, 'This account does not have a workers.dev subdomain', 10007) : denied();
    const probe = init.method === 'GET' ? probeFor(p) : null;
    if (probe) return w.allowed.has(probe) ? ok([]) : denied();
    if (init.method === 'GET' && /\/access\/organizations$/.test(p)) return w.orgRefused ? denied() : w.org ? ok({ name: 'team' }) : no(400, 'access.api.error.not_enabled', 9999);
    if (init.method === 'POST' && /\/access\/(policies|apps)$/.test(p) && !w.org) return no(400, 'access.api.error.not_enabled', 9999);
    let m: RegExpExecArray | null;
    if (init.method === 'POST' && /\/access\/policies$/.test(p)) { const id = `pol${w.policies.size + 1}`; w.policies.set(id, { id }); return ok({ id }); }
    if (init.method === 'POST' && /\/access\/apps$/.test(p)) { const id = `app${w.apps.size + 1}`; w.apps.set(id, { id, domain: body.domain, policies: body.policies.map((x: { id: string }) => ({ id: x.id })) }); return ok({ id }); }
    if (init.method === 'GET' && (m = /\/access\/apps\/(\w+)$/.exec(p))) { const a = w.apps.get(m[1]); return a ? ok(a) : no(404, 'not found'); }
    if (init.method === 'DELETE' && (m = /\/access\/apps\/(\w+)$/.exec(p))) return w.apps.delete(m[1]) ? ok({ id: m[1] }) : no(404, 'not found');
    if (init.method === 'DELETE' && (m = /\/access\/policies\/(\w+)$/.exec(p))) return w.policies.delete(m[1]) ? ok({ id: m[1] }) : no(404, 'not found');
    if (init.method === 'POST' && /\/cfd_tunnel$/.test(p)) { const id = `tun${w.tunnels.size + 1}`; w.tunnels.set(id, { id, status: w.tunnelStatus }); return ok({ id, token: `tunnel-token-${id}`, remote_config: true }); }
    if (init.method === 'PUT' && /\/cfd_tunnel\/\w+\/configurations$/.test(p)) return ok({});
    if (init.method === 'GET' && (m = /\/cfd_tunnel\/(\w+)$/.exec(p))) { const t = w.tunnels.get(m[1]); return t ? ok({ id: t.id, status: t.status }) : no(404, 'not found'); }
    if (init.method === 'DELETE' && /\/cfd_tunnel\/\w+\/connections$/.test(p)) return ok({});
    if (init.method === 'DELETE' && (m = /\/cfd_tunnel\/(\w+)$/.exec(p))) return w.tunnels.delete(m[1]) ? ok({ id: m[1] }) : no(404, 'not found');
    if (init.method === 'GET' && /\/dns_records\?name=/.test(p)) { const name = decodeURIComponent(/name=([^&]+)/.exec(p)![1]); return ok([...w.dns.values()].filter((r) => r.name === name)); }
    if (init.method === 'POST' && /\/dns_records$/.test(p)) { const id = `dns${w.dns.size + 1}`; w.dns.set(id, { id, name: body.name, content: body.content }); return ok({ id }); }
    if (init.method === 'GET' && (m = /\/dns_records\/(\w+)$/.exec(p))) { const r = w.dns.get(m[1]); return r ? ok(r) : no(404, 'not found'); }
    if (init.method === 'DELETE' && (m = /\/dns_records\/(\w+)$/.exec(p))) return w.dns.delete(m[1]) ? ok({ id: m[1] }) : no(404, 'not found');
    return no(404, `unhandled ${init.method} ${p}`);
  };
}

// ─── A pretend Io ────────────────────────────────────────────────────────────────────────────────────

function fakeIo(over: Partial<Io> = {}) {
  const box = { record: { enabled: false, stage: 'none' } as CfRecord, tunnelToken: null as string | null, running: false, writes: [] as CfRecord[], events: [] as string[], public: [] as { status: number; location: string | null }[], installed: '/usr/bin/cloudflared' as string | null, startError: null as string | null };
  const io: Io = {
    env: { PORT: '3000' }, now: () => '2026-10-22T12:00:00.000Z', sleep: async () => undefined, passwordSet: async () => true,
    readRecord: async () => JSON.parse(JSON.stringify(box.record)),
    writeRecord: async (r) => { box.record = JSON.parse(JSON.stringify(r)); box.writes.push(JSON.parse(JSON.stringify(r))); },
    writeTunnelToken: async (t) => { box.tunnelToken = t; box.events.push('token-written'); },
    removeTunnelToken: async () => { box.tunnelToken = null; box.events.push('token-removed'); },
    runner: {
      installed: async () => ({ path: box.installed, version: '2026.1' }), running: async () => box.running,
      start: async () => { box.events.push('start'); if (box.startError) return { ok: false as const, error: box.startError }; box.running = true; return { ok: true as const }; },
      stop: async () => { box.events.push('stop'); box.running = false; },
    },
    fetchPublic: async () => box.public.shift() ?? { status: 302, location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/openflow.example.com?kid=1' },
    ...over,
  };
  return { io, box };
}

const known = { accountId: 'a1', zones: [{ id: 'z1', name: 'example.com', accountId: 'a1' }] };
const params = (over: Record<string, unknown> = {}) => ({ zoneId: 'z1', subdomain: 'openflow', emails: 'me@example.org', accountId: 'a1', zones: known.zones, ...over });
const mkApi = async (w: World, token = TOKEN) => new (await api()).CloudflareApi(token, fakeFetch(w));

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfwiz-')); for (const n of ['DEVFLOW_BIND_HOST', 'DEVFLOW_ALLOW_OPEN_REMOTE']) vi.stubEnv(n, ''); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(dir, { recursive: true, force: true }); });

// ─── Pure checks ─────────────────────────────────────────────────────────────────────────────────────

describe('what the user types', () => {
  it('refuses a Global API Key and anything that does not look like a token', async () => {
    const { tokenShapeProblem } = await api();
    expect(tokenShapeProblem('0123456789abcdef0123456789abcdef01234')).toMatch(/Global API Key/);
    expect(tokenShapeProblem('0123456789ABCDEF0123456789ABCDEF01234')).toMatch(/Global API Key/);
    expect(tokenShapeProblem('cfk_' + 'A1b2C3d4E5'.repeat(4) + '0a1b2c3d')).toMatch(/Global API Key/);                  // 2026-format global key
    expect(tokenShapeProblem('cfut_' + 'A1b2C3d4E5'.repeat(4) + '0a1b2c3d')).toBeNull();
    for (const bad of ['', '   ', undefined, 42, 'short', 'has spaces in the middle of it which is long enough', 'x'.repeat(201)]) expect(tokenShapeProblem(bad), String(bad)).not.toBeNull();
    expect(tokenShapeProblem(TOKEN)).toBeNull();
    expect(tokenShapeProblem(`  ${TOKEN}  `)).toBeNull();
  });
  it('subdomain: one clean label, not www', async () => {
    const { subdomainProblem } = await api();
    for (const ok of ['openflow', 'my-app', 'a1', 'A']) expect(subdomainProblem(ok), ok).toBeNull();
    for (const bad of ['', '-x', 'x-', 'a.b', 'a b', 'www', 'WWW', '*', 'a'.repeat(64), 5, undefined, 'a/b']) expect(subdomainProblem(bad), String(bad)).not.toBeNull();
  });
  it('hostnameFor lower-cases and joins', async () => {
    expect((await api()).hostnameFor(' OpenFlow ', 'Example.COM')).toBe('openflow.example.com');
  });
  it('emails: exact addresses only, de-duplicated, at least one, at most 20', async () => {
    const { parseEmails } = await api();
    expect(parseEmails('Me@Example.org, you@example.org;  me@example.org')).toEqual({ ok: true, emails: ['me@example.org', 'you@example.org'] });
    expect(parseEmails(['a@example.org'])).toEqual({ ok: true, emails: ['a@example.org'] });
    for (const bad of ['', '   ', [], undefined, null, 5]) expect(parseEmails(bad).ok, String(bad)).toBe(false);
    for (const bad of ['*@example.org', '@example.org', 'example.org', 'me@localhost', 'a b@example.com', 'me@example.org!', '*', 'everyone', 'me@.org']) expect(parseEmails(bad).ok, bad).toBe(false);
    expect(parseEmails(Array.from({ length: 21 }, (_, i) => `u${i}@example.org`)).ok).toBe(false);
    expect(parseEmails(Array.from({ length: 20 }, (_, i) => `u${i}@example.org`)).ok).toBe(true);
  });
  it('only the app port may be published and never a debugging port', async () => {
    const { originPortProblem } = await api();
    expect(originPortProblem(3000, 3000)).toBeNull();
    expect(originPortProblem(3001, 3000)).toMatch(/own port/);
    for (const p of [9222, 9223, 9229, 9333, 9515, 4444]) expect(originPortProblem(p, p), String(p)).toMatch(/debugging port/);
    for (const p of [0, -1, 70000, 1.5, NaN]) expect(originPortProblem(p, 3000), String(p)).toMatch(/not a port/);
  });
});

describe('judgeBreadth', () => {
  const probe = async (name: string, expect_: 'allowed' | 'refused', status: number, success: boolean, codes: number[] = []) => ({ probe: { name, path: '/x', expect: expect_ }, status, success, codes });
  const base = async () => [await probe('Tunnels', 'allowed', 200, true), await probe('Workers', 'refused', 403, false, [10000])];
  const j = async (over: Partial<Parameters<Awaited<ReturnType<typeof api>>['judgeBreadth']>[0]> = {}) => (await api()).judgeBreadth({ probes: await base(), zoneCount: 1, accountCount: 1, extraGroups: null, wildcardZone: false, ...over });
  it('accepts a token that can do the listed things and is refused the rest', async () => { expect(await j()).toEqual({ ok: true, problems: [], notes: [] }); });
  it('rejects a needed permission that is missing', async () => {
    const r = await j({ probes: [await probe('Tunnels', 'allowed', 403, false, [10000])] });
    expect(r.ok).toBe(false); expect(r.problems[0]).toMatch(/cannot use "Tunnels"/);
  });
  it('rejects a token that also reaches something it should not', async () => {
    const r = await j({ probes: [...(await base()), await probe('R2 storage', 'refused', 200, true)] });
    expect(r.ok).toBe(false); expect(r.problems.join()).toMatch(/also reach "R2 storage"/);
  });
  it('a probe Cloudflare answered is accepted when the token\'s own permission list shows nothing extra, and still fails otherwise', async () => {
    const lenient = async () => [...(await base()), await probe('Workers', 'refused', 200, true)];
    const ok = await j({ probes: await lenient(), extraGroups: [] });
    expect(ok.ok).toBe(true); expect(ok.problems).toEqual([]); expect(ok.notes.join()).toMatch(/"Workers".*accepted/);
    expect((await j({ probes: await lenient(), extraGroups: null })).problems.join()).toMatch(/also reach "Workers"/);
    expect((await j({ probes: await lenient(), extraGroups: ['Workers Scripts Write'] })).problems.join()).toMatch(/also reach "Workers"/);
  });
  it('names the domains the token covers and the answer Cloudflare gave, so the person can tell which token was checked', async () => {
    const many = await j({ zoneCount: 5, zoneNames: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'] });
    expect(many.problems.join()).toContain('covers 5 domains (a.com, b.com, c.com and 2 more)');
    expect((await j({ zoneCount: 2, zoneNames: ['a.com', 'b.com'] })).problems.join()).toContain('covers 2 domains (a.com, b.com).');
    const wide = await j({ probes: [...(await base()), await probe('R2 storage', 'refused', 200, true)] });
    expect(wide.problems.join()).toContain('(Cloudflare answered 200)');
  });
  it('an unclear answer to a must-be-refused probe is a note, not a failure', async () => {
    const r = await j({ probes: [...(await base()), await probe('R2 storage', 'refused', 404, false, [10042])] });
    expect(r.ok).toBe(true); expect(r.notes.join()).toMatch(/Could not tell.*R2 storage.*404/);
  });
  it('recognises Cloudflare\'s own refusals (401, 403, and the permission codes)', async () => {
    const { refusedAnswer } = await api();
    expect(refusedAnswer({ status: 401, codes: [] })).toBe(true);
    expect(refusedAnswer({ status: 403, codes: [] })).toBe(true);
    for (const c of [10000, 9109, 9103, 10001]) expect(refusedAnswer({ status: 400, codes: [c] }), String(c)).toBe(true);
    expect(refusedAnswer({ status: 404, codes: [7003] })).toBe(false);
    expect(refusedAnswer({ status: 500, codes: [] })).toBe(false);
  });
  it('rejects more than one domain, more than one account, all-zones, and extra permission groups', async () => {
    expect((await j({ zoneCount: 2 })).problems.join()).toMatch(/2 domains/);
    expect((await j({ zoneCount: 1 })).ok).toBe(true);
    expect((await j({ accountCount: 2 })).problems.join()).toMatch(/2 Cloudflare accounts/);
    expect((await j({ wildcardZone: true })).problems.join()).toMatch(/All zones/);
    expect((await j({ extraGroups: ['Workers Scripts Write'] })).problems.join()).toMatch(/Workers Scripts Write/);
    expect((await j({ extraGroups: [] })).ok).toBe(true);
  });
  it('inspectTokenPolicies: allowed groups pass, others and all-zones are found', async () => {
    const { inspectTokenPolicies } = await api();
    expect(inspectTokenPolicies({})).toBeNull();
    expect(inspectTokenPolicies({ policies: 'x' })).toBeNull();
    const narrow = { policies: [{ effect: 'allow', permission_groups: [{ name: 'Cloudflare Tunnel Write' }, { name: 'Access: Apps and Policies Write' }], resources: { 'com.cloudflare.api.account.a1': '*' } }, { effect: 'allow', permission_groups: [{ name: 'DNS Write' }, { name: 'Zone Read' }], resources: { 'com.cloudflare.api.account.zone.z1': '*' } }] };
    expect(inspectTokenPolicies(narrow)).toEqual({ extraGroups: [], wildcardZone: false });
    const broad = { policies: [{ effect: 'allow', permission_groups: [{ name: 'DNS Write' }, { name: 'Workers Scripts Write' }], resources: { 'com.cloudflare.api.account.a1': { 'com.cloudflare.api.account.zone.*': '*' } } }] };
    expect(inspectTokenPolicies(broad)).toEqual({ extraGroups: ['Workers Scripts Write'], wildcardZone: true });
    expect(inspectTokenPolicies({ policies: [{ effect: 'deny', permission_groups: [{ name: 'Workers Scripts Write' }], resources: {} }] })).toEqual({ extraGroups: [], wildcardZone: false });
  });
});

describe('CloudflareApi', () => {
  it('sends the token as a Bearer header to api.cloudflare.com only, and never puts it in an answer', async () => {
    const { CloudflareApi } = await api();
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const a = new CloudflareApi(TOKEN, async (url, init) => { seen.push({ url, headers: init.headers }); return { status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }) }; });
    const r = await a.call('GET', '/zones');
    expect(seen[0].url).toBe('https://api.cloudflare.com/client/v4/zones');
    expect(seen[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(r).toEqual({ status: 403, success: false, result: undefined, codes: [10000], message: 'Authentication error' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    await expect(a.call('GET', 'https://evil.example/x' as never)).rejects.toThrow();
  });
  it('a network error becomes a plain answer without the token or the error text', async () => {
    const { CloudflareApi } = await api();
    const a = new CloudflareApi(TOKEN, async () => { throw new Error(`socket hang up ${TOKEN}`); });
    const r = await a.call('GET', '/zones');
    expect(r.status).toBe(0); expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it('keeps Cloudflare\'s message short', async () => {
    const { CloudflareApi } = await api();
    const a = new CloudflareApi(TOKEN, async () => ({ status: 400, json: async () => ({ success: false, errors: [{ code: 1, message: 'x'.repeat(900) }] }) }));
    expect((await a.call('GET', '/x')).message).toHaveLength(300);
  });
  it('success needs both a 2xx and success:true', async () => {
    const { CloudflareApi } = await api();
    const mk = (status: number, success: boolean) => new CloudflareApi(TOKEN, async () => ({ status, json: async () => ({ success, result: 1 }) }));
    expect((await mk(200, true).call('GET', '/x')).success).toBe(true);
    expect((await mk(200, false).call('GET', '/x')).success).toBe(false);
    expect((await mk(500, true).call('GET', '/x')).success).toBe(false);
  });
});

// ─── Checking the token ──────────────────────────────────────────────────────────────────────────────

describe('checkToken', () => {
  it('passes a narrow token and reports the domains and account', async () => {
    const { checkToken } = await flow(); const w = world();
    const r = await checkToken(await mkApi(w), TOKEN);
    expect(r).toMatchObject({ ok: true, problems: [], accountId: 'a1', zones: [{ id: 'z1', name: 'example.com', accountId: 'a1' }] });
  });
  it('makes no call at all for a Global API Key', async () => {
    const { checkToken } = await flow(); const w = world();
    const r = await checkToken(await mkApi(w, '0123456789abcdef0123456789abcdef01234'), '0123456789abcdef0123456789abcdef01234');
    expect(r.ok).toBe(false); expect(w.calls).toEqual([]);
  });
  it('refuses a token that is not active', async () => {
    const { checkToken } = await flow();
    const r = await checkToken(await mkApi(world({ tokenStatus: 'expired' })), TOKEN);
    expect(r.ok).toBe(false); expect(r.problems[0]).toMatch(/expired/);
  });
  it('refuses a token that is too broad however it shows (probe, two domains, two accounts, policies)', async () => {
    const { checkToken } = await flow();
    const wide = (extra: string) => world({ allowed: new Set([...NARROW, extra]) });
    expect((await checkToken(await mkApi(wide('Workers')), TOKEN)).problems.join()).toMatch(/Workers/);
    expect((await checkToken(await mkApi(wide('Account members')), TOKEN)).problems.join()).toMatch(/members/);
    expect((await checkToken(await mkApi(world({ zones: [{ id: 'z1', name: 'a.com', account: { id: 'a1' } }, { id: 'z2', name: 'b.com', account: { id: 'a1' } }] })), TOKEN)).problems.join()).toMatch(/2 domains/);
    expect((await checkToken(await mkApi(world({ accounts: [{ id: 'a1' }, { id: 'a2' }] })), TOKEN)).problems.join()).toMatch(/2 Cloudflare accounts/);
    const pol = world({ tokenPolicies: [{ effect: 'allow', permission_groups: [{ name: 'DNS Write' }, { name: 'Workers Scripts Write' }], resources: { 'com.cloudflare.api.account.a1': { 'com.cloudflare.api.account.zone.*': '*' } } }] });
    const r = await checkToken(await mkApi(pol), TOKEN);
    expect(r.ok).toBe(false); expect(r.problems.join()).toMatch(/Workers Scripts Write/); expect(r.problems.join()).toMatch(/All zones/);
  });
  it('does not call a token too broad for an answer Cloudflare gave when the token\'s own list holds only the four', async () => {
    const { checkToken } = await flow();
    const narrowPolicies = [{ effect: 'allow', permission_groups: [{ name: 'Cloudflare Tunnel Write' }, { name: 'Access: Apps and Policies Write' }, { name: 'DNS Write' }, { name: 'Zone Read' }], resources: { 'com.cloudflare.api.account.a1': 'x' } }];
    const r = await checkToken(await mkApi(world({ allowed: new Set([...NARROW, 'Workers']), tokenPolicies: narrowPolicies })), TOKEN);
    expect(r.ok).toBe(true); expect(r.problems).toEqual([]);
  });
  it('asks for the permission that is missing', async () => {
    const { checkToken } = await flow();
    const r = await checkToken(await mkApi(world({ allowed: new Set(['Tunnels', 'Access applications', 'Access policies']) })), TOKEN);
    expect(r.ok).toBe(false); expect(r.problems.join()).toMatch(/cannot read the DNS records of any domain/);
    expect(r.zones).toEqual([]); expect(r.details?.join()).toMatch(/can read DNS records for 0/);
  });
  const thirteen = Array.from({ length: 13 }, (_, i) => ({ id: `z${i + 1}`, name: i === 0 ? 'mine.com' : `other${i}.com`, account: { id: 'a1' } }));
  const onlyZ1 = (method: string, p: string) => (method === 'GET' && /\/zones\/z(?!1\/)\d+\/dns_records/.test(p) ? { status: 403, message: 'Authentication error' } : undefined);
  it('counts the domains the token can use, not the domains Cloudflare lists on the account', async () => {
    const { checkToken } = await flow();
    const r = await checkToken(await mkApi(world({ zones: thirteen, failOn: onlyZ1 })), TOKEN);
    expect(r.ok).toBe(true); expect(r.problems).toEqual([]);
    expect(r.zones.map((z) => z.name)).toEqual(['mine.com']);
    expect(r.details?.join()).toMatch(/listed 13 domains.*read DNS records for 1: mine.com/);
  });
  it('still refuses a token that can really use several domains', async () => {
    const { checkToken } = await flow();
    const r = await checkToken(await mkApi(world({ zones: thirteen })), TOKEN);
    expect(r.ok).toBe(false); expect(r.problems.join()).toMatch(/13 domains \(mine.com, other1.com, other2.com and 10 more\)/);
  });
  it('probes the allowed things on a domain the token can use, even when it is not first in the list', async () => {
    const { checkToken } = await flow();
    const zs = [{ id: 'zx', name: 'first.com', account: { id: 'a1' } }, { id: 'z1', name: 'mine.com', account: { id: 'a1' } }];
    const w = world({ zones: zs, failOn: (m, p) => (m === 'GET' && p.startsWith('/zones/zx/') ? { status: 403, message: 'Authentication error' } : undefined) });
    const r = await checkToken(await mkApi(w), TOKEN);
    expect(r.ok).toBe(true); expect(r.zones.map((z) => z.name)).toEqual(['mine.com']);
    expect(w.calls.some((c) => c.path.startsWith('/zones/z1/settings'))).toBe(true);
  });
  it('accepts the four-permission token although the Workers script list answers 200 (empty) for every token', async () => {
    const { checkToken } = await flow();
    const w = world();
    const r = await checkToken(await mkApi(w), TOKEN);
    expect(r.problems).toEqual([]); expect(r.ok).toBe(true);
    expect(w.calls.some((c) => /\/workers\/subdomain$/.test(c.path))).toBe(true);
  });
  it('without a workers.dev subdomain, a non-empty script list still shows the token reaches Workers; an empty one does not', async () => {
    const { checkToken } = await flow();
    const broad = await checkToken(await mkApi(world({ allowed: new Set([...NARROW, 'Workers']), noWorkersSubdomain: true })), TOKEN);
    expect(broad.ok).toBe(false); expect(broad.problems.join()).toMatch(/also reach "Workers"/);
    const narrow = await checkToken(await mkApi(world({ noWorkersSubdomain: true })), TOKEN);
    expect(narrow.problems).toEqual([]);
    const glitch = await checkToken(await mkApi(world({ failOn: (m, p) => (m === 'GET' && /\/workers\/subdomain$/.test(p) ? { status: 500, message: 'Internal error' } : undefined) })), TOKEN);
    expect(glitch.problems).toEqual([]); expect(glitch.notes.join()).toMatch(/Could not tell whether the token reaches "Workers"/);
  });
  it('records a fingerprint and what Cloudflare answered, never the token, and looks at neighbouring Workers endpoints when Workers answers', async () => {
    const { checkToken, tokenFingerprint } = await flow();
    const w = world({ allowed: new Set([...NARROW, 'Workers']) });
    const r = await checkToken(await mkApi(w), TOKEN);
    const text = (r.details ?? []).join('\n');
    expect(text).toContain(tokenFingerprint(TOKEN)); expect(text).not.toContain(TOKEN);
    expect(text).toMatch(/Workers: Cloudflare answered 200.*can reach it/); expect(text).toMatch(/Tunnels: Cloudflare answered 200/);
    expect(text).toMatch(/Extra look, Workers subdomain/); expect(text).toMatch(/Extra look, Workers list: 1 scripts/);
    expect(tokenFingerprint(TOKEN)).toMatch(/^[0-9a-f]{8}$/); expect(tokenFingerprint(TOKEN + ' ')).toBe(tokenFingerprint(TOKEN));
    const clean = await checkToken(await mkApi(world()), TOKEN);
    expect((clean.details ?? []).join()).not.toMatch(/Extra look/);
  });
  it('says so when Cloudflare accepts nothing', async () => {
    const { checkToken } = await flow();
    const w = world({ failOn: (_m, p) => (p.startsWith('/zones?') || p.startsWith('/accounts?') ? { status: 403, message: 'no' } : undefined) });
    const r = await checkToken(await mkApi(w), TOKEN);
    expect(r.ok).toBe(false); expect(r.problems[0]).toMatch(/did not accept this token/);
  });
  it('says so when no domain is visible, and when Cloudflare cannot be reached', async () => {
    const { checkToken } = await flow();
    expect((await checkToken(await mkApi(world({ zones: [] })), TOKEN)).problems[0]).toMatch(/cannot see any domain/);
    const { CloudflareApi } = await api();
    const r = await checkToken(new CloudflareApi(TOKEN, async () => { throw new Error('x'); }), TOKEN);
    expect(r.ok).toBe(false); expect(r.problems[0]).toMatch(/Could not reach Cloudflare/);
  });
  it('only ever reads (GET) while checking', async () => {
    const { checkToken } = await flow(); const w = world();
    await checkToken(await mkApi(w), TOKEN);
    expect(new Set(w.calls.map((c) => c.method))).toEqual(new Set(['GET']));
  });
});

// ─── Switching on ────────────────────────────────────────────────────────────────────────────────────

describe('enableWebgate', () => {
  it('makes everything in a safe order and ends with the address on', async () => {
    const { enableWebgate } = await flow(); const w = world(); const { io, box } = fakeIo();
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r).toEqual({ ok: true, url: 'https://openflow.example.com' });
    const writes = w.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.replace(/\/(accounts|zones)\/\w+/, '')}`);
    expect(writes).toEqual(['POST /access/policies', 'POST /access/apps', 'POST /cfd_tunnel', 'PUT /cfd_tunnel/tun1/configurations', 'POST /dns_records']);
    expect(box.record).toMatchObject({ enabled: true, stage: 'live', hostname: 'openflow.example.com', policyId: 'pol1', appId: 'app1', tunnelId: 'tun1', dnsRecordId: 'dns1', emails: ['me@example.org'], port: 3000 });
    expect(box.tunnelToken).toBe('tunnel-token-tun1');
    expect(box.events).toEqual(['token-written', 'start']);
  });
  it('the public address is created only after the Access rule and application exist', async () => {
    const { enableWebgate } = await flow(); const w = world(); const { io } = fakeIo();
    await enableWebgate(await mkApi(w), params(), io);
    const idx = (re: RegExp, m = 'POST') => w.calls.findIndex((c) => c.method === m && re.test(c.path));
    expect(idx(/access\/policies$/)).toBeLessThan(idx(/access\/apps$/));
    expect(idx(/access\/apps$/)).toBeLessThan(idx(/cfd_tunnel$/));
    expect(idx(/access\/apps$/)).toBeLessThan(idx(/dns_records$/));
    expect(idx(/configurations$/, 'PUT')).toBeLessThan(idx(/dns_records$/));
    const verify = w.calls.findIndex((c) => c.method === 'GET' && /access\/apps\/app1$/.test(c.path));
    expect(verify).toBeGreaterThan(idx(/access\/apps$/)); expect(verify).toBeLessThan(idx(/cfd_tunnel$/));
  });
  it('the policy lets in exactly the listed addresses; the app is self-hosted on that address with that policy', async () => {
    const { enableWebgate } = await flow(); const w = world(); const { io } = fakeIo();
    await enableWebgate(await mkApi(w), params({ emails: ['a@example.org', 'b@example.org'] }), io);
    const pol = w.calls.find((c) => c.method === 'POST' && /access\/policies$/.test(c.path))!.body as Record<string, unknown>;
    expect(pol).toMatchObject({ decision: 'allow', include: [{ email: { email: 'a@example.org' } }, { email: { email: 'b@example.org' } }] });
    expect(JSON.stringify(pol)).not.toMatch(/everyone|email_domain|any_valid/);
    const app = w.calls.find((c) => c.method === 'POST' && /access\/apps$/.test(c.path))!.body as Record<string, unknown>;
    expect(app).toMatchObject({ domain: 'openflow.example.com', type: 'self_hosted', policies: [{ id: 'pol1', precedence: 1 }], app_launcher_visible: false });
  });
  it('routes only that address to this app, everything else to 404, using the app port from PORT', async () => {
    const { enableWebgate } = await flow(); const w = world(); const { io } = fakeIo(); io.env = { PORT: '4100' };
    await enableWebgate(await mkApi(w), params(), io);
    const cfg = w.calls.find((c) => c.method === 'PUT')!.body as { config: { ingress: Record<string, unknown>[] } };
    expect(cfg.config.ingress).toEqual([{ hostname: 'openflow.example.com', service: 'http://127.0.0.1:4100', originRequest: {} }, { service: 'http_status:404' }]);
    expect(JSON.stringify(cfg)).not.toMatch(/922\d|localhost:9|\*\./);
  });
  it('the DNS record is a proxied CNAME to our tunnel', async () => {
    const { enableWebgate } = await flow(); const w = world(); const { io } = fakeIo();
    await enableWebgate(await mkApi(w), params(), io);
    expect(w.calls.find((c) => c.method === 'POST' && /dns_records$/.test(c.path))!.body).toMatchObject({ type: 'CNAME', name: 'openflow.example.com', content: 'tun1.cfargotunnel.com', proxied: true });
  });
  it.each([
    ['no sign-in password', { passwordSet: async () => false }, {}, /sign-in password/, 'password'],
    ['the app listening beyond this computer', {}, { DEVFLOW_BIND_HOST: '0.0.0.0', PORT: '3000' }, /127\.0\.0\.1/, undefined],
    ['a debugging port as the app port', {}, { PORT: '9222' }, /debugging port/, undefined],
  ])('refuses %s and calls Cloudflare not at all', async (_n, ioOver, env, why, fix) => {
    const { enableWebgate } = await flow(); const w = world(); const { io } = fakeIo(ioOver as Partial<Io>);
    if (Object.keys(env).length) io.env = env as Record<string, string>;
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r.ok).toBe(false); expect(r.ok === false && r.error).toMatch(why); expect(r.ok === false && r.fix).toBe(fix);
    expect(w.calls).toEqual([]);
  });
  it('refuses a bad domain, name, emails, and a missing connector program, before any change', async () => {
    const { enableWebgate } = await flow();
    for (const [over, why] of [[{ zoneId: 'nope' }, /Pick one of your domains/], [{ subdomain: 'a.b' }, /letters, numbers/], [{ emails: '*@example.org' }, /not a single email/], [{ emails: '' }, /at least one email/]] as [Record<string, unknown>, RegExp][]) {
      const w = world(); const { io } = fakeIo();
      const r = await enableWebgate(await mkApi(w), params(over), io);
      expect(r.ok === false && r.error).toMatch(why);
      expect(w.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    }
    const w = world(); const { io, box } = fakeIo(); box.installed = null;
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r).toMatchObject({ ok: false, fix: 'cloudflared' }); expect(w.calls).toEqual([]);
  });
  it('refuses a cloudflared older than the minimum Cloudflare supports, before touching the account', async () => {
    const { enableWebgate } = await flow(); const w = world();
    const { io } = fakeIo({ runner: { ...fakeIo().io.runner, installed: async () => ({ path: '/usr/bin/cloudflared', version: 'cloudflared version 2026.9.3 (built 2026-09-01)' }) } });
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r).toMatchObject({ ok: false, fix: 'cloudflared' });
    expect(r.ok === false && r.error).toMatch(/2026\.9\.3.*older than 2026\.10\.2/);
    expect(w.calls).toEqual([]);
  });
  it('compares connector versions part by part', async () => {
    const { cloudflaredTooOld } = await import('@/lib/wizards/cloudflare-api');
    expect(cloudflaredTooOld('cloudflared version 2026.9.3 (built x)')).toBe(true);
    expect(cloudflaredTooOld('cloudflared version 2026.10.1')).toBe(true);
    expect(cloudflaredTooOld('cloudflared version 2025.12.9')).toBe(true);
    expect(cloudflaredTooOld('cloudflared version 2026.10.2')).toBe(false);
    expect(cloudflaredTooOld('cloudflared version 2026.10.10')).toBe(false);
    expect(cloudflaredTooOld('cloudflared version 2026.11.0')).toBe(false);
    expect(cloudflaredTooOld('cloudflared version 2027.1.0')).toBe(false);
    expect(cloudflaredTooOld('cloudflared version DEV')).toBe(false);
    expect(cloudflaredTooOld(null)).toBe(false);
  });
  it('goes ahead when the token may not read the Zero Trust organization (a correctly scoped token cannot)', async () => {
    const { enableWebgate } = await flow(); const w = world({ orgRefused: true }); const { io } = fakeIo();
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r).toMatchObject({ ok: true, url: 'https://openflow.example.com' });
  });
  it('when it cannot look and Zero Trust is really missing, the first create says so and nothing is made', async () => {
    const { enableWebgate } = await flow(); const w = world({ orgRefused: true, org: false }); const { io, box } = fakeIo();
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r).toMatchObject({ ok: false, fix: 'zerotrust' });
    expect(w.policies.size + w.apps.size + w.tunnels.size + w.dns.size).toBe(0); expect(box.record.stage).toBe('none');
  });
  it('asks the user to set up Zero Trust first, and changes nothing', async () => {
    const { enableWebgate } = await flow(); const w = world({ org: false }); const { io } = fakeIo();
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r).toMatchObject({ ok: false, fix: 'zerotrust' }); expect(w.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('refuses a name that already exists in DNS before making anything (no Access app in front of a live site)', async () => {
    const { enableWebgate } = await flow(); const w = world(); w.dns.set('other', { id: 'other', name: 'openflow.example.com', content: 'somewhere.example.net' });
    const { io, box } = fakeIo();
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r.ok === false && r.error).toMatch(/already exists in your DNS/);
    expect(w.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(w.policies.size + w.apps.size + w.tunnels.size).toBe(0);
    expect(w.dns.get('other')!.content).toBe('somewhere.example.net');
    expect(box.record.stage).toBe('none'); expect(box.events).toEqual([]);
  });
  it('stops before the tunnel when the Access application does not come back with our rule and address', async () => {
    const { enableWebgate } = await flow(); const w = world(); const { io } = fakeIo();
    const fetch1 = fakeFetch(w);
    const { CloudflareApi } = await api();
    const lying = new CloudflareApi(TOKEN, async (u, i) => (i.method === 'GET' && /access\/apps\/app1$/.test(u) ? { status: 200, json: async () => ({ success: true, result: { domain: 'openflow.example.com', policies: [] } }) } : fetch1(u, i)));
    const r = await enableWebgate(lying, params(), io);
    expect(r.ok === false && r.error).toMatch(/nothing was published/);
    expect(w.calls.some((c) => /cfd_tunnel$/.test(c.path) && c.method === 'POST')).toBe(false);
    const wrongDomain = new CloudflareApi(TOKEN, async (u, i) => (i.method === 'GET' && /access\/apps\/app1$/.test(u) ? { status: 200, json: async () => ({ success: true, result: { domain: 'elsewhere.example.com', policies: [{ id: 'pol1' }] } }) } : fetch1(u, i)));
    const w2 = world(); const f2 = fakeIo(); const base2 = fakeFetch(w2);
    const r2 = await enableWebgate(new CloudflareApi(TOKEN, async (u, i) => (i.method === 'GET' && /access\/apps\/app1$/.test(u) ? { status: 200, json: async () => ({ success: true, result: { domain: 'elsewhere.example.com', policies: [{ id: 'pol1' }] } }) } : base2(u, i))), params(), f2.io);
    expect(r2.ok).toBe(false); void wrongDomain;
  });
  it('stops at the failing step with Cloudflare\'s message, and a retry continues without making duplicates', async () => {
    const { enableWebgate } = await flow(); const w = world(); const { io, box } = fakeIo();
    let fail = true;
    w.failOn = (m, p) => (fail && m === 'POST' && /cfd_tunnel$/.test(p) ? { status: 500, message: 'tunnel service is down' } : undefined);
    const first = await enableWebgate(await mkApi(w), params(), io);
    expect(first.ok === false && first.error).toMatch(/tunnel service is down/);
    expect(box.record).toMatchObject({ stage: 'app', policyId: 'pol1', appId: 'app1' });
    expect(w.dns.size).toBe(0);
    fail = false;
    const second = await enableWebgate(await mkApi(w), params(), io);
    expect(second.ok).toBe(true);
    expect(w.policies.size).toBe(1); expect(w.apps.size).toBe(1); expect(w.tunnels.size).toBe(1); expect(w.dns.size).toBe(1);
  });
  it('a tunnel answer without a token is a failure and nothing after it is made', async () => {
    const { enableWebgate } = await flow(); const w = world(); const { io } = fakeIo();
    const base = fakeFetch(w); const { CloudflareApi } = await api();
    const a = new CloudflareApi(TOKEN, async (u, i) => (i.method === 'POST' && /cfd_tunnel$/.test(u) ? { status: 200, json: async () => ({ success: true, result: { id: 'tunX' } }) } : base(u, i)));
    const r = await enableWebgate(a, params(), io);
    expect(r.ok === false && r.error).toMatch(/create the tunnel/);
    expect(w.dns.size).toBe(0);
  });
  it('stops when it cannot look at the DNS records', async () => {
    const { enableWebgate } = await flow(); const w = world({ failOn: (m, p) => (m === 'GET' && /dns_records\?name=/.test(p) ? { status: 500, message: 'dns down' } : undefined) }); const { io } = fakeIo();
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r.ok === false && r.error).toMatch(/Could not look at your DNS records.*dns down/);
    expect(w.dns.size).toBe(0);
  });
  it('resumes after the tunnel route failed without a second tunnel, and after a health timeout without a second address', async () => {
    const { enableWebgate } = await flow(); const w = world(); const { io, box } = fakeIo();
    let fail = true;
    w.failOn = (m, p) => (fail && m === 'PUT' && /configurations$/.test(p) ? { status: 500, message: 'x' } : undefined);
    expect((await enableWebgate(await mkApi(w), params(), io)).ok).toBe(false);
    expect(box.record.stage).toBe('tunnel');
    fail = false;
    expect((await enableWebgate(await mkApi(w), params(), io)).ok).toBe(true);
    expect(w.tunnels.size).toBe(1); expect(w.dns.size).toBe(1);

    const w2 = world({ tunnelStatus: 'down' }); const f2 = fakeIo();
    expect((await enableWebgate(await mkApi(w2), params(), f2.io)).ok).toBe(false);
    expect(f2.box.record.stage).toBe('dns');
    w2.tunnels.get('tun1')!.status = 'healthy';
    expect((await enableWebgate(await mkApi(w2), params(), f2.io)).ok).toBe(true);
    expect(w2.dns.size).toBe(1); expect(w2.tunnels.size).toBe(1); expect(w2.apps.size).toBe(1);
  });
  it.each([
    ['policy', /access\/policies$/, 'POST', /sign-in rule/], ['application', /access\/apps$/, 'POST', /Access application/], ['route', /configurations$/, 'PUT', /tunnel route/], ['address', /dns_records$/, 'POST', /create the address/],
  ])('reports a failure creating the %s', async (_n, re, method, why) => {
    const { enableWebgate } = await flow(); const w = world({ failOn: (m, p) => (m === method && re.test(p) ? { status: 400, message: 'nope' } : undefined) }); const { io } = fakeIo();
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r.ok === false && r.error).toMatch(why); expect(r.ok === false && r.error).toMatch(/nope/);
  });
  it('refuses to start over a different address; same address resumes', async () => {
    const { enableWebgate } = await flow(); const w = world(); const { io, box } = fakeIo();
    box.record = { enabled: true, stage: 'app', hostname: 'old.example.com', zoneId: 'z1', policyId: 'pol1', appId: 'app1' };
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r.ok === false && r.error).toMatch(/already made old\.example\.com/);
    expect(w.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('says so when the connector does not start or the tunnel never becomes healthy', async () => {
    const { enableWebgate } = await flow();
    const a = fakeIo(); a.box.startError = 'boom';
    expect((await enableWebgate(await mkApi(world()), params(), a.io)).ok === false).toBe(true);
    const w = world({ tunnelStatus: 'down' }); const b = fakeIo(); let slept = 0; b.io.sleep = async () => { slept++; };
    const r = await enableWebgate(await mkApi(w), params(), b.io);
    expect(r.ok === false && r.error).toMatch(/did not become healthy/); expect(slept).toBe(30);
    expect(b.box.record.stage).toBe('dns');
  });
  it('takes everything down at once if the public address shows the page without Cloudflare sign-in', async () => {
    const { enableWebgate } = await flow(); const w = world(); const { io, box } = fakeIo();
    box.public = [{ status: 200, location: null }];
    const r = await enableWebgate(await mkApi(w), params(), io);
    expect(r.ok === false && r.error).toMatch(/Everything was taken down again/);
    expect(w.dns.size + w.apps.size + w.tunnels.size + w.policies.size).toBe(0);
    expect(box.record).toMatchObject({ enabled: false, stage: 'none' });
    expect(box.running).toBe(false);
  });
});

// ─── Proof ───────────────────────────────────────────────────────────────────────────────────────────

describe('proveWebgate and isAccessLogin', () => {
  it('isAccessLogin accepts only a redirect to a cloudflareaccess.com Access login over https', async () => {
    const { isAccessLogin } = await flow();
    const ok = (status: number, location: string | null) => isAccessLogin({ status, location });
    expect(ok(302, 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x.example.com?kid=1')).toBe(true);
    expect(ok(307, 'https://Team.CloudflareAccess.com/cdn-cgi/access/login/x')).toBe(true);
    for (const [s, l] of [[200, 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x'], [302, null], [302, 'https://evil.example/cdn-cgi/access/login'], [302, 'https://team.cloudflareaccess.com.evil.example/cdn-cgi/access/x'],
      [302, 'http://team.cloudflareaccess.com/cdn-cgi/access/login'], [302, 'https://team.cloudflareaccess.com/other'], [302, 'not a url'], [404, null], [500, 'https://team.cloudflareaccess.com/cdn-cgi/access/login']] as [number, string | null][]) expect(ok(s, l), `${s} ${l}`).toBe(false);
  });
  const LOGIN = { status: 302, location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/h?kid=1' };
  it('passes when the page and the API both go to Access, asking the real public address', async () => {
    const { proveWebgate } = await flow(); const asked: string[] = [];
    const r = await proveWebgate('openflow.example.com', { fetchPublic: async (u) => { asked.push(u); return LOGIN; }, sleep: async () => undefined });
    expect(r).toMatchObject({ ok: true, exposed: false }); expect(asked).toEqual(['https://openflow.example.com/', 'https://openflow.example.com/api/connectors']);
  });
  it('is exposed (and stops) the moment either path answers with content', async () => {
    const { proveWebgate } = await flow();
    const page = await proveWebgate('h.example.com', { fetchPublic: async () => ({ status: 200, location: null }), sleep: async () => undefined });
    expect(page).toMatchObject({ ok: false, exposed: true }); expect(page.steps).toHaveLength(1);
    let n = 0;
    const api2 = await proveWebgate('h.example.com', { fetchPublic: async () => (++n === 1 ? LOGIN : { status: 204, location: null }), sleep: async () => undefined });
    expect(api2).toMatchObject({ ok: false, exposed: true });
  });
  it('an error page or a missing page is "not ready", not "exposed"', async () => {
    const { proveWebgate } = await flow();
    for (const status of [301, 404, 500, 502, 530]) {
      const r = await proveWebgate('h.example.com', { fetchPublic: async () => ({ status, location: null }), sleep: async () => undefined }, 2);
      expect(r, String(status)).toMatchObject({ ok: false, exposed: false });
    }
  });
  it('waits for a new address to appear, then passes; gives up with "not ready" (not exposed) if it never does', async () => {
    const { proveWebgate } = await flow(); let n = 0; let slept = 0;
    const slow = await proveWebgate('h.example.com', { fetchPublic: async () => (++n < 4 ? { status: 530, location: null } : LOGIN), sleep: async () => { slept++; } });
    expect(slow.ok).toBe(true); expect(slept).toBe(3);
    const never = await proveWebgate('h.example.com', { fetchPublic: async () => { throw new Error('ENOTFOUND'); }, sleep: async () => undefined }, 3);
    expect(never).toMatchObject({ ok: false, exposed: false }); expect(never.steps[0].detail).toMatch(/Not ready yet.*ENOTFOUND/);
  });
});

// ─── Switching off ───────────────────────────────────────────────────────────────────────────────────

async function liveWorld() {
  const { enableWebgate } = await flow(); const w = world(); const f = fakeIo();
  const a = await mkApi(w);
  await enableWebgate(a, params(), f.io);
  w.calls.length = 0; f.box.events.length = 0;
  return { w, ...f, a };
}

describe('disableWebgate', () => {
  it('removes the address first, then the connector and tunnel, then Access, and clears the record', async () => {
    const { disableWebgate } = await flow(); const { w, io, box, a } = await liveWorld();
    const r = await disableWebgate(a, io);
    expect(r).toMatchObject({ ok: true });
    const dels = w.calls.filter((c) => c.method === 'DELETE').map((c) => c.path.replace(/\/(accounts|zones)\/\w+/, ''));
    expect(dels).toEqual(['/dns_records/dns1', '/cfd_tunnel/tun1/connections', '/cfd_tunnel/tun1', '/access/apps/app1', '/access/policies/pol1']);
    expect(box.events).toEqual(['stop', 'token-removed']);
    expect(w.dns.size + w.apps.size + w.tunnels.size + w.policies.size).toBe(0);
    expect(box.record).toEqual({ enabled: false, stage: 'none', known: undefined });
  });
  it('keeps the domain list it learned', async () => {
    const { disableWebgate } = await flow(); const { io, box, a } = await liveWorld();
    box.record = { ...box.record, known };
    await disableWebgate(a, io);
    expect(box.record).toMatchObject({ enabled: false, stage: 'none', known });
  });
  it('leaves a DNS record alone that no longer points at our tunnel, and says so', async () => {
    const { disableWebgate } = await flow(); const { w, io, a } = await liveWorld();
    w.dns.get('dns1')!.content = 'someone-else.example.net';
    const r = await disableWebgate(a, io);
    expect(w.dns.has('dns1')).toBe(true);
    expect(r.ok && r.note).toMatch(/no longer points at our tunnel/);
    expect(w.apps.size).toBe(0);
  });
  it('stops at the first thing it cannot remove and keeps the Access rule in place', async () => {
    const { disableWebgate } = await flow(); const { w, io, box, a } = await liveWorld();
    w.failOn = (m, p) => (m === 'DELETE' && /dns_records/.test(p) ? { status: 500, message: 'busy' } : undefined);
    const r = await disableWebgate(a, io);
    expect(r.ok === false && r.error).toMatch(/Could not remove the address/);
    expect(w.apps.size).toBe(1); expect(w.tunnels.size).toBe(1); expect(box.events).toEqual([]);
    const w2 = await liveWorld();
    w2.w.failOn = (m, p) => (m === 'DELETE' && /cfd_tunnel\/tun1$/.test(p) ? { status: 500, message: 'busy' } : undefined);
    const r2 = await disableWebgate(w2.a, w2.io);
    expect(r2.ok === false && r2.error).toMatch(/Could not remove the tunnel.*Access rule was kept/);
    expect(w2.w.apps.size).toBe(1); expect(w2.w.dns.size).toBe(0);
  });
  it('stops when the Access application cannot be removed, and keeps the policy it uses', async () => {
    const { disableWebgate } = await flow(); const { w, io, a } = await liveWorld();
    w.failOn = (m, p) => (m === 'DELETE' && /access\/apps/.test(p) ? { status: 500, message: 'busy' } : undefined);
    const r = await disableWebgate(a, io);
    expect(r.ok === false && r.error).toMatch(/Could not remove the Access application.*busy/);
    expect(w.policies.size).toBe(1); expect(w.dns.size).toBe(0);
  });
  it('treats things already gone as removed, and is safe to run twice', async () => {
    const { disableWebgate } = await flow(); const { w, io, a } = await liveWorld();
    w.apps.clear(); w.tunnels.clear();
    expect((await disableWebgate(a, io)).ok).toBe(true);
    const again = await disableWebgate(a, io);
    expect(again).toEqual({ ok: true, note: 'Nothing was switched on here.' });
  });
  it('a failed policy removal is only a note', async () => {
    const { disableWebgate } = await flow(); const { w, io, a } = await liveWorld();
    w.failOn = (m, p) => (m === 'DELETE' && /access\/policies/.test(p) ? { status: 500, message: 'x' } : undefined);
    const r = await disableWebgate(a, io);
    expect(r.ok && r.note).toMatch(/sign-in rule could not be removed/);
  });
  it('does nothing when nothing was made', async () => {
    const { disableWebgate } = await flow(); const w = world(); const { io } = fakeIo();
    expect(await disableWebgate(await mkApi(w), io)).toEqual({ ok: true, note: 'Nothing was switched on here.' });
    expect(w.calls).toEqual([]);
  });
});

// ─── Token on disk, state, connector ─────────────────────────────────────────────────────────────────

describe('the saved token and the page state', () => {
  it('saveToken keeps a passing token in a 0600 file and remembers the domain list; a failing one is not kept', async () => {
    const svc = await import('@/lib/wizards/cloudflare-service'); const { io, box } = fakeIo();
    const good = await svc.saveToken(TOKEN, io, await mkApi(world()));
    expect(good.ok).toBe(true);
    const file = path.join(dir, 'cloudflare-api-token');
    expect(await fs.readFile(file, 'utf8')).toBe(TOKEN);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(box.record.known).toEqual({ accountId: 'a1', zones: [{ id: 'z1', name: 'example.com', accountId: 'a1' }] });
    await fs.rm(file);
    const bad = await svc.saveToken(TOKEN, io, await mkApi(world({ allowed: new Set([...NARROW, 'R2 storage']) })));
    expect(bad.ok).toBe(false);
    await expect(fs.stat(file)).rejects.toThrow();
  });
  it('writeApiToken stores the trimmed token and tightens a file that was wider', async () => {
    const svc = await import('@/lib/wizards/cloudflare-service');
    const file = path.join(dir, 'cloudflare-api-token');
    await fs.writeFile(file, 'old', { mode: 0o644 });
    await svc.writeApiToken(`  ${TOKEN}\n`);
    expect(await fs.readFile(file, 'utf8')).toBe(TOKEN);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
  it('forgetToken only when nothing is switched on', async () => {
    const svc = await import('@/lib/wizards/cloudflare-service'); const { io, box } = fakeIo();
    await svc.writeApiToken(TOKEN);
    box.record = { enabled: true, stage: 'live', hostname: 'h.example.com' };
    expect((await svc.forgetToken(io)).ok).toBe(false);
    expect(await svc.readApiToken()).toBe(TOKEN);
    box.record = { enabled: false, stage: 'none' };
    expect((await svc.forgetToken(io)).ok).toBe(true);
    expect(await svc.readApiToken()).toBeNull();
  });
  it('the page state says whether a token exists but never contains it', async () => {
    const svc = await import('@/lib/wizards/cloudflare-service'); const { io, box } = fakeIo();
    await fs.writeFile(path.join(dir, 'dashboard-auth.json'), JSON.stringify({ password: { hash: 'scrypt$1$1$1$aa$bb' } }));
    expect(await svc.wizardState(io, io.runner)).toMatchObject({ passwordSet: true, tokenSaved: false, url: null, connector: { installed: true, running: false, tooOld: false, minimum: '2026.10.2' } });
    await svc.writeApiToken(TOKEN);
    box.record = { enabled: true, stage: 'live', hostname: 'h.example.com' };
    const s = await svc.wizardState(io, io.runner);
    expect(s).toMatchObject({ tokenSaved: true, url: 'https://h.example.com' });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    box.record = { enabled: true, stage: 'dns', hostname: 'h.example.com' };
    expect((await svc.wizardState(io, io.runner)).url).toBeNull();
  });
  it('ensureConnectorAtStartup starts the connector only while the address is on', async () => {
    const svc = await import('@/lib/wizards/cloudflare-service'); const { io, box } = fakeIo();
    for (const rec of [{ enabled: false, stage: 'none' }, { enabled: true, stage: 'dns' }, { enabled: false, stage: 'live' }] as CfRecord[]) { box.record = rec; await svc.ensureConnectorAtStartup(io); }
    expect(box.events).toEqual([]);
    box.record = { enabled: true, stage: 'live' }; await svc.ensureConnectorAtStartup(io);
    expect(box.events).toEqual(['start']);
  });
  it('findCloudflared picks the first candidate that exists', async () => {
    const { findCloudflared } = await import('@/lib/wizards/cloudflared-runner');
    expect(findCloudflared((p) => p === '/b/cloudflared', ['/a/cloudflared', '/b/cloudflared', '/c/cloudflared'])).toBe('/b/cloudflared');
    expect(findCloudflared(() => false, ['/a/cloudflared'])).toBeNull();
  });
});

describe('/api/wizards/cloudflare', () => {
  it('refuses a caller that is not on this machine and has no token, before doing anything', async () => {
    vi.resetModules();
    const route = await import('@/app/api/wizards/cloudflare/route');
    const { NextRequest } = await import('next/server');
    const outside = { host: '127.0.0.1:3000', 'x-forwarded-for': '203.0.113.7' };
    expect((await route.GET(new NextRequest('http://127.0.0.1:3000/api/wizards/cloudflare', { headers: outside }))).status).toBe(401);
    for (const action of ['save-token', 'enable', 'prove', 'disable', 'forget-token']) {
      const res = await route.POST(new NextRequest('http://127.0.0.1:3000/api/wizards/cloudflare', { method: 'POST', headers: outside, body: JSON.stringify({ action, token: TOKEN }) }));
      expect(res.status, action).toBe(401);
    }
    await expect(fs.stat(path.join(dir, 'cloudflare-api-token'))).rejects.toThrow();
  });
  it('without a saved token the actions that need one say so; an unknown action is a 400; save-token with junk is refused and nothing is kept', async () => {
    vi.resetModules();
    const route = await import('@/app/api/wizards/cloudflare/route');
    const { NextRequest } = await import('next/server');
    const post = (body: unknown) => route.POST(new NextRequest('http://127.0.0.1:3000/api/wizards/cloudflare', { method: 'POST', headers: { host: '127.0.0.1:3000' }, body: JSON.stringify(body) }));
    for (const action of ['enable', 'prove', 'disable']) expect((await post({ action })).status, action).toBe(409);
    expect((await post({ action: 'bogus' })).status).toBe(409);       // no token yet: that is checked first
    const junk = await post({ action: 'save-token', token: 'not a token' });
    expect(junk.status).toBe(422);
    const body = await junk.json();
    expect(body.problems[0]).toMatch(/does not look like/);
    expect(JSON.stringify(body)).not.toContain('not a token');
    await expect(fs.stat(path.join(dir, 'cloudflare-api-token'))).rejects.toThrow();
    const bad = new NextRequest('http://127.0.0.1:3000/api/wizards/cloudflare', { method: 'POST', headers: { host: '127.0.0.1:3000' }, body: 'nope' });
    expect((await route.POST(bad)).status).toBe(400);
  });
});

describe('/api/wizards/cloudflare with the Cloudflare layer mocked', () => {
  const setup = async (record: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    vi.resetModules();
    await fs.writeFile(path.join(dir, 'cloudflare-api-token'), TOKEN);
    await fs.writeFile(path.join(dir, 'cloudflare-access.json'), JSON.stringify(record));
    const spies = { prove: vi.fn(async () => ({ ok: false, exposed: false, steps: [] })), disable: vi.fn(async () => ({ ok: true as const, note: 'gone' })), enable: vi.fn(async () => ({ ok: true as const, url: 'https://h.example.com' })) };
    vi.doMock('@/lib/wizards/cloudflare', async (orig) => ({ ...(await orig<typeof import('@/lib/wizards/cloudflare')>()), proveWebgate: spies.prove, disableWebgate: spies.disable, enableWebgate: spies.enable, ...over }));
    const route = await import('@/app/api/wizards/cloudflare/route');
    const { NextRequest } = await import('next/server');
    const post = (body: unknown) => route.POST(new NextRequest('http://127.0.0.1:3000/api/wizards/cloudflare', { method: 'POST', headers: { host: '127.0.0.1:3000' }, body: JSON.stringify(body) }));
    return { post, spies };
  };
  afterEach(() => { vi.doUnmock('@/lib/wizards/cloudflare'); });

  it('prove needs the address to be live; when the proof says exposed it takes everything down', async () => {
    const off = await setup({ enabled: true, stage: 'dns', hostname: 'h.example.com' });
    expect((await off.post({ action: 'prove' })).status).toBe(409);
    expect(off.spies.prove).not.toHaveBeenCalled();
    const live = await setup({ enabled: true, stage: 'live', hostname: 'h.example.com' });
    expect((await live.post({ action: 'prove' })).status).toBe(200);
    expect(live.spies.disable).not.toHaveBeenCalled();
    const open = await setup({ enabled: true, stage: 'live', hostname: 'h.example.com' }, { proveWebgate: vi.fn(async () => ({ ok: false, exposed: true, steps: [] })) });
    const res = await open.post({ action: 'prove' });
    expect((await res.json()).takenDown).toBe(true);
    expect(open.spies.disable).toHaveBeenCalledTimes(1);
  });
  it('enable needs a checked token first and passes the remembered domains, never anything from the page for the account', async () => {
    const none = await setup({ enabled: false, stage: 'none' });
    expect((await none.post({ action: 'enable', zoneId: 'z1', subdomain: 'x', emails: 'a@example.org', accountId: 'evil' })).status).toBe(409);
    expect(none.spies.enable).not.toHaveBeenCalled();
    const ok = await setup({ enabled: false, stage: 'none', known });
    expect((await ok.post({ action: 'enable', zoneId: 'z1', subdomain: 'x', emails: 'a@example.org', accountId: 'evil' })).status).toBe(200);
    expect(ok.spies.enable.mock.calls[0][1]).toMatchObject({ zoneId: 'z1', accountId: 'a1', zones: known.zones });
  });
  it('the state in every answer never contains the token', async () => {
    const ok = await setup({ enabled: false, stage: 'none', known });
    const res = await ok.post({ action: 'disable' });
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
  });
});

describe('the connector runner', () => {
  it('start gives cloudflared the token by file, records its pid, is idempotent, and stop ends it', async () => {
    const bin = path.join(dir, 'bin'); await fs.mkdir(bin);
    const argsFile = path.join(dir, 'args.txt');
    await fs.writeFile(path.join(bin, 'cloudflared'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cloudflared version 9.9"; exit 0; fi\necho "$@" > ${argsFile}\ntrap 'kill $c 2>/dev/null; exit 0' TERM\nsleep 30 & c=$!\nwait $c\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    await fs.writeFile(path.join(dir, 'cloudflared-tunnel-token'), 'TUNNEL-SECRET');
    vi.resetModules();
    const { realRunner } = await import('@/lib/wizards/cloudflared-runner');
    expect(await realRunner.installed()).toEqual({ path: path.join(bin, 'cloudflared'), version: 'cloudflared version 9.9' });
    expect(await realRunner.running()).toBe(false);
    expect(await realRunner.start()).toEqual({ ok: true });
    // Wait for the fake to write its arguments, not only to create the file: `echo > file` creates it empty first, and under a
    // loaded full run the read could land in between and see ''.
    for (let i = 0; i < 100 && !(await fs.readFile(argsFile, 'utf8').catch(() => '')).trim(); i++) await new Promise((r) => setTimeout(r, 50));
    const args = (await fs.readFile(argsFile, 'utf8')).trim();
    expect(args).toBe(`tunnel --no-autoupdate run --token-file ${path.join(dir, 'cloudflared-tunnel-token')}`);
    expect(args).not.toContain('TUNNEL-SECRET');
    expect(await realRunner.running()).toBe(true);
    const pid1 = await fs.readFile(path.join(dir, 'cloudflared.pid'), 'utf8');
    expect(await realRunner.start()).toEqual({ ok: true });
    expect(await fs.readFile(path.join(dir, 'cloudflared.pid'), 'utf8')).toBe(pid1);
    expect((await fs.stat(path.join(dir, 'cloudflared.pid'))).mode & 0o777).toBe(0o600);
    await realRunner.stop();
    expect(await realRunner.running()).toBe(false);
    await expect(fs.stat(path.join(dir, 'cloudflared.pid'))).rejects.toThrow();
  });
  it('a recycled process id is not taken for the connector; start refuses without a program or a token', async () => {
    vi.resetModules();
    await fs.writeFile(path.join(dir, 'cloudflared.pid'), String(process.pid));         // alive, but it is the test runner
    const { realRunner } = await import('@/lib/wizards/cloudflared-runner');
    expect(await realRunner.running()).toBe(false);
    vi.stubEnv('PATH', '/nonexistent');
    const r = await realRunner.start();
    expect(r.ok).toBe(false);
  });
});
