import { existsSync } from 'fs';
import path from 'path';
import { getHomeDir } from '@/lib/home-dir';
import { resolveSecretStore } from '@/lib/secret-store';

/**
 * A person who saved a DeepSeek key (on the Connections page, or in this wizard) and has no other way to run Claude Code gets DeepSeek by
 * default. Without this the team starts on plain Claude, nobody is signed in, and every agent, the setup assistant included, sits silent.
 * Another way to run Claude means an Anthropic key or a Claude sign-in on this computer, and then nothing is chosen for them.
 */
export function modelFromSavedKeys(agentType: string): string | undefined {
  if (agentType !== 'claude') return undefined;
  try {
    const store = resolveSecretStore();
    if (!(process.env.DEEPSEEK_API_KEY || store.get('DEEPSEEK_API_KEY'))) return undefined;
    if (process.env.ANTHROPIC_API_KEY || store.get('ANTHROPIC_API_KEY')) return undefined;
    if (existsSync(path.join(getHomeDir(), '.claude', '.credentials.json'))) return undefined;
    return 'deepseek-flash';
  } catch {
    return undefined;
  }
}
