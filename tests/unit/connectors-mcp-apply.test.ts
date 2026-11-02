import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMcp, claudeJson, codexArgs, fillArgs, removeMcp, resolveInputs, type Runner } from '@/lib/connectors/mcp-apply';
import { ConnectorInputError } from '@/lib/connectors/errors';
import type { Connector, ConnectorsCatalog } from '@/lib/connectors/catalog';
import catalogJson from '../../data/connectors-catalog.json';

const catalog = catalogJson as unknown as ConnectorsCatalog;
const get = (id: string): Connector => catalog.connectors.find((c) => c.id === id)!;

let home: string;
let folder: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'conn-mcp-'));
  folder = join(home, 'projects');
  mkdirSync(folder);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function recorder(code = 0, stderr = ''): { run: Runner; calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  return { calls, run: async (file, args) => { calls.push({ file, args }); return { code, stderr }; } };
}
const both = async () => true;

describe('input checks', () => {
  const fsSpec = get('mcp-filesystem').setup.mcp!;
  it('expands ~ and accepts a real folder', async () => {
    expect(await resolveInputs(fsSpec, { folder: '~/projects' }, home)).toEqual({ folder });
    expect(await resolveInputs(fsSpec, { folder }, home)).toEqual({ folder });
  });
  it('refuses a missing value, a missing folder, a file, the whole disk, a relative path and control characters', async () => {
    writeFileSync(join(home, 'file.txt'), 'x');
    for (const bad of [undefined, '', '   ', join(home, 'nope'), join(home, 'file.txt'), '/', 'projects', `${folder}\n/etc`, `${folder}\0`, 42]) {
      await expect(resolveInputs(fsSpec, { folder: bad }, home), String(bad)).rejects.toBeInstanceOf(ConnectorInputError);
    }
  });
  it('takes a lone ~ as the home folder', async () => {
    expect(await resolveInputs(fsSpec, { folder: '~' }, home)).toEqual({ folder: home });
  });
  it('refuses control characters and over-long text in a text input too', async () => {
    const textSpec = { name: 't', transport: 'stdio' as const, command: 'x', inputs: [{ id: 'name', label: 'Name', kind: 'text' as const }] };
    expect(await resolveInputs(textSpec, { name: 'fine' }, home)).toEqual({ name: 'fine' });
    for (const bad of ['a\nb', 'a\0b', 'x'.repeat(401)]) await expect(resolveInputs(textSpec, { name: bad }, home)).rejects.toBeInstanceOf(ConnectorInputError);
  });
  it('fills {id} placeholders and nothing else', () => {
    expect(fillArgs(['-y', 'pkg', '{folder}'], { folder: '/a b' })).toEqual(['-y', 'pkg', '/a b']);
    expect(fillArgs(undefined, {})).toEqual([]);
  });
});

describe('what is handed to Claude and Codex', () => {
  it('claude json for a stdio server has command and args, and references secrets instead of holding them', () => {
    const json = claudeJson(get('mcp-supabase').setup.mcp!, {});
    expect(json).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest', '--read-only'], env: { SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}' } });
  });
  it('claude json for an http server is just the address, and fixed settings travel as plain env', () => {
    expect(claudeJson(get('higgsfield').setup.mcp!, {})).toEqual({ type: 'http', url: 'https://mcp.higgsfield.ai/mcp' });
    expect(claudeJson(get('mcp-qdrant').setup.mcp!, {})).toMatchObject({ env: { QDRANT_URL: 'http://127.0.0.1:6333', COLLECTION_NAME: 'openflow-memory' } });
  });
  it('codex args put the command after -- so its own flags are not read as codex flags', () => {
    expect(codexArgs(get('mcp-filesystem').setup.mcp!, { folder: '/x' })).toEqual(['mcp', 'add', 'filesystem', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '/x']);
    expect(codexArgs(get('higgsfield').setup.mcp!, {})).toEqual(['mcp', 'add', 'higgsfield', '--url', 'https://mcp.higgsfield.ai/mcp']);
    expect(codexArgs(get('mcp-qdrant').setup.mcp!, {}).slice(0, 7)).toEqual(['mcp', 'add', 'qdrant', '--env', 'QDRANT_URL=http://127.0.0.1:6333', '--env', 'COLLECTION_NAME=openflow-memory']);
  });
});

describe('addMcp', () => {
  it('adds to both programs with the user scope and exact arguments', async () => {
    const { run, calls } = recorder();
    const r = await addMcp(get('mcp-filesystem'), { folder }, new Set(), { home, run, hasBinary: both });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].file).toBe('claude');
    expect(calls[0].args.slice(0, 5)).toEqual(['mcp', 'add-json', '--scope', 'user', 'filesystem']);
    expect(JSON.parse(calls[0].args[5])).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', folder] });
    expect(calls[1]).toEqual({ file: 'codex', args: ['mcp', 'add', 'filesystem', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', folder] });
  });

  it('keeps hostile input as one argument, never as shell text', async () => {
    const odd = join(home, `a b; touch pwned $(id) 'q'`);
    mkdirSync(odd);
    const { run, calls } = recorder();
    await addMcp(get('mcp-filesystem'), { folder: odd }, new Set(), { home, run, hasBinary: both });
    expect(JSON.parse(calls[0].args[5]).args[2]).toBe(odd);
    expect(calls[1].args[calls[1].args.length - 1]).toBe(odd);
  });

  it('will not add a server that needs a key until the key is saved, and never sends the key', async () => {
    const { run, calls } = recorder();
    await expect(addMcp(get('mcp-supabase'), {}, new Set(), { home, run, hasBinary: both })).rejects.toBeInstanceOf(ConnectorInputError);
    expect(calls).toHaveLength(0);
    const r = await addMcp(get('mcp-supabase'), {}, new Set(['SUPABASE_ACCESS_TOKEN']), { home, run, hasBinary: both });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);                         // Claude only
    expect(r.results.find((x) => x.target === 'codex')?.outcome).toBe('needs-manual');
    expect(JSON.stringify(calls)).not.toMatch(/sbp_|[A-Za-z0-9]{30,}/);
  });

  it('leaves a server that is already listed alone', async () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { memory: {} } }));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.memory]\ncommand = "x"\n');
    const { run, calls } = recorder();
    const r = await addMcp(get('mcp-memory'), {}, new Set(), { home, run, hasBinary: both });
    expect(calls).toHaveLength(0);
    expect(r.results.map((x) => x.outcome)).toEqual(['already', 'already']);
    expect(r.ok).toBe(true);
  });

  it('says so when neither program is installed, and does not claim success', async () => {
    const { run, calls } = recorder();
    const r = await addMcp(get('mcp-memory'), {}, new Set(), { home, run, hasBinary: async () => false });
    expect(calls).toHaveLength(0);
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => x.outcome)).toEqual(['not-installed', 'not-installed']);
  });

  it('reports a refusal and passes on the reason', async () => {
    const { run } = recorder(1, 'boom: not allowed');
    const r = await addMcp(get('mcp-memory'), {}, new Set(), { home, run, hasBinary: both });
    expect(r.ok).toBe(false);
    expect(r.results[0].message).toContain('boom: not allowed');
  });

  it('is not ok when one program took it and the other refused', async () => {
    const calls: string[] = [];
    const run: Runner = async (file) => { calls.push(file); return file === 'codex' ? { code: 1, stderr: 'nope' } : { code: 0, stderr: '' }; };
    const r = await addMcp(get('mcp-memory'), {}, new Set(), { home, run, hasBinary: both });
    expect(calls).toEqual(['claude', 'codex']);
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => x.outcome)).toEqual(['added', 'failed']);
  });

  it('works with only one of the two programs installed', async () => {
    const { run, calls } = recorder();
    const r = await addMcp(get('mcp-memory'), {}, new Set(), { home, run, hasBinary: async (n) => n === 'claude' });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.file)).toEqual(['claude']);
  });
});

describe('removeMcp', () => {
  it('removes only from the lists that hold it', async () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { memory: {} } }));
    const { run, calls } = recorder();
    const r = await removeMcp(get('mcp-memory'), { home, run, hasBinary: both });
    expect(calls).toEqual([{ file: 'claude', args: ['mcp', 'remove', '--scope', 'user', 'memory'] }]);
    expect(r.ok).toBe(true);
    expect(r.results[0].outcome).toBe('removed');
  });
  it('does nothing and says not ok when it is in neither list', async () => {
    const { run, calls } = recorder();
    const r = await removeMcp(get('mcp-memory'), { home, run, hasBinary: both });
    expect(calls).toHaveLength(0);
    expect(r.ok).toBe(false);
  });
});
