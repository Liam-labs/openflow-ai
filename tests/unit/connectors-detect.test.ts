import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binaryOnDisk, configuredMcpNames, detectConnector, searchDirs, tcpOpen, type Facts } from '@/lib/connectors/detect';
import type { Connector } from '@/lib/connectors/catalog';

const base = { category: 'ai', summary: 's', costKind: 'free' as const, cost: 'Free.', docs: 'https://x.test', setup: { steps: ['go'] } };
const cli: Connector = { ...base, id: 'gh', name: 'GH', kind: 'cli', detect: { binary: 'gh' }, authCheck: ['gh', 'auth', 'status'] };
const cliNoAuth: Connector = { ...base, id: 'wr', name: 'WR', kind: 'cli', detect: { binary: 'wrangler' } };
const key: Connector = { ...base, id: 'or', name: 'OR', kind: 'api-key', detect: { env: ['OR_KEY'] }, setup: { steps: ['go'], key: { env: 'OR_KEY', label: 'k' } } };
const mcp: Connector = { ...base, id: 'm', name: 'M', kind: 'mcp', detect: { mcp: 'memory', port: 6333 }, setup: { steps: ['go'], mcp: { name: 'memory', transport: 'stdio', command: 'npx' } } };
const svc: Connector = { ...base, id: 'ol', name: 'OL', kind: 'local-service', detect: { binary: 'ollama', port: 11434 } };

const facts = (over: Partial<Facts> = {}): Facts => ({
  binaries: async () => false, envNames: new Set(), savedNames: new Set(), mcpNames: new Set(),
  port: async () => false, authCheck: async () => false, ...over,
});

describe('detectConnector', () => {
  it('cli: not installed, installed but signed out, ready', async () => {
    expect((await detectConnector(cli, facts())).state).toBe('not-set-up');
    expect((await detectConnector(cli, facts({ binaries: async () => true }))).state).toBe('installed');
    expect((await detectConnector(cli, facts({ binaries: async () => true, authCheck: async () => true }))).state).toBe('ready');
  });
  it('cli without a sign-in check stays "installed" and says it did not check', async () => {
    const r = await detectConnector(cliNoAuth, facts({ binaries: async () => true, authCheck: async () => { throw new Error('must not run'); } }));
    expect(r.state).toBe('installed');
    expect(r.notes.join(' ')).toMatch(/not checked/);
  });
  it('a sign-in check only runs when the program is installed', async () => {
    let ran = 0;
    await detectConnector(cli, facts({ binaries: async () => false, authCheck: async () => { ran++; return true; } }));
    expect(ran).toBe(0);
  });
  it('api key: saved here, found in the environment, or missing', async () => {
    expect(await detectConnector(key, facts({ savedNames: new Set(['OR_KEY']) }))).toMatchObject({ state: 'ready', keyFrom: 'saved' });
    expect(await detectConnector(key, facts({ envNames: new Set(['OR_KEY']) }))).toMatchObject({ state: 'ready', keyFrom: 'environment' });
    expect(await detectConnector(key, facts({ envNames: new Set(['OTHER']) }))).toMatchObject({ state: 'not-set-up' });
  });
  it('an api-key connector joined through the gateway reads as ready, with no key on this machine', async () => {
    const via = (ok: boolean) => facts({ viaGateway: async (id) => ok && id === 'or' });
    expect(await detectConnector(key, via(true))).toMatchObject({ state: 'ready', notes: ['connected through the DevFlow gateway'] });
    expect(await detectConnector(key, via(false))).toMatchObject({ state: 'not-set-up' });
  });
  it('a saved key wins over the environment when both exist', async () => {
    expect((await detectConnector(key, facts({ savedNames: new Set(['OR_KEY']), envNames: new Set(['OR_KEY']) }))).keyFrom).toBe('saved');
  });
  it('mcp: ready only when listed; an open port alone is not enough', async () => {
    expect((await detectConnector(mcp, facts({ port: async () => true }))).state).toBe('not-set-up');
    expect((await detectConnector(mcp, facts({ mcpNames: new Set(['memory']) }))).state).toBe('ready');
  });
  it('local service: running beats installed beats not set up', async () => {
    expect((await detectConnector(svc, facts())).state).toBe('not-set-up');
    expect((await detectConnector(svc, facts({ binaries: async () => true }))).state).toBe('installed');
    expect((await detectConnector(svc, facts({ binaries: async () => true, port: async () => true }))).state).toBe('running');
    expect((await detectConnector(svc, facts({ port: async () => true }))).state).toBe('running');
  });
  it('never puts a value in the notes', async () => {
    const r = await detectConnector(key, facts({ savedNames: new Set(['OR_KEY']) }));
    expect(JSON.stringify(r)).not.toMatch(/sk-/);
  });
});

describe('machine lookups', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'conn-det-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('finds a program that is executable, not one that is merely a file', async () => {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tool'), '#!/bin/sh\n'); chmodSync(join(bin, 'tool'), 0o755);
    writeFileSync(join(bin, 'plain'), 'x'); chmodSync(join(bin, 'plain'), 0o644);
    expect(await binaryOnDisk('tool', [bin])).toBe(true);
    expect(await binaryOnDisk('plain', [bin])).toBe(false);
    expect(await binaryOnDisk('absent', [bin])).toBe(false);
  });

  it('searches the user folders a service PATH leaves out, newest nvm first', async () => {
    mkdirSync(join(home, '.nvm', 'versions', 'node', 'v18.0.0', 'bin'), { recursive: true });
    mkdirSync(join(home, '.nvm', 'versions', 'node', 'v20.1.0', 'bin'), { recursive: true });
    const dirs = await searchDirs(home, '/usr/bin');
    expect(dirs).toContain(join(home, '.local', 'bin'));
    expect(dirs.indexOf(join(home, '.nvm', 'versions', 'node', 'v20.1.0', 'bin'))).toBeLessThan(dirs.indexOf(join(home, '.nvm', 'versions', 'node', 'v18.0.0', 'bin')));
  });

  it('reads MCP server names from Claude, the shared list and Codex, never their settings', async () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { alpha: { env: { SECRET: 'zzz' } } }, projects: { '/x': { mcpServers: { hidden: {} } } } }));
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { beta: {} } }));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.gamma]\ncommand = "x"\n[mcp_servers.gamma.env]\nA = "b"\n[other]\n');
    const names = await configuredMcpNames(home);
    expect([...names].sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('survives missing or broken config files', async () => {
    writeFileSync(join(home, '.claude.json'), '{not json');
    expect((await configuredMcpNames(home)).size).toBe(0);
  });

  it('tcpOpen sees a real listener and a closed port', async () => {
    const server = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await tcpOpen(port)).toBe(true);
    await new Promise((r) => server.close(r));
    expect(await tcpOpen(port)).toBe(false);
  });
});
