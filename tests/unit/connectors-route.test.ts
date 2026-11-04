import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The whole route on real parts: a fake `claude` and `codex` on PATH that behave like the real ones (they record their
// arguments and add the server to the user's list), a temp home, and a temp .UserData. Only the provider call is faked.
let work: string;
let userData: string;
let logFile: string;
const providerCalls: { id: string; key: string }[] = [];

const authLevels: string[] = [];
vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: async (_r: unknown, level: string) => { authLevels.push(level); return null; } }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_r: string, h: unknown) => h }));
vi.mock('@/lib/data-paths', () => ({ get DataPaths() { return { userData }; } }));
vi.mock('@/lib/connectors/test-key', () => ({
  testKey: async (id: string, key: string) => { providerCalls.push({ id, key }); return { ok: key === 'good-key', message: key === 'good-key' ? 'Accepted.' : 'Refused.' }; },
}));

const SECRET = 'sk-or-ROUTE-TEST-SECRET-0123456789';  // gitleaks:allow
const post = (body: unknown) => new NextRequest('http://localhost:3000/api/connectors', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = () => new NextRequest('http://localhost:3000/api/connectors');
let route: typeof import('@/app/api/connectors/route');
let oldPath: string | undefined;
let oldHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'conn-route-'));
  userData = join(work, 'userdata');
  logFile = join(work, 'calls.log');
  const bin = join(work, 'bin');
  mkdirSync(bin);
  mkdirSync(join(work, 'home', 'projects'), { recursive: true });
  const fake = (name: string, listing: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\nprintf '%s\\n' "${name} $*" >> '${logFile}'\n${listing}\nexit 0\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // claude: `mcp add-json --scope user NAME JSON` records NAME in ~/.claude.json
  fake('claude', `if [ "$2" = add-json ]; then python3 - "$5" <<'PY'\nimport json,os,sys\np=os.path.expanduser('~/.claude.json')\nd=json.load(open(p)) if os.path.exists(p) else {}\nd.setdefault('mcpServers',{})[sys.argv[1]]={}\njson.dump(d,open(p,'w'))\nPY\nfi`);
  fake('codex', ':');
  oldPath = process.env.PATH; oldHome = process.env.HOME;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.HOME = join(work, 'home');
  // Keys go to the secret store (a temp file here). DEVFLOW_AGENT_HOST makes the save skip the real tmux server.
  for (const k of ['DEVFLOW_SECRETS_FILE', 'DEVFLOW_AGENT_HOST', 'OPENROUTER_API_KEY']) savedEnv[k] = process.env[k];
  process.env.DEVFLOW_SECRETS_FILE = join(work, 'secrets.json');
  process.env.DEVFLOW_AGENT_HOST = 'test-host';
  delete process.env.OPENROUTER_API_KEY;
  route = await import('@/app/api/connectors/route');
});
afterAll(() => { process.env.PATH = oldPath; process.env.HOME = oldHome; for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } rmSync(work, { recursive: true, force: true }); });

const status = async (id: string) => {
  const j = await (await route.GET(get())).json();
  return (j.statuses as { id: string; state: string; keyFrom?: string }[]).find((s) => s.id === id)!;
};

describe('/api/connectors', () => {
  it('lists the catalog with states, and no secret values', async () => {
    const res = await route.GET(get());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.catalog.connectors.length).toBeGreaterThan(15);
    expect(j.statuses).toHaveLength(j.catalog.connectors.length);
    expect(j.savedKeys).toEqual([]);
    expect((await status('openrouter')).state).toBe('not-set-up');
  });

  it('saves a key owner-only, shows it as saved, and never repeats it', async () => {
    const res = await route.POST(post({ action: 'save-key', id: 'openrouter', value: SECRET }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(statSync(join(work, 'secrets.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(userData, 'connectors.env'))).toBe(false);
    expect(await status('openrouter')).toMatchObject({ state: 'ready', keyFrom: 'saved' });
    expect(JSON.stringify(await (await route.GET(get())).json())).not.toContain(SECRET);
  });

  it('refuses a key name that is not this connector\'s, an empty key and a multi-line key', async () => {
    for (const body of [
      { action: 'save-key', id: 'openrouter', env: 'PATH', value: 'x' },
      { action: 'save-key', id: 'openrouter', value: '   ' },
      { action: 'save-key', id: 'openrouter', value: 'a\nb' },
      { action: 'save-key', id: 'mcp-memory', value: 'x' },
    ]) {
      const res = await route.POST(post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.text()).not.toContain('a\\nb');
    }
  });

  it('refuses a key that belongs to another connector even though the catalog knows the name', async () => {
    const res = await route.POST(post({ action: 'save-key', id: 'openrouter', env: 'XAI_API_KEY', value: 'x' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not belong/);
    expect((await status('xai')).state).toBe('not-set-up');
  });

  it('asks for read access to list, write to check, and admin to change anything', async () => {
    authLevels.length = 0;
    await route.GET(get());
    await route.POST(post({ action: 'check', id: 'github' }));
    await route.POST(post({ action: 'test-key', id: 'fal', value: 'x' }));
    await route.POST(post({ action: 'save-key', id: 'fal', value: 'x' }));
    await route.POST(post({ action: 'remove-key', id: 'fal' }));
    await route.POST(post({ action: 'add-mcp', id: 'mcp-memory' }));
    await route.POST(post({ action: 'remove-mcp', id: 'mcp-memory' }));
    expect(authLevels).toEqual(['read', 'write', 'write', 'admin', 'admin', 'admin', 'admin']);
  });

  it('checks a pasted key with the provider, falls back to the saved one, and says plainly when there is none', async () => {
    const good = await (await route.POST(post({ action: 'test-key', id: 'openrouter', value: 'good-key' }))).json();
    expect(good).toMatchObject({ success: true, ok: true });
    const bad = await (await route.POST(post({ action: 'test-key', id: 'openrouter', value: 'wrong' }))).json();
    expect(bad).toMatchObject({ success: true, ok: false });
    await route.POST(post({ action: 'test-key', id: 'openrouter' }));
    expect(providerCalls.map((c) => c.id)).toEqual(['openrouter', 'openrouter', 'openrouter']);
    expect(providerCalls[2].key).toBe(SECRET);
    const none = await route.POST(post({ action: 'test-key', id: 'xai' }));
    expect(none.status).toBe(400);
  });

  it('says a connector without a provider check is simply saved', async () => {
    const j = await (await route.POST(post({ action: 'test-key', id: 'fal', value: 'anything' }))).json();
    expect(j).toMatchObject({ success: true, ok: true });
    expect(providerCalls).toHaveLength(3);
  });

  it('adds an MCP server through the real programs and then lists it as ready', async () => {
    expect((await status('mcp-filesystem')).state).toBe('not-set-up');
    const res = await route.POST(post({ action: 'add-mcp', id: 'mcp-filesystem', inputs: { folder: '~/projects' } }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.success).toBe(true);
    expect(j.results.map((r: { target: string; outcome: string }) => `${r.target}:${r.outcome}`)).toEqual(['claude:added', 'codex:added']);
    const log = readFileSync(logFile, 'utf-8');
    expect(log).toContain('claude mcp add-json --scope user filesystem');
    expect(log).toContain(`codex mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ${join(work, 'home', 'projects')}`);
    expect((await status('mcp-filesystem')).state).toBe('ready');
  });

  it('refuses a bad folder before running anything', async () => {
    const before = readFileSync(logFile, 'utf-8');
    const res = await route.POST(post({ action: 'add-mcp', id: 'mcp-filesystem', inputs: { folder: '/definitely/not/here' } }));
    expect(res.status).toBe(400);
    expect(readFileSync(logFile, 'utf-8')).toBe(before);
  });

  it('will not add a server that needs a key before the key is saved', async () => {
    const res = await route.POST(post({ action: 'add-mcp', id: 'mcp-supabase' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Save the Supabase access token first/);
  });

  it('removes a saved key', async () => {
    const j = await (await route.POST(post({ action: 'remove-key', id: 'openrouter' }))).json();
    expect(j).toMatchObject({ success: true, removed: true });
    expect((await status('openrouter')).state).toBe('not-set-up');
  });

  it('rejects unknown connectors, unknown actions and unreadable bodies', async () => {
    expect((await route.POST(post({ action: 'save-key', id: 'nope', value: 'x' }))).status).toBe(404);
    expect((await route.POST(post({ action: 'explode', id: 'openrouter' }))).status).toBe(400);
    expect((await route.POST(post('{not json'))).status).toBe(400);
    expect(existsSync(join(work, 'secrets.json'))).toBe(true);
  });
});
