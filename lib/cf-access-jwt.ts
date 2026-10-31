/**
 * Check a Cloudflare Access sign-in token (the Cf-Access-Jwt-Assertion header) before believing anything in it.
 *
 * A request that carries the tunnel secret proves it came through our tunnel. It does NOT prove who signed in: the token's email
 * is only trustworthy if Cloudflare signed it, so this module verifies the RS256 signature against the team's published keys
 * (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs), the issuer, the audience of OUR Access application, and the dates.
 *
 * Settings (environment), both required, otherwise no identity is accepted from the token:
 *   WEBGATE_ACCESS_TEAM_DOMAIN   <team>.cloudflareaccess.com (Zero Trust > Settings > Custom pages > team domain)
 *   WEBGATE_ACCESS_AUD           the application's Audience tag; several, comma separated, when more than one application points here
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'crypto';

export interface AccessConfig {
  teamDomain: string;
  audiences: string[];
}

type Env = Record<string, string | undefined>;
type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string };
export type FetchKeys = (url: string) => Promise<{ keys?: Jwk[] }>;

const TEAM_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const KEY_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_KEY_REFETCH_MS = 60 * 1000;
const LEEWAY_SECONDS = 60;
const MAX_TOKEN_CHARS = 8192;

export function accessConfigFromEnv(env: Env = process.env): AccessConfig | null {
  const teamDomain = (env.WEBGATE_ACCESS_TEAM_DOMAIN || '').trim().toLowerCase();
  const audiences = (env.WEBGATE_ACCESS_AUD || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!TEAM_DOMAIN_RE.test(teamDomain) || !audiences.length) return null;
  return { teamDomain, audiences };
}

async function defaultFetchKeys(url: string): Promise<{ keys?: Jwk[] }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store', redirect: 'error' });
  if (!res.ok) throw new Error(`key download answered ${res.status}`);
  const text = await res.text();
  if (text.length > 1_000_000) throw new Error('key download is too large');
  return JSON.parse(text);
}

interface KeyCache { keys: Map<string, KeyObject>; fetchedAt: number; }
const caches = new Map<string, KeyCache>();

/** Forget downloaded keys (tests). */
export function clearAccessKeyCache(): void { caches.clear(); }

async function keyFor(config: AccessConfig, kid: string, fetchKeys: FetchKeys, now: number): Promise<KeyObject | null> {
  let cache = caches.get(config.teamDomain);
  const fresh = cache && now - cache.fetchedAt < KEY_TTL_MS;
  if (fresh && cache!.keys.has(kid)) return cache!.keys.get(kid)!;
  // Download again when the keys are old, or when the token names a key we do not have (Cloudflare rotates keys), at most once a minute.
  if (!cache || !fresh || now - cache.fetchedAt >= UNKNOWN_KEY_REFETCH_MS) {
    const body = await fetchKeys(`https://${config.teamDomain}/cdn-cgi/access/certs`);
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || !jwk.n || !jwk.e) continue;
      try { keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' })); } catch { /* one unreadable key does not hide the others */ }
    }
    cache = { keys, fetchedAt: now };
    caches.set(config.teamDomain, cache);
  }
  return cache.keys.get(kid) ?? null;
}

function parsePart(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf-8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch { return null; }
}

/** The token's claims when Cloudflare signed it for one of OUR applications and it has not expired; otherwise null. Never throws. */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig | null,
  deps: { fetchKeys?: FetchKeys; nowMs?: () => number } = {},
): Promise<Record<string, unknown> | null> {
  try {
    if (!config || !token || token.length > MAX_TOKEN_CHARS) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
    const header = parsePart(parts[0]);
    const claims = parsePart(parts[1]);
    if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    const nowMs = (deps.nowMs ?? Date.now)();
    const key = await keyFor(config, header.kid, deps.fetchKeys ?? defaultFetchKeys, nowMs);
    if (!key) return null;
    const signed = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!signed) return null;
    const nowSeconds = Math.floor(nowMs / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_SECONDS < nowSeconds) return null;
    if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_SECONDS > nowSeconds) return null;
    if (claims.iss !== `https://${config.teamDomain}`) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((a) => typeof a === 'string' && config.audiences.includes(a))) return null;
    return claims;
  } catch {
    return null;
  }
}
