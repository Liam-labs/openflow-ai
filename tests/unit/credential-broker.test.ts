import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore } from '@/lib/secret-store';
import { APPROVAL_TTL_MS, HIDDEN, cleanOutput, createApproval, fingerprint, runWithSecret, type BrokerAction, type BrokerDeps } from '@/lib/credential-broker';

const KEY = 'sk-test-REAL-KEY-0123456789abcdef';  // gitleaks:allow (a made-up test value)
let dir: string;
let clock = 1_000_000;
let ran: Array<{ args: unknown; names: string[] }>;
let deps: BrokerDeps;
let store: FileSecretStore;

// A harmless action: it "checks" a key and reports whatever the test tells it to say, so we can see how output is cleaned.
let say = (k: string) => `The key ${k.slice(0, 3)}… works.`;
const action: BrokerAction<{ provider: string }> = {
  id: 'check',
  validateArgs: (a) => (a && typeof a === 'object' && typeof (a as { provider?: unknown }).provider === 'string' ? { provider: (a as { provider: string }).provider } : 'Say which provider.'),
  names: (a) => (a.provider === 'deepseek' ? ['DEEPSEEK_API_KEY'] : []),
  run: async (a, secrets) => { ran.push({ args: a, names: Object.keys(secrets) }); return { ok: true, message: say(secrets.DEEPSEEK_API_KEY) }; },
};
const agent = { kind: 'agent', name: 'Jack' } as const;
const owner = { kind: 'owner' } as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'broker-'));
  mkdirSync(join(dir, 'keys'));
  mkdirSync(join(dir, 'data'));
  store = new FileSecretStore(join(dir, 'data', 'secrets.json'), { DEVFLOW_SECRETS_KEY_FILE: join(dir, 'keys', 'k') });
  store.set('DEEPSEEK_API_KEY', KEY);
  ran = [];
  clock = 1_000_000;
  say = (k) => `The key ${k.slice(0, 3)}… works.`;
  deps = { actions: { check: action }, store, now: () => clock, approvalsFile: join(dir, 'approvals.json'), auditFile: join(dir, 'audit.jsonl') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const approve = async (args: unknown = { provider: 'deepseek' }) => {
  const a = await createApproval('check', args, [], deps);
  if ('error' in a) throw new Error(a.error);
  return a.approvalId;
};

describe('approval', () => {
  it('an agent without an approval is refused and nothing runs', async () => {
    const r = await runWithSecret({ action: 'check', args: { provider: 'deepseek' } }, agent, deps);
    expect(r).toMatchObject({ ok: false, status: 'needs-approval' });
    expect(ran).toEqual([]);
  });
  it('an agent with the right approval runs once, and the approval is then spent', async () => {
    const id = await approve();
    const first = await runWithSecret({ action: 'check', args: { provider: 'deepseek' }, approvalId: id }, agent, deps);
    expect(first).toMatchObject({ ok: true, status: 'ok' });
    expect(ran).toHaveLength(1);
    const again = await runWithSecret({ action: 'check', args: { provider: 'deepseek' }, approvalId: id }, agent, deps);
    expect(again.status).toBe('needs-approval');
    expect(ran).toHaveLength(1);
  });
  it('an approval for different arguments, another action or another name is refused, and is not spent by the mistake', async () => {
    const id = await approve({ provider: 'deepseek' });
    const wrongArgs = await runWithSecret({ action: 'check', args: { provider: 'other' }, approvalId: id }, agent, deps);
    expect(wrongArgs.status).toBe('needs-approval');
    expect(await runWithSecret({ action: 'check', args: { provider: 'deepseek' }, approvalId: id }, agent, deps)).toMatchObject({ status: 'ok' });
  });
  it('an approval expires after ten minutes', async () => {
    const id = await approve();
    clock += APPROVAL_TTL_MS + 1;
    expect((await runWithSecret({ action: 'check', args: { provider: 'deepseek' }, approvalId: id }, agent, deps)).status).toBe('needs-approval');
  });
  it('a made-up approval id is refused', async () => {
    expect((await runWithSecret({ action: 'check', args: { provider: 'deepseek' }, approvalId: 'nope' }, agent, deps)).status).toBe('needs-approval');
  });
  it('the signed-in owner needs no approval', async () => {
    expect(await runWithSecret({ action: 'check', args: { provider: 'deepseek' } }, owner, deps)).toMatchObject({ ok: true });
  });
  it('an approval cannot be made for an action that does not exist', async () => {
    expect(await createApproval('rm-rf', {}, [], deps)).toMatchObject({ error: expect.stringContaining('not one the broker') });
  });
  it('the fingerprint ignores key order and secret-name order', () => {
    expect(fingerprint('a', { x: 1, y: 2 }, ['B', 'A'])).toBe(fingerprint('a', { y: 2, x: 1 }, ['A', 'B']));
    expect(fingerprint('a', { x: 1 }, ['A'])).not.toBe(fingerprint('a', { x: 2 }, ['A']));
  });
});

describe('what may be asked', () => {
  it('refuses an unknown action, an action name that is a JavaScript built-in, and a free command', async () => {
    for (const name of ['nope', 'constructor', '__proto__', 'toString', 'bash -c id']) {
      expect((await runWithSecret({ action: name }, owner, deps)).status).toBe('unknown-action');
    }
    expect(ran).toEqual([]);
  });
  it('refuses a secret name the action may not use', async () => {
    expect((await runWithSecret({ action: 'check', args: { provider: 'deepseek' }, secretNames: ['ANTHROPIC_API_KEY'] }, owner, deps)).status).toBe('refused');
    expect(ran).toEqual([]);
  });
  it('refuses arguments the action does not accept, with a plain message', async () => {
    expect(await runWithSecret({ action: 'check', args: { provider: 7 } }, owner, deps)).toMatchObject({ status: 'bad-request', message: 'Say which provider.' });
  });
  it('says so plainly when the key is not saved', async () => {
    store.delete('DEEPSEEK_API_KEY');
    expect((await runWithSecret({ action: 'check', args: { provider: 'deepseek' } }, owner, deps)).status).toBe('missing-key');
  });
});

describe('the store cannot be opened', () => {
  it('refuses with "locked" and runs nothing when the encryption key does not match', async () => {
    const lost = new FileSecretStore(join(dir, 'data', 'secrets.json'), { DEVFLOW_SECRETS_KEY_FILE: join(dir, 'keys', 'elsewhere') });
    const r = await runWithSecret({ action: 'check', args: { provider: 'deepseek' } }, owner, { ...deps, store: lost });
    expect(r).toMatchObject({ ok: false, status: 'locked' });
    expect(ran).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});

describe('the value never comes back', () => {
  it('replaces the key, and its base64, URL and hex forms, with [hidden]', async () => {
    say = (k) => `raw ${k} b64 ${Buffer.from(k).toString('base64')} url ${encodeURIComponent(k)} hex ${Buffer.from(k).toString('hex')} json ${JSON.stringify(k)}`;
    const r = await runWithSecret({ action: 'check', args: { provider: 'deepseek' } }, owner, deps);
    expect(r.status).toBe('ok');
    expect(r.output).not.toContain(KEY);
    expect(r.output).not.toContain(Buffer.from(KEY).toString('base64'));
    expect(r.output).not.toContain(Buffer.from(KEY).toString('hex'));
    expect(r.output.match(/\[hidden\]/g)!.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
  it('returns nothing at all when it cannot show the text is clean', () => {
    expect(cleanOutput(`the key is ${KEY}`, [KEY])).toBe(`the key is ${HIDDEN}`);
    // A secret that is part of the marker itself can never be removed, so the text is withheld.
    expect(cleanOutput('anything', ['hidden]'])).toBe('anything');
    expect(cleanOutput(`say ${HIDDEN}`, ['hidden]'])).toBeNull();
  });
  it('an action that fails reports "failed" without echoing anything the action threw', async () => {
    const boom: BrokerAction<{ provider: string }> = { ...action, run: async (_a, s) => { throw new Error(`leaked ${s.DEEPSEEK_API_KEY}`); } };
    const r = await runWithSecret({ action: 'check', args: { provider: 'deepseek' } }, owner, { ...deps, actions: { check: boom } });
    expect(r).toMatchObject({ ok: false, status: 'failed', message: 'The action failed.' });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
  it('a result the action marks as failed is still cleaned', async () => {
    const bad: BrokerAction<{ provider: string }> = { ...action, run: async (_a, s) => ({ ok: false, message: `rejected ${s.DEEPSEEK_API_KEY}` }) };
    const r = await runWithSecret({ action: 'check', args: { provider: 'deepseek' } }, owner, { ...deps, actions: { check: bad } });
    expect(r.status).toBe('failed');
    expect(r.message).toBe(`rejected ${HIDDEN}`);
  });
});

describe('audit', () => {
  it('writes one line per call with who, action, names, approval and result, and never a value', async () => {
    const id = await approve();
    await runWithSecret({ action: 'check', args: { provider: 'deepseek' }, approvalId: id }, agent, deps);
    await runWithSecret({ action: 'check', args: { provider: 'deepseek' } }, agent, deps);
    await runWithSecret({ action: 'nope' }, owner, deps);
    const text = readFileSync(deps.auditFile!, 'utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ by: 'agent:Jack', action: 'check', names: ['DEEPSEEK_API_KEY'], approval: id, status: 'ok' });
    expect(lines[1]).toMatchObject({ by: 'agent:Jack', status: 'needs-approval', approval: null });
    expect(lines[2]).toMatchObject({ by: 'owner', status: 'unknown-action' });
    expect(text).not.toContain(KEY);
  });
});
