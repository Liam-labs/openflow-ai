import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsSync from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';

const store = vi.hoisted(() => ({ values: {} as Record<string, string> }));
const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/secret-store', () => ({ resolveSecretStore: () => ({ get: (n: string) => store.values[n], kind: 'file' }) }));
vi.mock('@/lib/home-dir', () => ({ getHomeDir: () => home.dir }));

import { modelFromSavedKeys } from '@/lib/default-model';

beforeEach(() => {
  store.values = {};
  home.dir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'default-model-'));
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('modelFromSavedKeys', () => {
  it('picks DeepSeek when a DeepSeek key was saved (for example on Connections) and nothing else can run Claude Code', () => {
    store.values.DEEPSEEK_API_KEY = 'sk-saved';
    expect(modelFromSavedKeys('claude')).toBe('deepseek-flash');
  });

  it('also counts a DeepSeek key in the environment', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-env');
    expect(modelFromSavedKeys('claude')).toBe('deepseek-flash');
  });

  it('chooses nothing without a DeepSeek key', () => {
    expect(modelFromSavedKeys('claude')).toBeUndefined();
  });

  it('chooses nothing when an Anthropic key is saved or in the environment', () => {
    store.values.DEEPSEEK_API_KEY = 'sk-saved';
    store.values.ANTHROPIC_API_KEY = 'sk-ant';
    expect(modelFromSavedKeys('claude')).toBeUndefined();
    store.values = { DEEPSEEK_API_KEY: 'sk-saved' };
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env');
    expect(modelFromSavedKeys('claude')).toBeUndefined();
  });

  it('chooses nothing when this computer already has a Claude sign-in', () => {
    store.values.DEEPSEEK_API_KEY = 'sk-saved';
    fsSync.mkdirSync(nodePath.join(home.dir, '.claude'), { recursive: true });
    fsSync.writeFileSync(nodePath.join(home.dir, '.claude', '.credentials.json'), '{}');
    expect(modelFromSavedKeys('claude')).toBeUndefined();
  });

  it('only applies to the Claude runtime', () => {
    store.values.DEEPSEEK_API_KEY = 'sk-saved';
    expect(modelFromSavedKeys('codex')).toBeUndefined();
  });
});
