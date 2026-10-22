import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let dir: string;
let file: string;

vi.mock('@/lib/data-paths', async () => ({ DataPaths: { get apiTokens() { return file; } } }));

async function load() {
  vi.resetModules();
  return import('@/lib/api-auth');
}

const request = (token: string) => new NextRequest('http://localhost:3000/api/x', { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.9' } });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokstore-'));
  file = path.join(dir, 'api-tokens.json');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('a token store that is not valid JSON', () => {
  it('is kept as a copy, reported clearly, never read as "no tokens", and never overwritten by the checks', async () => {
    const { validateApiToken, loadTokensData, generateToken } = await load();
    const original = '{"tokens":[{"id":"real-token-record"';
    await fs.writeFile(file, original);
    const result = await validateApiToken(request(generateToken().token));
    expect(result.valid).toBe(false);
    expect(result.code).toBe('TOKEN_STORE_UNREADABLE');
    await expect(loadTokensData()).rejects.toThrow(/exists but is not valid JSON/);
    expect(await fs.readFile(file, 'utf8')).toBe(original);                        // untouched
    const copies = (await fs.readdir(dir)).filter((n) => n.startsWith('api-tokens.json.corrupt-'));
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, copies[0]), 'utf8')).toBe(original);
  });

  it('a missing store is still a normal first run', async () => {
    const { loadTokensData } = await load();
    const data = await loadTokensData();
    expect(data.tokens).toEqual([]);
  });
});
