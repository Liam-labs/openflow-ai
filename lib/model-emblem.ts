// Which animated emblem an agent gets, and which motion it plays.
// Pure functions so the mapping is tested without a browser.

export type EmblemFamily = 'claude' | 'openai' | 'gemini' | 'grok' | 'deepseek';
export type EmblemState = 'idle' | 'thinking' | 'tool' | 'writing';

export function emblemFamily(modelId: string | undefined | null): EmblemFamily | null {
  if (!modelId) return null;
  const m = modelId.toLowerCase();
  if (m.startsWith('deepseek') || m === 'v4') return 'deepseek';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('grok')) return 'grok';
  if (/gpt|openai/.test(m)) return 'openai';
  return 'claude';
}

/**
 * What the agent is doing right now. `activity` is the live presence value
 * ('typing' | 'working'); `detail` is the granular label ("Reading file…",
 * "Thinking…", "Running command…"). Not working at all means idle.
 */
export function emblemState(
  activity: 'typing' | 'working' | null | undefined,
  detail: string | null | undefined,
): EmblemState {
  if (!activity) return 'idle';
  if (activity === 'typing') return 'writing';
  const d = (detail ?? '').toLowerCase().trim();
  if (!d || /think|reason|plan|ponder/.test(d)) return 'thinking';
  if (/writ|respond|repl|compos|draft|typing/.test(d)) return 'writing';
  return 'tool';
}
