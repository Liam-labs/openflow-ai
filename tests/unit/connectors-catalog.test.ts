import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCatalog, type ConnectorsCatalog } from '@/lib/connectors/catalog';
import { PROBES } from '@/lib/connectors/test-key';

const real = JSON.parse(readFileSync(join(process.cwd(), 'data', 'connectors-catalog.json'), 'utf-8')) as ConnectorsCatalog;
const clone = (): ConnectorsCatalog => JSON.parse(JSON.stringify(real));

describe('the shipped connectors catalog', () => {
  it('passes its own validator', () => {
    expect(validateCatalog(real)).toEqual([]);
  });

  it('covers every kind of connector the wizard promises', () => {
    const kinds = new Set(real.connectors.map((c) => c.kind));
    expect([...kinds].sort()).toEqual(['api-key', 'cli', 'local-service', 'mcp']);
    const ids = real.connectors.map((c) => c.id);
    for (const id of ['claude-code', 'codex', 'github', 'openrouter', 'mcp-qdrant', 'resend']) expect(ids).toContain(id);
  });

  it('has a real check behind every key test it names', () => {
    for (const c of real.connectors) {
      const t = c.setup.key?.test;
      if (t) expect(PROBES[t], `${c.id} names a check that does not exist`).toBeDefined();
    }
  });

  it('states cost in words, never as a price', () => {
    for (const c of real.connectors) expect(c.cost, c.id).not.toMatch(/[£$€]\s?\d|\d\s?(usd|gbp|eur)\b/i);
  });

  it('holds nothing private: no email addresses, no machine paths, no secrets', () => {
    const text = JSON.stringify(real);
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);   // no email addresses
    expect(text).not.toMatch(/\/home\/(?!node\/)[a-z]|\/Users\/|C:\\\\Users/);
  });

  it('gives every setup at least one plain step and an https docs link', () => {
    for (const c of real.connectors) {
      expect(c.setup.steps.length, c.id).toBeGreaterThan(0);
      expect(c.docs, c.id).toMatch(/^https:\/\//);
    }
  });
});

describe('the WhatsApp Switchboard listing', () => {
  const sb = real.connectors.find(c => c.id === 'whatsapp-switchboard');
  it('is an optional local service that is not recommended and says it is unofficial', () => {
    expect(sb).toBeDefined();
    expect(sb?.kind).toBe('local-service');
    expect(sb?.category).toBe('comms');
    expect(sb?.recommended).not.toBe(true);
    expect(sb?.cost).toMatch(/unofficial/i);
    expect(sb?.cost).toMatch(/Business API/);
    expect(sb?.setup.steps.join(' ')).toMatch(/off by default/i);
    expect(sb?.detect.port).toBe(8310);
  });
  it('holds no number, path or key that belongs to one install', () => {
    const text = JSON.stringify(sb);
    expect(text).not.toMatch(/\+\d{7,}|\/home\/|\.AppData|wsk_/);
  });
});

describe('validateCatalog refuses a bad list', () => {
  const mutate = (fn: (c: ConnectorsCatalog) => void): string[] => {
    const c = clone();
    fn(c);
    return validateCatalog(c);
  };
  const find = (c: ConnectorsCatalog, id: string) => c.connectors.find((x) => x.id === id)!;

  it('gives every api-key connector a provider page to open, and refuses one that is not https', () => {
    for (const c of clone().connectors.filter((x) => x.kind === 'api-key')) expect(c.setup.open?.url, c.id).toMatch(/^https:\/\//);
    expect(mutate((c) => { find(c, 'openrouter').setup.open = { label: 'Get a key', url: 'http://openrouter.ai/keys' }; }).join()).toMatch(/setup\.open/);
  });
  it('flags a duplicate id', () => {
    expect(mutate((c) => { c.connectors[1].id = c.connectors[0].id; }).join()).toMatch(/duplicate id/);
  });
  it('flags an unknown category', () => {
    expect(mutate((c) => { c.connectors[0].category = 'nope'; }).join()).toMatch(/unknown category/);
  });
  it('flags an api-key connector with no key, and a key env that is not detected', () => {
    expect(mutate((c) => { delete find(c, 'openrouter').setup.key; }).join()).toMatch(/needs setup\.key/);
    expect(mutate((c) => { find(c, 'openrouter').detect.env = ['OTHER_KEY']; }).join()).toMatch(/detect\.env must list/);
  });
  it('flags two connectors that store the same environment name', () => {
    expect(mutate((c) => { const k = find(c, 'xai'); k.setup.key!.env = 'OPENROUTER_API_KEY'; k.detect.env = ['OPENROUTER_API_KEY']; }).join()).toMatch(/already used/);
  });
  it('flags an unknown key test and a lower-case env name', () => {
    expect(mutate((c) => { (find(c, 'xai').setup.key as { test?: string }).test = 'nonsense'; }).join()).toMatch(/unknown key test/);
    expect(mutate((c) => { find(c, 'xai').setup.key!.env = 'xai_key'; }).join()).toMatch(/needs setup\.key/);
  });
  it('flags an mcp connector whose detect name differs from the server name', () => {
    expect(mutate((c) => { find(c, 'mcp-memory').detect.mcp = 'other'; }).join()).toMatch(/detect\.mcp must equal/);
  });
  it('flags an argument that refers to an input that does not exist', () => {
    expect(mutate((c) => { find(c, 'mcp-filesystem').setup.mcp!.args = ['{nothing}']; }).join()).toMatch(/no input has that id/);
  });
  it('flags a command with a path or shell text, and a non-https mcp url', () => {
    expect(mutate((c) => { find(c, 'mcp-memory').setup.mcp!.command = 'npx; rm -rf ~'; }).join()).toMatch(/plain command name/);
    expect(mutate((c) => { find(c, 'higgsfield').setup.mcp!.url = 'http://mcp.example.test/mcp'; }).join()).toMatch(/https url/);
  });
  it('flags an authCheck that does not start with the detect binary', () => {
    expect(mutate((c) => { find(c, 'github').authCheck = ['curl', 'x']; }).join()).toMatch(/authCheck/);
  });
  it('flags something that looks like a real key', () => {
    expect(mutate((c) => { c.connectors[0].cost = 'try sk-abcdefghijklmnopqrstuvwxyz123456'; }).join()).toMatch(/real key/);
    expect(mutate((c) => { c.connectors[0].cost = 'token ghp_abcdefghijklmnopqrstuvwxyz0123'; }).join()).toMatch(/real key/);
  });
  it('flags a private path, address or host', () => {
    expect(mutate((c) => { c.connectors[0].summary = 'see /home/someone/notes'; }).join()).toMatch(/private/);
    expect(mutate((c) => { c.connectors[0].summary = 'runs on 192.168.1.20'; }).join()).toMatch(/private/);
    expect(mutate((c) => { c.connectors[0].summary = 'reach box.tail1234.ts.net'; }).join()).toMatch(/private/);
  });
  it('flags a missing summary, a bad cost kind and a non-https docs link', () => {
    expect(mutate((c) => { c.connectors[0].summary = ' '; }).join()).toMatch(/summary is required/);
    expect(mutate((c) => { (c.connectors[0] as { costKind: string }).costKind = 'cheap'; }).join()).toMatch(/bad costKind/);
    expect(mutate((c) => { c.connectors[0].docs = 'http://x.test'; }).join()).toMatch(/docs must be an https/);
  });
  it('refuses a catalog that is not an object or is empty', () => {
    expect(validateCatalog(null)).not.toEqual([]);
    expect(validateCatalog({ version: 1, categories: [], connectors: [] })).not.toEqual([]);
  });
});
