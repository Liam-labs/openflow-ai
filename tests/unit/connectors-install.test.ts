import { describe, expect, it } from 'vitest';
import { installArgv } from '@/lib/connectors/install-parse';
import { runInstall } from '@/lib/connectors/install';
import { loadCatalog, type Connector } from '@/lib/connectors/catalog';

describe('installArgv', () => {
  it('accepts a plain global npm install and a local docker run', () => {
    expect(installArgv('npm install -g @openai/codex')).toEqual(['npm', 'install', '-g', '@openai/codex']);
    expect(installArgv('docker run -d --name n8n -p 127.0.0.1:5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n')).not.toBeNull();
  });
  it('refuses shell text, sign-in commands, other binaries and anything that opens the disk or the network', () => {
    for (const cmd of [
      'curl -fsSL https://ollama.com/install.sh | sh', 'gh auth login', 'npm install -g foo && rm -rf ~', 'npm install foo', 'npm install -g ../evil', 'npm install -g a b',
      'docker run -d -p 5678:5678 img', 'docker run -d -v /:/host img', 'docker run --privileged img', 'docker run -d --name x -p 127.0.0.1:1:1', '', 'npm install -g $(id)',
    ]) expect(installArgv(cmd), cmd).toBeNull();
  });
  it('covers the catalog the way the page expects', async () => {
    const cat = await loadCatalog();
    const ids = cat.connectors.filter((c) => installArgv(c.setup.command)).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['claude-code', 'codex', 'cloudflare-wrangler', 'netlify', 'vercel', 'n8n', 'mcp-qdrant']));
    expect(ids).not.toContain('ollama');
    expect(ids).not.toContain('github');
  });
});

describe('runInstall', () => {
  const c = { name: 'Codex', setup: { steps: ['x'], command: 'npm install -g @openai/codex' } } as unknown as Connector;
  it('reports success, a missing tool, and the tail of a failure', async () => {
    const ok = ((_f: string, _a: string[], _o: unknown, cb: (e: null) => void) => cb(null)) as never;
    expect((await runInstall(c, ok)).ok).toBe(true);
    const missing = ((_f: string, _a: string[], _o: unknown, cb: (e: Error) => void) => cb(Object.assign(new Error('x'), { code: 'ENOENT' }))) as never;
    expect((await runInstall(c, missing)).message).toMatch(/npm is not installed/);
    const fail = ((_f: string, _a: string[], _o: unknown, cb: (e: Error, o: string, s: string) => void) => cb(new Error('x'), '', 'npm ERR! code EACCES\nnpm ERR! permission denied')) as never;
    expect((await runInstall(c, fail)).message).toMatch(/permission denied/);
  });
  it('refuses a command that is not installable', async () => {
    await expect(runInstall({ name: 'GH', setup: { steps: ['x'], command: 'gh auth login' } } as unknown as Connector)).rejects.toThrow(/cannot be installed/);
  });
});
