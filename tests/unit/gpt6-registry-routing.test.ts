import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

interface RegistryEntry {
  id: string;
  agentTypes: string[];
  agentType?: string;
  harness?: string;
  isDefault?: boolean;
  integration?: { interfaceType?: string };
}

// Owner, 27 Sep 2026: GPT-6 Astra, Sol and Luna are the only GPT models.
const GPT_IDS = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];

function readRegistry(relativePath: string): RegistryEntry[] {
  const parsed = JSON.parse(
    readFileSync(path.join(process.cwd(), relativePath), 'utf-8'),
  ) as { models: RegistryEntry[] };
  return parsed.models;
}

describe('GPT-6 canonical runtime metadata', () => {
  for (const registryPath of ['data/models.json', '.AppData/models.json']) {
    it(`${registryPath} lists exactly the GPT-6 models, all routed through Codex`, () => {
      const models = readRegistry(registryPath);
      const gpt = models.filter((model) =>
        model.agentTypes.some((type) => type === 'codex' || type === 'gpt'));
      expect(gpt.map((model) => model.id).sort()).toEqual([...GPT_IDS].sort());
      for (const entry of gpt) {
        expect(entry.agentTypes).toEqual(['codex']);
        expect(entry.agentType).toBe('codex');
        expect(entry.harness).toBe('codex');
        expect(entry.integration?.interfaceType).toBe('codex');
      }
      expect(gpt.filter((model) => model.isDefault).map((model) => model.id)).toEqual(['gpt-6-astra']);
    });
  }
});
