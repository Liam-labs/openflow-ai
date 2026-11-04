/**
 * How the skill router reaches Jev (TypeSafe System One), and whether it can.
 *
 * Two routes, same answer shape:
 *   gateway  DevFlow's own MCP gateway holds the key (the default on a full DevFlow install).
 *   key      a TypeSafe key saved through Systems > Connections (OpenFlow), sent straight to api.typesafe.ai.
 * With neither, the router is unavailable: it cannot be switched on and does nothing.
 */
import { getConnectorKey } from '@/lib/connectors/secrets';

export type JevCall = (args: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;

export const JEV_MODEL = 'jev-1.13.0'; // pinned: the scorer's weights were fitted on this model
const GATEWAY_URL = () => process.env.DEVFLOW_JEV_URL ?? '';
const DIRECT_URL = 'https://api.typesafe.ai/v1/systemone';
export const KEY_ENV = 'TYPESAFE_API_KEY';

export const gatewayJev: JevCall = async (args, signal) => {
  const res = await fetch(GATEWAY_URL(), {
    method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', signal,
    body: JSON.stringify({ tool: 'typesafe_system_one', arguments: { caller: 'skill-router', model: JEV_MODEL, ...args } }),
  });
  const data = await res.json().catch(() => null) as { ok?: boolean; result?: { answers?: Record<string, unknown> } } | null;
  if (!res.ok || !data?.ok || !data.result?.answers) throw new Error(`gateway ${res.status}`);
  return data.result.answers;
};

/** Straight to TypeSafe with the user's own key. The key goes only in the header and never into a log or an error. */
export function directJev(key: string): JevCall {
  return async (args, signal) => {
    const res = await fetch(DIRECT_URL, {
      method: 'POST', cache: 'no-store', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: JEV_MODEL, state: args.state, questions: args.questions }),
    });
    const data = await res.json().catch(() => null) as { answers?: Record<string, unknown> } | null;
    if (!res.ok || !data?.answers) throw new Error(`typesafe ${res.status}`);
    return data.answers;
  };
}

export interface JevConnection {
  available: boolean;
  via: 'gateway' | 'key' | null;
  /** Plain words for the person who has to fix it. */
  reason?: string;
}

async function gatewayConfigured(): Promise<boolean> {
  if (!GATEWAY_URL()) return false;
  try {
    const res = await fetch(GATEWAY_URL(), {
      method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(1500),
      body: JSON.stringify({ tool: 'typesafe_status', arguments: {} }),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; result?: { configured?: boolean } } | null;
    return !!(res.ok && data?.ok && data.result?.configured === true);
  } catch { return false; }
}

async function savedKey(): Promise<string | null> {
  const fromEnv = process.env[KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  return getConnectorKey(KEY_ENV)?.trim() || null;
}

async function probeReal(): Promise<JevConnection> {
  if (await gatewayConfigured()) return { available: true, via: 'gateway' };
  if (await savedKey()) return { available: true, via: 'key' };
  return { available: false, via: null, reason: 'Connect TypeSafe Jev in Systems > Connections first. Skill hints cannot run without it.' };
}

let probe: () => Promise<JevConnection> = probeReal;
let cached: { at: number; value: JevConnection } | null = null;
let generation = 0;
export function setConnectionProbeForTests(p: (() => Promise<JevConnection>) | null): void { probe = p ?? probeReal; cached = null; generation++; }
export function resetConnectionCacheForTests(): void { cached = null; generation++; }

/** Whether Jev can be reached, and by which route. Cached for 30 seconds; a failed check is cached too, so an outage costs one probe. */
export async function jevConnection(): Promise<JevConnection> {
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  const started = generation;
  const value = await probe().catch((): JevConnection => ({ available: false, via: null, reason: 'The Jev connection could not be checked.' }));
  // A probe that was replaced while it ran must not overwrite the cache with its stale answer.
  if (started === generation) cached = { at: Date.now(), value };
  return value;
}

/** The call function for the current connection, or null when there is none. */
export async function resolveJev(): Promise<JevCall | null> {
  const c = await jevConnection();
  if (!c.available) return null;
  if (c.via === 'gateway') return gatewayJev;
  const key = await savedKey();
  return key ? directJev(key) : null;
}
