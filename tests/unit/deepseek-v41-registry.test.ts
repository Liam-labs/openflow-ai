import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

type RegistryModel = {
  id: string;
  apiId?: string;
  aliases?: string[];
  provider?: string;
  agentTypes?: string[];
  capabilities?: {
    inputModes?: string[];
    outputModes?: string[];
    contextWindow?: number;
    maxOutputTokens?: number;
    reasoning?: boolean;
    toolUse?: boolean;
    vision?: boolean;
  };
};

function ensureModels(value: unknown): RegistryModel[] {
  if (!Array.isArray(value)) throw new Error('models registry is missing its models array');
  return value as RegistryModel[];
}

function modelsFromFile(relativePath: string): RegistryModel[] {
  const parsed = JSON.parse(
    readFileSync(path.join(process.cwd(), relativePath), 'utf8'),
  ) as { models?: unknown };
  return ensureModels(parsed.models);
}

describe('DeepSeek V4.1 seed registry contract', () => {
  const registryPath = 'data/models.json';
  it('publishes one canonical vision-capable Flash entry and retains old IDs only as aliases', () => {
    const models = modelsFromFile(registryPath);
    const flash = models.find(model => model.id === 'deepseek-flash');

    expect(flash).toMatchObject({
      apiId: 'deepseek-flash[1m]',
      provider: 'deepseek',
      aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
      agentTypes: ['claude', 'claude-terminal'],
      capabilities: {
        inputModes: ['text', 'image'],
        outputModes: ['text'],
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        reasoning: true,
        toolUse: true,
        vision: true,
      },
    });
    expect(models.some(model => model.id === 'deepseek-v4-flash')).toBe(false);
    expect(models.some(model => model.id === 'deepseek-v4-flash-vision-exp')).toBe(false);
  });

  it('keeps the continuing text-only V4 Pro endpoint distinct', () => {
    const models = modelsFromFile(registryPath);
    expect(models.find(model => model.id === 'deepseek-v4-pro')).toMatchObject({
      apiId: 'deepseek-v4-pro',
      capabilities: {
        inputModes: ['text'],
        outputModes: ['text'],
        vision: false,
      },
    });
  });
});
