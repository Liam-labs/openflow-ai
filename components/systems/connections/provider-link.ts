// These names match the model-features provider registry and the private secret store.
export const KEY_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', secretName: 'ANTHROPIC_API_KEY' },
  { id: 'deepseek', label: 'DeepSeek', secretName: 'DEEPSEEK_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', secretName: 'OPENROUTER_API_KEY' },
  { id: 'xai', label: 'xAI (Grok)', secretName: 'XAI_API_KEY' },
  { id: 'openai', label: 'OpenAI', secretName: 'OPENAI_API_KEY' },
] as const;

export const PROVIDER_PREFIX = 'model-provider-';
export function keyProvider(id: string | null) {
  return KEY_PROVIDERS.find(provider => provider.id === id);
}

/** Accept only a local absolute path, including after URL normalization. */
export function resumeDestination(search: string): string | null {
  const params = new URLSearchParams(search);
  const path = params.get('returnTo');
  const resume = params.get('resume');
  if (!path || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(path)) return null;
  // Parsing base only: no network request is made.
  const base = 'http://localhost';
  try {
    const url = new URL(path, base);
    if (url.origin !== base || url.pathname.startsWith('//')) return null;
    if (resume && /^[a-z0-9][a-z0-9-]{0,99}$/.test(resume)) url.searchParams.set('resume', resume);
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
