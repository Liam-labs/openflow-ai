import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('@/app/api/collab/pty/_handlers/message-inject', () => ({ handleRosterSpawn: spawn }));
vi.mock('@/app/api/collab/pty/_pty-shared', () => ({
  readChannelsData: async () => ({ channels: [{ id: 'ch1', roster: { agents: [
    { id: 'a1', model: 'deepseek-v4-pro', claudeFlags: [] },
    { id: 'a2', model: 'sonnet', claudeFlags: [] },
  ] } }] }),
}));

import { handoffPrefix } from '@/lib/agent-key-handoff';
import { keyNamesForModel, startAgentAction } from '@/lib/credential-broker-actions';
import { runWithSecret } from '@/lib/credential-broker';
import { FileSecretStore } from '@/lib/secret-store';

const KEY = ['fake', 'handoff', 'value', 'aaaa'].join('-');

describe('handoffPrefix', () => {
  it('gives the launch shell the key, names no value, and deletes the file after reading', () => {
    const prefix = handoffPrefix({ DEEPSEEK_API_KEY: KEY });
    expect(prefix).not.toContain(KEY);
    const dir = /rm -rf '([^']+)'/.exec(prefix)![1];
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'env')).mode & 0o777).toBe(0o600);
    const out = execFileSync('bash', ['-c', `${prefix} printf %s "$DEEPSEEK_API_KEY"`]).toString();
    expect(out).toBe(KEY);
    expect(fs.existsSync(dir)).toBe(false);
  });
  it('refuses a name or value a shell could misread', () => {
    expect(() => handoffPrefix({ 'BAD NAME': 'x' })).toThrow();
    expect(() => handoffPrefix({ DEEPSEEK_API_KEY: 'a\nb' })).toThrow();
    expect(handoffPrefix({})).toBe('');
  });
});

describe('start-agent', () => {
  it('knows which agents need a key', () => {
    expect(keyNamesForModel('deepseek-v4-pro')).toEqual(['DEEPSEEK_API_KEY']);
    expect(keyNamesForModel('sonnet')).toEqual([]);
    expect(keyNamesForModel('sonnet', ['--model', 'deepseek-v4-flash'])).toEqual(['DEEPSEEK_API_KEY']);
  });
  it('checks its arguments', async () => {
    expect(typeof startAgentAction.validateArgs({ channelId: 'x; rm' , agentId: 'a1' })).toBe('string');
    expect(startAgentAction.validateArgs({ channelId: 'ch1', agentId: 'a1' })).toEqual({ channelId: 'ch1', agentId: 'a1' });
  });

  let dir: string;
  let store: FileSecretStore;
  const deps = () => ({ actions: { 'start-agent': startAgentAction }, store, approvalsFile: path.join(dir, 'ap.json'), auditFile: path.join(dir, 'audit.jsonl') });
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockResolvedValue(NextResponse.json({ success: true }));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brk-'));
    store = new FileSecretStore(path.join(dir, 'secrets.json'), { DEVFLOW_VAULT_KEY: Buffer.alloc(32, 3).toString('base64') });
    store.set('DEEPSEEK_API_KEY', KEY);
  });

  it('passes the key to the spawn and returns no key; the audit line has no value', async () => {
    const r = await runWithSecret({ action: 'start-agent', args: { channelId: 'ch1', agentId: 'a1' } }, { kind: 'owner' }, deps());
    expect(r.ok).toBe(true);
    expect(spawn.mock.calls[0][7]).toEqual({ DEEPSEEK_API_KEY: KEY });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8')).not.toContain(KEY);
  });
  it('needs an approval for an agent caller', async () => {
    const r = await runWithSecret({ action: 'start-agent', args: { channelId: 'ch1', agentId: 'a1' } }, { kind: 'agent', name: 'Jack' }, deps());
    expect(r.status).toBe('needs-approval');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('starts an agent with no key need without reading any secret', async () => {
    store.delete('DEEPSEEK_API_KEY');
    const r = await runWithSecret({ action: 'start-agent', args: { channelId: 'ch1', agentId: 'a2' } }, { kind: 'owner' }, deps());
    expect(r.ok).toBe(true);
    expect(spawn.mock.calls[0][7]).toEqual({});
  });
  it('reports a failed start in plain words', async () => {
    spawn.mockResolvedValue(NextResponse.json({ success: false }, { status: 500 }));
    const r = await runWithSecret({ action: 'start-agent', args: { channelId: 'ch1', agentId: 'a1' } }, { kind: 'owner' }, deps());
    expect(r.ok).toBe(false);
    expect(r.message).toBe('The agent did not start.');
  });
});
