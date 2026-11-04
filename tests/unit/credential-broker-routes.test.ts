import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

// The broker routes on real parts: a real encrypted store file and real approvals and audit files in a temp folder. Only the sign-in
// check and the provider call are faked.
const KEY = 'sk-ds-ROUTE-TEST-0123456789abcdef';  // gitleaks:allow (a made-up test value)
let owner = false;
let tokenName: string | null = 'Jack';
const providerCalls: string[] = [];

vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: async () => null,
  validateApiToken: async () => (tokenName ? { valid: true, token: { name: tokenName } } : { valid: false }),
}));
vi.mock('@/lib/dashboard-auth', () => ({ requestHasSession: async () => owner }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_r: string, h: unknown) => h }));
vi.mock('@/lib/connectors/test-key', () => ({
  testKey: async (_id: string, key: string) => { providerCalls.push(key); return { ok: true, message: `Accepted. (the provider echoed ${key})` }; },
}));

let work: string;
const saved: Record<string, string | undefined> = {};
let approvals: typeof import('@/app/api/broker/approvals/route');
let run: typeof import('@/app/api/broker/run/route');
let audit: typeof import('@/app/api/broker/audit/route');

const post = (url: string, body: unknown) => new NextRequest(`http://localhost:3000${url}`, { method: 'POST', body: JSON.stringify(body) });
const ARGS = { connectorId: 'deepseek' };

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'broker-routes-'));
  mkdirSync(join(work, 'app'));
  for (const k of ['DEVFLOW_APP_DATA_DIR', 'DEVFLOW_SECRETS_FILE', 'DEVFLOW_SECRETS_KEY_FILE']) saved[k] = process.env[k];
  process.env.DEVFLOW_APP_DATA_DIR = relative(process.cwd(), join(work, 'app'));
  process.env.DEVFLOW_SECRETS_FILE = join(work, 'app', 'secrets.json');
  process.env.DEVFLOW_SECRETS_KEY_FILE = join(work, 'keys', 'secrets.key');
  vi.resetModules();
  const { FileSecretStore } = await import('@/lib/secret-store');
  new FileSecretStore(join(work, 'app', 'secrets.json')).set('DEEPSEEK_API_KEY', KEY);
  approvals = await import('@/app/api/broker/approvals/route');
  run = await import('@/app/api/broker/run/route');
  audit = await import('@/app/api/broker/audit/route');
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(work, { recursive: true, force: true });
});
beforeEach(() => { owner = false; tokenName = 'Jack'; providerCalls.length = 0; });

describe('broker routes', () => {
  it('an agent cannot approve itself: only the signed-in owner can create an approval', async () => {
    const res = await approvals.POST(post('/api/broker/approvals', { action: 'test-key', args: ARGS }));
    expect(res.status).toBe(403);
  });
  it('the whole journey: owner approves, the agent runs once with the approval, a second run is refused, and the key never appears', async () => {
    owner = true;
    const made = await (await approvals.POST(post('/api/broker/approvals', { action: 'test-key', args: ARGS }))).json();
    expect(made.success).toBe(true);
    owner = false;
    const first = await run.POST(post('/api/broker/run', { action: 'test-key', args: ARGS, approvalId: made.approvalId }));
    const text = await first.text();
    expect(first.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ success: true, status: 'ok' });
    expect(text).not.toContain(KEY);
    expect(providerCalls).toEqual([KEY]);          // the provider got the real key
    const second = await run.POST(post('/api/broker/run', { action: 'test-key', args: ARGS, approvalId: made.approvalId }));
    expect(second.status).toBe(403);
    expect((await second.json()).status).toBe('needs-approval');
    expect(providerCalls).toHaveLength(1);
  });
  it('an agent with no approval is refused, and the caller cannot name itself in the body', async () => {
    const res = await run.POST(post('/api/broker/run', { action: 'test-key', args: ARGS, actor: 'owner', by: 'owner' }));
    expect(res.status).toBe(403);
    expect(providerCalls).toEqual([]);
  });
  it('the signed-in owner can run it without an approval', async () => {
    owner = true;
    const res = await run.POST(post('/api/broker/run', { action: 'test-key', args: ARGS }));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(KEY);
  });
  it('refuses a free command, an unknown connector and a key name the action may not use', async () => {
    owner = true;
    expect((await run.POST(post('/api/broker/run', { action: 'bash', args: { cmd: 'id' } }))).status).toBe(400);
    expect((await run.POST(post('/api/broker/run', { action: 'test-key', args: { connectorId: 'nope' } }))).status).toBe(400);
    expect((await run.POST(post('/api/broker/run', { action: 'test-key', args: ARGS, secretNames: ['ANTHROPIC_API_KEY'] }))).status).toBe(403);
    expect(providerCalls).toEqual([]);
  });
  it('the audit log is for the owner, lists each call by who and what, and holds no value', async () => {
    expect((await audit.GET(new NextRequest('http://localhost:3000/api/broker/audit'))).status).toBe(403);
    owner = true;
    const body = await (await audit.GET(new NextRequest('http://localhost:3000/api/broker/audit'))).json();
    expect(body.entries.length).toBeGreaterThanOrEqual(4);
    expect(body.entries.some((e: { by: string; status: string }) => e.by === 'agent:Jack' && e.status === 'ok')).toBe(true);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(readFileSync(join(work, 'app', 'broker-audit.jsonl'), 'utf8')).not.toContain(KEY);
  });
});
