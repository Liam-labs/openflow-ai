import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateWizardKeys } from '@/lib/wizard-key-migration';
import { FileSecretStore } from '@/lib/secret-store';

let dir: string;
let file: string;
let store: FileSecretStore;
const env = { DEVFLOW_VAULT_KEY: Buffer.alloc(32, 7).toString('base64') } as Record<string, string | undefined>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizkeys-'));
  file = path.join(dir, 'credentials.json');
  store = new FileSecretStore(path.join(dir, 'secrets.json'), env);
});
const write = (o: unknown) => fs.writeFileSync(file, JSON.stringify(o));
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('migrateWizardKeys', () => {
  it('moves the three keys into the store, blanks the file and leaves no backup', () => {
    write({ anthropicApiKey: 'sk-ant-1', openrouterApiKey: 'sk-or-1', grokApiKey: 'xai-1', ollamaUrl: 'http://x', devflowApiToken: 'dvf_a' });
    const r = migrateWizardKeys(file, store);
    expect(r.moved.sort()).toEqual(['ANTHROPIC_API_KEY', 'GROK_API_KEY', 'OPENROUTER_API_KEY']);
    expect(store.get('OPENROUTER_API_KEY')).toBe('sk-or-1');
    const after = read();
    expect(after.anthropicApiKey).toBe('');
    expect(after.ollamaUrl).toBe('http://x');
    expect(after.devflowApiToken).toBe('dvf_a');
    expect(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).not.toContain('sk-or-1');
    expect(fs.existsSync(`${file}.before-store`)).toBe(false);
  });

  it('does nothing when no key is present or the file is missing', () => {
    expect(migrateWizardKeys(file, store)).toEqual({ moved: [], failed: [] });
    write({ anthropicApiKey: '', devflowApiToken: 'dvf_a' });
    expect(migrateWizardKeys(file, store)).toEqual({ moved: [], failed: [] });
    expect(fs.existsSync(`${file}.before-store`)).toBe(false);
  });

  it('keeps the key and the backup when the store cannot take it', () => {
    write({ anthropicApiKey: 'sk-ant-1' });
    const broken = { ...store, kind: 'file', get: () => undefined, set: () => { throw new Error('no'); }, delete() {}, names: () => [] } as never;
    const r = migrateWizardKeys(file, broken);
    expect(r.failed).toEqual(['ANTHROPIC_API_KEY']);
    expect(read().anthropicApiKey).toBe('sk-ant-1');
    expect(fs.existsSync(`${file}.before-store`)).toBe(true);
  });

  it('is a no-op the second time', () => {
    write({ grokApiKey: 'xai-1' });
    migrateWizardKeys(file, store);
    expect(migrateWizardKeys(file, store)).toEqual({ moved: [], failed: [] });
    expect(store.get('GROK_API_KEY')).toBe('xai-1');
  });
});
