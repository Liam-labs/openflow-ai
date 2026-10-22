import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

type RegistryModel = {
  id: string;
  apiId?: string;
  provider: string;
  label: string;
  agentTypes: string[];
  capabilities?: {
    reasoning?: boolean;
    toolUse?: boolean;
    vision?: boolean;
    contextWindow?: number;
    maxOutputTokens?: number;
  };
};

const variants = [
  ['gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)'],
  ['gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'],
  ['gemini-3.6-flash-low', 'Gemini 3.6 Flash (Low)'],
] as const;

function readModels(file: string): RegistryModel[] {
  const parsed = JSON.parse(readFileSync(path.join(process.cwd(), file), 'utf8')) as {
    models: RegistryModel[];
  };
  return parsed.models;
}

describe('Gemini 3.6 Flash Antigravity profile registry entries', () => {
  for (const registryFile of ['data/models.json', '.AppData/models.json']) {
    it(`exposes three distinct Antigravity-only selections in ${registryFile}`, () => {
      const models = readModels(registryFile);
      const entries = variants.map(([id, label]) => {
        const entry = models.find(model => model.id === id);
        expect(entry, `missing ${id}`).toBeDefined();
        expect(entry).toMatchObject({
          id,
          label,
          provider: 'google',
          agentTypes: ['antigravity'],
          capabilities: {
            reasoning: true,
            toolUse: true,
            vision: true,
            contextWindow: 1_048_576,
            maxOutputTokens: 65_536,
          },
        });
        expect(entry).not.toHaveProperty('apiId');
        return entry;
      });

      expect(new Set(entries.map(entry => entry?.id)).size).toBe(3);
    });
  }
});
