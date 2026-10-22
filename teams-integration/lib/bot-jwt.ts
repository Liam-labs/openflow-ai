/**
 * Check the token Microsoft's Bot Framework sends with every message to the Teams bot endpoint.
 *
 * The endpoint is public (Microsoft has to reach it), so this check is the only thing between the internet and the chat.
 * A token is accepted only when ALL of these hold:
 *   - it is a three-part JWT signed with RS256 (never "none", never an HMAC);
 *   - the signature verifies against a key Microsoft publishes (the Bot Framework key set for tokens issued by
 *     https://api.botframework.com, the Entra ID key set for tokens issued by one of OUR configured tenants);
 *   - the audience is this bot's app id, and it has not expired.
 * Keys are cached for a day and fetched again, at most every 5 minutes, when a token names a key we do not have.
 *
 * Pure of the app: the clock and the key download are passed in, so it is tested with keys made on the spot.
 */
import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'crypto';

export const BOT_FRAMEWORK_KEYS = 'https://login.botframework.com/v1/.well-known/keys';
export const ENTRA_KEYS = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';

const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const REFETCH_AFTER_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 300;
const MAX_KEY_DOWNLOAD = 4_000_000;                       // the Bot Framework key set is about 0.9 MB (266 keys)
const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ENTRA_ISSUERS = [new RegExp('^https://login\\.microsoftonline\\.com/' + GUID + '/v2\\.0/?$'), new RegExp('^https://sts\\.windows\\.net/' + GUID + '/?$')];
const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';

export type FetchJson = (url: string) => Promise<unknown>;
export interface Verdict {
  ok: boolean;
  reason?: string;
}

interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  n?: string;
  e?: string;
}

const keyCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

export function resetBotKeyCacheForTests(): void {
  keyCache.clear();
  inFlight.clear();
  failures.clear();
}

async function defaultFetchJson(url: string): Promise<unknown> {
  if (!url.startsWith('https://')) throw new Error('key URL is not https');
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('key download answered ' + response.status);
  const text = await response.text();
  if (text.length > MAX_KEY_DOWNLOAD) throw new Error('key download too large');
  return JSON.parse(text);
}

const inFlight = new Map<string, Promise<Jwk[]>>();
const failures = new Map<string, { at: number; message: string }>();
const FAILURE_BACKOFF_MS = 30 * 1000;

async function download(url: string, fetchJson: FetchJson, now: number): Promise<Jwk[]> {
  const failed = failures.get(url);
  if (failed && now - failed.at < FAILURE_BACKOFF_MS) throw new Error(failed.message + ' (not retried for 30 s)');
  // One download at a time per key set: a burst of forged tokens must not become a burst of 1 MB downloads.
  const running = inFlight.get(url);
  if (running) return running;
  const job = (async () => {
    try {
      const body = (await fetchJson(url)) as { keys?: unknown };
      const keys = Array.isArray(body?.keys) ? (body.keys as Jwk[]).filter((k) => k && k.kty === 'RSA' && typeof k.kid === 'string' && typeof k.n === 'string' && typeof k.e === 'string') : [];
      if (keys.length === 0) throw new Error('key set is empty');
      keyCache.set(url, { keys, fetchedAt: now });
      failures.delete(url);
      return keys;
    } catch (error) {
      failures.set(url, { at: now, message: error instanceof Error ? error.message : 'error' });
      throw error;
    } finally {
      inFlight.delete(url);
    }
  })();
  inFlight.set(url, job);
  return job;
}

async function keysFor(url: string, fetchJson: FetchJson, now: number, force: boolean): Promise<Jwk[]> {
  const cached = keyCache.get(url);
  const fresh = cached && now - cached.fetchedAt < KEY_TTL_MS;
  if (cached && fresh && !force) return cached.keys;
  if (cached && force && now - cached.fetchedAt < REFETCH_AFTER_MS) return cached.keys;
  return download(url, fetchJson, now);
}

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The key set that may sign a token from this issuer, or null when the issuer is not one we accept. Tokens from the Bot Framework
 * itself are always fine. An Entra token (any app registered in a tenant can mint one for this bot's id) is accepted only from a
 * tenant listed in `entraTenants`; with none listed no Entra token is accepted.
 */
export function keySetForIssuer(issuer: string, entraTenants: string[] = []): string | null {
  if (issuer === BOT_FRAMEWORK_ISSUER) return BOT_FRAMEWORK_KEYS;
  const m = ENTRA_ISSUERS.map((pattern) => pattern.exec(issuer)).find(Boolean);
  if (!m) return null;
  const tenant = (/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.exec(issuer) || [''])[0].toLowerCase();
  return entraTenants.map((t) => t.trim().toLowerCase()).filter(Boolean).includes(tenant) ? ENTRA_KEYS : null;
}

export async function verifyBotJwt(token: string, options: { audiences: string[]; entraTenants?: string[]; serviceUrl?: string; fetchJson?: FetchJson; nowMs?: number }): Promise<Verdict> {
  const now = options.nowMs ?? Date.now();
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const audiences = options.audiences.filter(Boolean);
  if (audiences.length === 0) return { ok: false, reason: 'no bot app id is configured, so no token can be checked' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'not a JWT' };
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (!header || !claims) return { ok: false, reason: 'unreadable header or claims' };
  if (header.alg !== 'RS256') return { ok: false, reason: 'algorithm is not RS256' };
  if (typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'no key id' };
  const issuer = typeof claims.iss === 'string' ? claims.iss : '';
  const keyUrl = keySetForIssuer(issuer, options.entraTenants);
  if (!keyUrl) return { ok: false, reason: 'issuer is not the Bot Framework or a configured tenant' };

  let keys: Jwk[];
  try {
    keys = await keysFor(keyUrl, fetchJson, now, false);
    if (!keys.some((k) => k.kid === header.kid)) keys = await keysFor(keyUrl, fetchJson, now, true);
  } catch (error) {
    return { ok: false, reason: 'could not get Microsoft signing keys: ' + (error instanceof Error ? error.message : 'error') };
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown signing key' };
  let valid = false;
  try {
    const publicKey = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e } as JsonWebKey, format: 'jwk' });
    valid = cryptoVerify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), publicKey, Buffer.from(parts[2], 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'signature does not verify' };

  const nowSeconds = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < nowSeconds) return { ok: false, reason: 'token expired or has no expiry' };
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS)) return { ok: false, reason: 'token not valid yet' };
  const aud = claims.aud;
  const tokenAudiences: string[] = Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : typeof aud === 'string' ? [aud] : [];
  if (!tokenAudiences.some((a) => audiences.includes(a))) return { ok: false, reason: 'audience is not this bot' };
  // Bot Framework tokens name the service address they were issued for; a message that claims another one is not theirs.
  if (typeof claims.serviceurl === 'string' && options.serviceUrl && claims.serviceurl.replace(/\/+$/, '') !== options.serviceUrl.replace(/\/+$/, '')) {
    return { ok: false, reason: 'serviceUrl does not match the token' };
  }
  return { ok: true };
}
