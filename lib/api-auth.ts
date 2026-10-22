/**
 * API Token Authentication Utilities
 *
 * Provides token generation, validation, and rate limiting for the Agent API.
 * Tokens are stored as SHA-256 hashes - never in plaintext.
 */

import { createHash, randomBytes } from 'crypto';
import { hostname, networkInterfaces } from 'os';
import { NextRequest, NextResponse } from 'next/server';
import { DataPaths } from './data-paths';
import { readJsonFileStrict, JsonFileCorruptError, writeJsonFile, withFileLock } from './data-io';
import { allowLocalTrust, listensOnLoopbackOnly } from './local-trust';
import type {
  ApiToken,
  ApiTokenScope,
  ApiTokensData,
  ApiTokenValidationResult,
  AgentAuthContext,
  AgentApiErrorCode,
  AgentApiResponse,
} from './types';

// Constants
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
const RATE_LIMIT_MAX = 100;              // 100 requests per window
const FAILED_ATTEMPT_LIMIT = 5;          // Lock after 5 failures
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7-day TTL for unused tokens
const MAX_TOKENS = 50;                   // Hard cap on total active tokens

// Base62 alphabet for token generation (URL-safe, no special chars)
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Get the DevFlow API token from the environment.
 * Checks DEVFLOW_API_TOKEN first (standard), falls back to DEVFLOW_FULL_ACCESS_TOKEN (legacy).
 * Returns empty string if neither is set.
 */
export function getDevFlowApiToken(): string {
  return process.env.DEVFLOW_API_TOKEN || process.env.DEVFLOW_FULL_ACCESS_TOKEN || '';
}

/**
 * Encode bytes to base62 string
 */
function base62Encode(bytes: Buffer): string {
  let num = BigInt('0x' + bytes.toString('hex'));
  let result = '';
  const base = BigInt(62);

  while (num > 0) {
    const remainder = Number(num % base);
    result = BASE62_CHARS[remainder] + result;
    num = num / base;
  }

  // Pad to consistent length
  while (result.length < 43) {
    result = '0' + result;
  }

  return result;
}

/**
 * Generate a new API token
 * Returns both the plaintext token (show once) and its hash (store)
 */
export function generateToken(isProduction: boolean = true): { token: string; hash: string; prefix: string } {
  const prefix = isProduction ? 'dvf_live_' : 'dvf_test_';
  const randomPart = randomBytes(32);
  const tokenBody = base62Encode(randomPart);
  const token = prefix + tokenBody;
  const hash = hashToken(token);

  return { token, hash, prefix: prefix.slice(0, 8) };
}

/**
 * Hash a token using SHA-256
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Get client IP from request
 */
export function getClientIp(request: NextRequest): string {
  // Check various headers for proxied requests
  // The LAST entry is the one the nearest proxy added (Cloudflare appends the address it saw). The first is whatever the sender wrote.
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const entries = forwarded.split(',').map((e) => e.trim()).filter(Boolean);
    if (entries.length) return entries[entries.length - 1];
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  // Fallback to localhost for local development
  return '127.0.0.1';
}

/**
 * Default tokens data structure
 */
function getDefaultTokensData(): ApiTokensData {
  return {
    tokens: [],
    config: {
      maxTokensPerUser: 10,
      defaultExpiration: 0, // Never
      requireExpiration: false,
      rateLimitWindow: 60,
      rateLimitMax: 100,
    },
    rateLimits: {},
    failedAttempts: {},
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Load tokens data from file
 */
export async function loadTokensData(): Promise<ApiTokensData> {
  // Strict: an unreadable token store is an error (a copy is kept), never "no tokens" that the next write would save over it.
  return readJsonFileStrict<ApiTokensData>(DataPaths.apiTokens, getDefaultTokensData());
}

/**
 * Save tokens data to file
 */
export async function saveTokensData(data: ApiTokensData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await writeJsonFile(DataPaths.apiTokens, data);
}

/**
 * Check if IP is blocked due to too many failed attempts
 */
async function isIpBlocked(ip: string, data: ApiTokensData): Promise<boolean> {
  const attempts = data.failedAttempts[ip];
  if (!attempts) return false;

  const now = Date.now();
  const windowExpired = now - attempts.lastAttempt > FAILED_ATTEMPT_WINDOW_MS;

  if (windowExpired) {
    // Clear expired attempts
    delete data.failedAttempts[ip];
    return false;
  }

  return attempts.count >= FAILED_ATTEMPT_LIMIT;
}

/**
 * Record a failed authentication attempt — locked read-modify-write
 */
async function recordFailedAttempt(ip: string): Promise<void> {
  await withFileLock(DataPaths.apiTokens, async () => {
    const data = await loadTokensData();
    const now = Date.now();
    const existing = data.failedAttempts[ip];

    if (existing) {
      // Reset if window expired
      if (now - existing.lastAttempt > FAILED_ATTEMPT_WINDOW_MS) {
        data.failedAttempts[ip] = { count: 1, firstAttempt: now, lastAttempt: now };
      } else {
        existing.count++;
        existing.lastAttempt = now;
      }
    } else {
      data.failedAttempts[ip] = { count: 1, firstAttempt: now, lastAttempt: now };
    }

    await saveTokensData(data);
    if (data.failedAttempts[ip].count === FAILED_ATTEMPT_LIMIT) {
      console.warn(`[api-auth] ${ip} is locked out for ${FAILED_ATTEMPT_WINDOW_MS / 60000} minutes: ${FAILED_ATTEMPT_LIMIT} unknown or revoked tokens in a row`);
    }
  });
}

const rejectedLoggedAt = new Map<string, number>();                                   // `${address}|${fingerprint}` -> when last logged
const rejectedPerAddress = new Map<string, { windowStart: number; logged: number; suppressed: number }>();
const REJECTED_LOG_EVERY_MS = 30 * 1000;       // one line per sender and token fingerprint per 30 s
const REJECTED_LOG_PER_ADDRESS = 20;           // and at most this many lines per address per minute, however many tokens it tries
const REJECTED_LOG_WINDOW_MS = 60 * 1000;
const REJECTED_LOG_MAX_KEYS = 500;

/** Header text is the caller's data, not a log format: printable ASCII only, one line, capped. */
function logSafe(value: string | null | undefined, max: number): string {
  return (value ?? '').replace(/[^\x20-\x7e]/g, '?').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Oldest entries go first, so a flood cannot make the throttle forget everyone else at once. */
function trimOldest<V>(map: Map<string, V>): void {
  while (map.size > REJECTED_LOG_MAX_KEYS) map.delete(map.keys().next().value as string);
}

/**
 * Say who sent a token DevFlow does not accept: one line per address and token fingerprint per 30 s, at most 20 lines a minute per address.
 * DevFlow kept no record of rejected tokens, so on 19 Oct 2026 five of them (09:37:14Z) locked the whole desktop out and nothing could say
 * who sent them. For a token in our format the line names its fingerprint: the first 8 hex digits of the SHA-256 of the token, enough to match
 * against a token file, nothing that can be used as a token. A token NOT in our format may be something else the caller keeps secret (a password
 * sent by mistake), and 32 bits of its hash would let anyone holding the log confirm a dictionary guess, so only its length is written. The
 * address is whatever the caller's X-Forwarded-For says, so the line also carries that header and the user agent (python-urllib, aiohttp,
 * node ...), which usually names the sender even when the address is shared or forged.
 */
function noteRejectedToken(request: NextRequest, ip: string, tokenNote: string, trusted: boolean, why = 'unknown or revoked token'): void {
  const address = logSafe(ip, 64);
  const key = `${address}|${tokenNote}|${why}`;
  const now = Date.now();
  if (now - (rejectedLoggedAt.get(key) ?? 0) < REJECTED_LOG_EVERY_MS) return;
  let budget = rejectedPerAddress.get(address);
  if (!budget || now - budget.windowStart >= REJECTED_LOG_WINDOW_MS) {
    budget = { windowStart: now, logged: 0, suppressed: 0 };
    rejectedPerAddress.delete(address);
    rejectedPerAddress.set(address, budget);
    trimOldest(rejectedPerAddress);
  }
  if (budget.logged >= REJECTED_LOG_PER_ADDRESS) {
    if (budget.suppressed++ === 0) {
      console.warn(`[api-auth] more than ${REJECTED_LOG_PER_ADDRESS} rejected tokens a minute from ${address}; the rest are left out of the log until the minute ends`);
    }
    return;
  }
  budget.logged++;
  rejectedLoggedAt.delete(key);
  rejectedLoggedAt.set(key, now);
  trimOldest(rejectedLoggedAt);
  console.warn(
    `[api-auth] ${why} from ${address} (${trusted ? 'trusted address, not counted towards a lock' : 'counted towards a lock'}), ` +
    `${tokenNote}, ${request.method} ${logSafe(request.nextUrl?.pathname, 120)}, ` +
    `x-forwarded-for "${logSafe(request.headers.get('x-forwarded-for'), 80)}", user-agent "${logSafe(request.headers.get('user-agent'), 48)}"`
  );
}

/**
 * Check if token is rate limited
 */
function isRateLimited(tokenHash: string, data: ApiTokensData): { limited: boolean; retryAfter?: number } {
  const now = Date.now();
  const rateLimit = data.rateLimits[tokenHash];
  const windowMs = (data.config.rateLimitWindow || 60) * 1000;
  const maxRequests = data.config.rateLimitMax || 100;

  if (!rateLimit) {
    return { limited: false };
  }

  const windowExpired = now - rateLimit.windowStart > windowMs;

  if (windowExpired) {
    return { limited: false };
  }

  if (rateLimit.requestCount >= maxRequests) {
    const retryAfter = Math.ceil((rateLimit.windowStart + windowMs - now) / 1000);
    return { limited: true, retryAfter };
  }

  return { limited: false };
}

/**
 * Update rate limit counter for token
 */
function updateRateLimit(tokenHash: string, data: ApiTokensData): void {
  const now = Date.now();
  const windowMs = (data.config.rateLimitWindow || 60) * 1000;
  const rateLimit = data.rateLimits[tokenHash];

  if (!rateLimit || now - rateLimit.windowStart > windowMs) {
    // Start new window
    data.rateLimits[tokenHash] = { windowStart: now, requestCount: 1 };
  } else {
    rateLimit.requestCount++;
  }
}

/**
 * Update token usage statistics (async, non-blocking)
 */
async function updateTokenUsage(tokenHash: string, ip: string): Promise<void> {
  try {
    await withFileLock(DataPaths.apiTokens, async () => {
      const data = await loadTokensData();
      const token = data.tokens.find(t => t.tokenHash === tokenHash);

      if (token) {
        token.lastUsedAt = new Date().toISOString();
        token.lastUsedIp = ip;
        token.usageCount++;
        await saveTokensData(data);
      }
    });
  } catch (error) {
    console.error('[api-auth] Failed to update token usage:', error);
  }
}

/**
 * Extract token from Authorization header or X-Api-Token header
 */
function extractToken(request: NextRequest): string | null {
  // Check Authorization: Bearer <token>
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check X-Api-Token header
  const apiTokenHeader = request.headers.get('X-Api-Token');
  if (apiTokenHeader) {
    return apiTokenHeader;
  }

  return null;
}

/**
 * Validate API token from request
 */
export async function validateApiToken(request: NextRequest): Promise<ApiTokenValidationResult> {
  const token = extractToken(request);

  if (!token) {
    return { valid: false, error: 'Missing API token', code: 'AUTH_MISSING' };
  }

  // An address this server trusts (itself, and tailnet peers while DEVFLOW_TRUST_TAILNET=1) is never locked out, and its unknown tokens are
  // logged but not counted. The whole desktop fleet reaches this server from ONE such address, so five unknown tokens from anything there
  // (a test run, a stale client) refused every agent's gate lookup and every token-checked write for 15 minutes (19 Oct 2026, 09:37Z). Those
  // callers are trusted without any token elsewhere (requireAuthOrLocal), so the lock protected nothing; it stays for addresses we do not trust.
  // Trust is decided from the very address the attempt is counted and logged under, so the two can never disagree (an X-Real-IP naming an
  // outside address with no X-Forwarded-For used to look "local" to isLocalRequest while being counted as that outside address).
  const clientIp = getClientIp(request);
  const trusted = isTrustedAddress(clientIp);

  // Validate token format
  if (!token.startsWith('dvf_')) {
    noteRejectedToken(request, clientIp, `length ${token.length}`, trusted, 'malformed token (no dvf_ prefix)');
    return { valid: false, error: 'Invalid token format', code: 'AUTH_INVALID' };
  }

  const tokenHash = hashToken(token);
  const tokenNote = `fingerprint ${tokenHash.slice(0, 8)}`;
  let data: ApiTokensData;
  try {
    data = await loadTokensData();
  } catch (error) {
    if (error instanceof JsonFileCorruptError) {
      return { valid: false, error: 'The token store is unreadable, so no token can be checked. A copy of the bad file was kept; restore or repair it.', code: 'TOKEN_STORE_UNREADABLE' };
    }
    throw error;
  }

  // Check if IP is blocked
  if (!trusted && await isIpBlocked(clientIp, data)) {
    noteRejectedToken(request, clientIp, tokenNote, false, 'token from a locked address');
    const last = data.failedAttempts[clientIp]?.lastAttempt ?? Date.now();
    return {
      valid: false,
      error: 'Too many failed attempts. Try again later.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: Math.max(1, Math.ceil((last + FAILED_ATTEMPT_WINDOW_MS - Date.now()) / 1000)),
    };
  }

  // Find matching token
  const tokenRecord = data.tokens.find(
    t => t.tokenHash === tokenHash && !t.revokedAt
  );

  if (!tokenRecord) {
    if (!trusted) await recordFailedAttempt(clientIp);
    noteRejectedToken(request, clientIp, tokenNote, trusted);
    return { valid: false, error: 'Invalid or revoked token', code: 'AUTH_INVALID' };
  }

  // Check expiration
  if (tokenRecord.expiresAt && new Date(tokenRecord.expiresAt) < new Date()) {
    return { valid: false, error: 'Token expired', code: 'AUTH_EXPIRED' };
  }

  // Check IP allowlist if configured
  if (tokenRecord.metadata?.allowedIps?.length) {
    if (!tokenRecord.metadata.allowedIps.includes(clientIp)) {
      return { valid: false, error: 'IP not allowed for this token', code: 'AUTH_INSUFFICIENT' };
    }
  }

  // Check rate limit
  const rateLimitResult = isRateLimited(tokenHash, data);
  if (rateLimitResult.limited) {
    return {
      valid: false,
      error: `Rate limit exceeded. Retry after ${rateLimitResult.retryAfter} seconds.`,
      code: 'RATE_LIMITED',
      retryAfterSeconds: rateLimitResult.retryAfter,
    };
  }

  // Update rate limit counter and usage stats — locked read-modify-write
  await withFileLock(DataPaths.apiTokens, async () => {
    const freshData = await loadTokensData();
    const freshToken = freshData.tokens.find(t => t.tokenHash === tokenHash && !t.revokedAt);
    if (freshToken) {
      updateRateLimit(tokenHash, freshData);
      freshToken.lastUsedAt = new Date().toISOString();
      freshToken.lastUsedIp = clientIp;
      freshToken.usageCount++;
      delete freshData.failedAttempts[clientIp];   // "five in a row": a good token ends the run, so stale tokens spread over an afternoon never add up to a lock
      await saveTokensData(freshData);
    }
  });

  return { valid: true, token: tokenRecord };
}

/**
 * Check if a scope has sufficient permissions
 * Hierarchy: admin > write > read
 */
export function hasPermission(tokenScope: ApiTokenScope, requiredScope: ApiTokenScope): boolean {
  const scopeLevel: Record<ApiTokenScope, number> = {
    read: 1,
    write: 2,
    admin: 3,
  };

  return scopeLevel[tokenScope] >= scopeLevel[requiredScope];
}

/**
 * Get all IP addresses assigned to this machine's network interfaces.
 * Cached at module load time. Used to trust hairpin/DNAT connections where
 * the machine accesses itself via its LAN IP (e.g. WSL2 mirrored mode + DNAT).
 *
 * Next.js sets x-forwarded-for from socket.remoteAddress (base-server.js),
 * which returns IPv6-mapped addresses like ::ffff:192.168.1.20 for IPv4.
 * We add both the plain IPv4 and the IPv6-mapped variant to LOCAL_IPS.
 */
function buildLocalIpSet(): Set<string> {
  const ips = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  try {
    const nets = networkInterfaces();
    for (const addrs of Object.values(nets)) {
      for (const addr of addrs ?? []) {
        ips.add(addr.address);
        // Add IPv6-mapped variant for IPv4 addresses
        // (Next.js base-server sets x-forwarded-for from socket.remoteAddress
        // which returns ::ffff:x.x.x.x form when server binds to ::)
        if (addr.family === 'IPv4') {
          ips.add(`::ffff:${addr.address}`);
        }
      }
    }
  } catch {
    // If networkInterfaces() fails, fall back to loopback-only
  }

  // WSL2 NAT mode: the Windows host connects via the default gateway IP.
  // Requests from Windows browser appear as x-forwarded-for: <gateway>.
  // The gateway IS the local machine — trust it.
  try {
    const { execSync } = require('child_process');
    const gw = execSync("ip route show default 2>/dev/null | awk '{print $3}'", { encoding: 'utf8', timeout: 2000 }).trim();
    if (gw && /^\d+\.\d+\.\d+\.\d+$/.test(gw)) {
      ips.add(gw);
      ips.add(`::ffff:${gw}`);
    }
  } catch {
    // Not on WSL2 or ip command unavailable — skip
  }

  return ips;
}

const LOCAL_IPS = buildLocalIpSet();

const MACHINE_NAME = (() => {
  try {
    return hostname();
  } catch {
    return '';
  }
})();

/**
 * Check if a request originates from localhost or this machine's own IP.
 * Returns true for direct connections and DNAT hairpin connections where
 * x-forwarded-for is set to the machine's own LAN IP by Next.js.
 *
 * In WSL2 mirrored mode with iptables DNAT, requests via 192.168.x.x still
 * originate from the same machine — Next.js sees the LAN IP in x-forwarded-for.
 */
export function isLocalRequest(request: NextRequest): boolean {
  const forwarded = request.headers.get('x-forwarded-for');
  // Every address in the chain must be this machine's (or a trusted tailnet peer): the sender can write the first entries
  // themselves ("X-Forwarded-For: 127.0.0.1"), a proxy adds the real one at the end.
  const fromThisMachine = forwarded ? forwarded.split(',').every((e) => isTrustedAddress(e.trim())) : true;   // no proxy header = direct connection
  if (!fromThisMachine) return false;
  if (process.env.DEVFLOW_REQUIRE_TOKEN === '1') return false;      // server installs: every request needs a token, even from this machine
  if (!listensOnLoopbackOnly(process.env)) return false;           // reachable from other computers: a caller can claim to be local, so every request needs a token
  // From this machine is not the same as from the owner: a web page in their browser, or a page on another site that
  // has been made to point at this machine, also arrives from here. lib/local-trust.ts tells them apart.
  return allowLocalTrust(
    { host: request.headers.get('host') || request.nextUrl?.host || null, origin: request.headers.get('origin'), secFetchSite: request.headers.get('sec-fetch-site'), path: request.nextUrl?.pathname || null },
    process.env,
    MACHINE_NAME,
  );
}

/** This machine's own addresses, and tailnet peers while DEVFLOW_TRUST_TAILNET=1: the addresses this server trusts without a token. */
function isTrustedAddress(ip: string): boolean {
  return LOCAL_IPS.has(ip) || isTrustedTailnetIp(ip);
}

/** Opt-in (DEVFLOW_TRUST_TAILNET=1): trust Tailscale peers, <tailnet-ip>/10. */
function isTrustedTailnetIp(ip: string): boolean {
  if (process.env.DEVFLOW_TRUST_TAILNET !== '1') return false;
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  return !!m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

/**
 * Check if a request came through the Cloudflare tunnel (webgate)
 * with a valid shared secret. The secret is injected by the tunnel
 * origin proxy and verified here to prevent header spoofing.
 *
 * If WEBGATE_TUNNEL_SECRET is not set, tunnel bypass is disabled entirely.
 */
export function isCloudflaredRequest(request: NextRequest): boolean {
  const secret = process.env.WEBGATE_TUNNEL_SECRET;
  if (!secret) return false; // No secret configured = tunnel bypass disabled

  const tunnelAuth = request.headers.get('x-tunnel-auth');
  if (!tunnelAuth) return false;

  // Timing-safe comparison to prevent timing attacks
  // Compare fixed-length digests so neither the content nor the length of the secret shows in the timing.
  const { timingSafeEqual, createHash } = require('crypto');
  return timingSafeEqual(createHash('sha256').update(tunnelAuth).digest(), createHash('sha256').update(secret).digest());
}

/**
 * A token over its rate limit (or an address blocked for repeated failures) is told so: 429 with Retry-After.
 * Until 18 Oct 2026 this fell through to the plain 401 "Authentication required", which looked like a bad token. The
 * shared agent token crossed its limit in bursts, and every agent's gate hook read the 401 as a failure and locked the shell.
 */
export function rateLimitedResponse(result: ApiTokenValidationResult): NextResponse<AgentApiResponse> {
  const retryAfter = Math.max(1, Math.ceil(result.retryAfterSeconds ?? 60));
  const response = errorResponse(result.error || 'Rate limit exceeded', 'RATE_LIMITED', 429, { retryAfter });
  response.headers.set('Retry-After', String(retryAfter));
  return response;
}

/**
 * Require either a valid API token or localhost origin.
 * Dashboard (localhost) passes through; external requests need Bearer auth.
 * Returns null if allowed, or an error NextResponse if denied.
 */
export async function requireAuthOrLocal(
  request: NextRequest,
  requiredScope: ApiTokenScope = 'read'
): Promise<NextResponse | null> {
  // Try Bearer token first
  const authResult = await validateApiToken(request);
  if (authResult.valid && authResult.token) {
    if (!hasPermission(authResult.token.scope, requiredScope)) {
      return errorResponse(
        `Scope '${requiredScope}' required`,
        'AUTH_INSUFFICIENT',
        403
      );
    }
    return null; // Allowed via token
  }

  // No valid token — allow if localhost, reject if external
  if (isLocalRequest(request)) {
    return null; // Allowed via localhost
  }

  // Allow access via Cloudflare tunnel (webgate) — private infrastructure
  if (isCloudflaredRequest(request)) {
    return null; // Allowed via webgate tunnel
  }

  if (authResult.code === 'RATE_LIMITED') return rateLimitedResponse(authResult);

  return errorResponse(
    'Authentication required',
    'AUTH_MISSING',
    401
  );
}

/**
 * Require either a valid API token or a strict localhost origin.
 * Unlike requireAuthOrLocal, this does NOT allow the Cloudflare tunnel bypass.
 * Use for highly sensitive endpoints (WSL restart, secrets write) where a valid
 * Bearer token is required from any non-localhost origin.
 * Returns null if allowed, or an error NextResponse if denied.
 */
export async function requireTokenOrLocal(
  request: NextRequest,
  requiredScope: ApiTokenScope = 'read'
): Promise<NextResponse | null> {
  // Try Bearer token first
  const authResult = await validateApiToken(request);
  if (authResult.valid && authResult.token) {
    if (!hasPermission(authResult.token.scope, requiredScope)) {
      return errorResponse(
        `Scope '${requiredScope}' required`,
        'AUTH_INSUFFICIENT',
        403
      );
    }
    return null; // Allowed via token
  }

  // No valid token — allow only if localhost (no Cloudflare bypass)
  if (isLocalRequest(request)) {
    return null; // Allowed via localhost
  }

  if (authResult.code === 'RATE_LIMITED') return rateLimitedResponse(authResult);

  return errorResponse(
    'Authentication required',
    'AUTH_MISSING',
    401
  );
}

/**
 * Create an error response
 */
export function errorResponse(
  error: string,
  code: AgentApiErrorCode,
  status: number,
  details?: Record<string, unknown>,
  requestId?: string
): NextResponse<AgentApiResponse> {
  const response: AgentApiResponse = {
    success: false,
    error,
    code,
    timestamp: new Date().toISOString(),
  };

  if (requestId) {
    response.requestId = requestId;
  }

  if (details) {
    response.data = details;
  }

  return NextResponse.json(response, { status });
}

/**
 * Create a success response
 */
export function successResponse(
  data: unknown,
  requestId?: string,
  timing?: number
): NextResponse<AgentApiResponse> {
  const response: AgentApiResponse = {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };

  if (requestId) response.requestId = requestId;
  if (timing) response.timing = timing;

  return NextResponse.json(response);
}

/**
 * Higher-order function to protect API routes with token auth
 */
export function withApiAuth(
  requiredScope: ApiTokenScope,
  handler: (request: NextRequest, auth: AgentAuthContext) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const authResult = await validateApiToken(request);

    if (!authResult.valid || !authResult.token) {
      if (authResult.code === 'RATE_LIMITED') return rateLimitedResponse(authResult);
      return errorResponse(
        authResult.error || 'Authentication failed',
        authResult.code || 'AUTH_INVALID',
        401
      );
    }

    // Check scope hierarchy
    if (!hasPermission(authResult.token.scope, requiredScope)) {
      return errorResponse(
        'Insufficient permissions',
        'AUTH_INSUFFICIENT',
        403,
        { required: requiredScope, available: authResult.token.scope }
      );
    }

    const authContext: AgentAuthContext = {
      tokenId: authResult.token.id,
      tokenName: authResult.token.name,
      scope: authResult.token.scope,
      createdBy: authResult.token.createdBy,
    };

    return handler(request, authContext);
  };
}

/**
 * Prune stale API tokens:
 * - Removes tokens not used in 7 days (unless marked keepAlive)
 * - Revoked tokens are left as-is (audit trail)
 * Returns count of pruned tokens and their names.
 */
export async function pruneStaleTokens(): Promise<{ pruned: number; names: string[] }> {
  return withFileLock(DataPaths.apiTokens, async () => {
  const data = await loadTokensData();
  const now = Date.now();
  const names: string[] = [];
  const surviving: ApiToken[] = [];

  for (const token of data.tokens) {
    // Keep revoked tokens (audit trail)
    if (token.revokedAt) {
      surviving.push(token);
      continue;
    }

    // Keep tokens with keepAlive flag
    if (token.metadata?.keepAlive) {
      surviving.push(token);
      continue;
    }

    // Check last activity: prefer lastUsedAt, fall back to createdAt
    const lastActivity = token.lastUsedAt || token.createdAt;
    const age = now - new Date(lastActivity).getTime();

    if (age > TOKEN_TTL_MS) {
      names.push(`${token.name} (last used: ${token.lastUsedAt ?? 'never, created ' + token.createdAt.slice(0, 10)})`);
      // Clean up associated rate limit data
      delete data.rateLimits[token.tokenHash];
    } else {
      surviving.push(token);
    }
  }

  const pruned = data.tokens.length - surviving.length;
  if (pruned > 0) {
    data.tokens = surviving;
    await saveTokensData(data);
    console.log(`[api-auth] Pruned ${pruned} stale token(s): ${names.join('; ')}`);
  }

  return { pruned, names };
  }); // end withFileLock
}

/**
 * Create a new token and store it
 */
export async function createToken(
  name: string,
  scope: ApiTokenScope,
  createdBy: string,
  options?: {
    expiresInDays?: number;
    description?: string;
    environment?: 'production' | 'development' | 'testing';
    allowedIps?: string[];
    keepAlive?: boolean;
  }
): Promise<{ token: string; record: ApiToken }> {
  // Generate token before acquiring lock (no I/O needed)
  const isProduction = options?.environment !== 'development' && options?.environment !== 'testing';
  const { token, hash, prefix } = generateToken(isProduction);

  const record = await withFileLock(DataPaths.apiTokens, async () => {
    const data = await loadTokensData();

    // Enforce 50-token cap (revoked tokens don't count)
    const activeTokens = data.tokens.filter(t => !t.revokedAt);
    if (activeTokens.length >= MAX_TOKENS) {
      throw new Error(`Token limit reached (${MAX_TOKENS} active tokens). Revoke unused tokens before creating new ones.`);
    }

    const expiresAt = options?.expiresInDays && options.expiresInDays > 0
      ? new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const r: ApiToken = {
      id: crypto.randomUUID(),
      name,
      tokenHash: hash,
      tokenPrefix: prefix,
      scope,
      createdAt: new Date().toISOString(),
      createdBy,
      expiresAt,
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
      revokedBy: null,
      usageCount: 0,
      metadata: {
        description: options?.description,
        environment: options?.environment,
        allowedIps: options?.allowedIps,
        keepAlive: options?.keepAlive,
      },
    };

    data.tokens.push(r);
    await saveTokensData(data);
    return r;
  });

  return { token, record };
}

/**
 * Revoke a token by ID
 */
export async function revokeToken(
  tokenId: string,
  revokedBy: string
): Promise<{ success: boolean; error?: string }> {
  return withFileLock(DataPaths.apiTokens, async () => {
    const data = await loadTokensData();
    const token = data.tokens.find(t => t.id === tokenId);

    if (!token) {
      return { success: false, error: 'Token not found' };
    }

    if (token.revokedAt) {
      return { success: false, error: 'Token already revoked' };
    }

    token.revokedAt = new Date().toISOString();
    token.revokedBy = revokedBy;

    // Clear rate limit data for this token
    delete data.rateLimits[token.tokenHash];

    await saveTokensData(data);

    return { success: true };
  });
}

/**
 * List all tokens (without hashes)
 */
export async function listTokens(): Promise<Array<Omit<ApiToken, 'tokenHash'> & { isRevoked: boolean }>> {
  const data = await loadTokensData();

  return data.tokens.map(t => ({
    id: t.id,
    name: t.name,
    tokenPrefix: t.tokenPrefix,
    scope: t.scope,
    createdAt: t.createdAt,
    createdBy: t.createdBy,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    lastUsedIp: t.lastUsedIp,
    revokedAt: t.revokedAt,
    revokedBy: t.revokedBy,
    usageCount: t.usageCount,
    metadata: t.metadata,
    isRevoked: !!t.revokedAt,
  }));
}
