/**
 * "Check" for a saved or pasted key: one harmless read-only request to the provider's own address.
 * The address is fixed in this file (never taken from the request), the key goes only in the header,
 * and nothing returned here ever contains the key.
 */
import type { KeyTestId } from '@/lib/connectors/catalog';

export interface KeyTestResult { ok: boolean; message: string }
type Fetch = typeof fetch;

interface Probe {
  provider: string;
  url: string;
  header: (key: string) => Record<string, string>;
  /** A response that is not 2xx but still proves the key is real. */
  acceptable?: (status: number, body: string) => string | null;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

export const PROBES: Record<KeyTestId, Probe> = {
  openrouter: { provider: 'OpenRouter', url: 'https://openrouter.ai/api/v1/auth/key', header: bearer },
  xai: { provider: 'xAI', url: 'https://api.x.ai/v1/models', header: bearer },
  deepseek: { provider: 'DeepSeek', url: 'https://api.deepseek.com/models', header: bearer },
  openai: { provider: 'OpenAI', url: 'https://api.openai.com/v1/models', header: bearer },
  replicate: { provider: 'Replicate', url: 'https://api.replicate.com/v1/account', header: bearer },
  typesafe: { provider: 'TypeSafe', url: 'https://api.typesafe.ai/v1/models', header: bearer },
  pexels: { provider: 'Pexels', url: 'https://api.pexels.com/v1/curated?per_page=1', header: (key) => ({ Authorization: key }) },
  resend: {
    provider: 'Resend',
    url: 'https://api.resend.com/domains',
    header: bearer,
    acceptable: (status, body) => (status === 401 && /restricted_api_key/.test(body) ? 'The key is valid. It can only send email, which is what most apps need.' : null),
  },
};

export async function testKey(id: KeyTestId, key: string, doFetch: Fetch = fetch): Promise<KeyTestResult> {
  const probe = PROBES[id];
  if (!probe) return { ok: false, message: 'There is no check for this connector.' };
  try {
    const res = await doFetch(probe.url, {
      method: 'GET',
      headers: { ...probe.header(key), Accept: 'application/json', 'User-Agent': 'openflow-setup' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (res.ok) return { ok: true, message: `${probe.provider} accepted the key.` };
    if (res.status === 429) return { ok: true, message: `${probe.provider} is rate limiting right now, but it recognised the key.` };
    const body = probe.acceptable ? await res.text().catch(() => '') : '';
    const special = probe.acceptable?.(res.status, body);
    if (special) return { ok: true, message: special };
    if (res.status === 401 || res.status === 403) return { ok: false, message: `${probe.provider} did not accept this key. Check you copied all of it.` };
    return { ok: false, message: `${probe.provider} answered with an error (${res.status}). Try again in a minute.` };
  } catch {
    return { ok: false, message: `Could not reach ${probe.provider}. Check this computer's internet connection.` };
  }
}
