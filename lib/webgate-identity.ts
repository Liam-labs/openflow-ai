/**
 * WebGate Identity Resolution
 *
 * Extracts authenticated user identity from Cloudflare Access JWT headers
 * injected by Zero Trust at the webgate edge. Resolves to canonical participant
 * IDs so browser sessions across devices share a single identity.
 *
 * Only active when the request arrives through the cloudflared tunnel
 * (validated by x-tunnel-auth shared secret) AND the service is locked
 * behind Cloudflare Zero Trust (Cf-Access-Jwt-Assertion header present).
 */

import { NextRequest } from 'next/server';
import { isCloudflaredRequest } from './api-auth';
import { readJsonFile } from './data-io';
import { DataPaths } from './data-paths';
import path from 'path';
import { appPath } from '@/lib/app-paths';

export interface ResolvedWebGateIdentity {
  email: string;
  canonicalParticipantId: string;
  canonicalName: string;
}

const IDENTITY_MAP_PATH = appPath('data', 'webgate-identity-map.json');

/**
 * Derive a canonical participant ID from an email prefix.
 * Sanitized to [a-z0-9_-] — no hashing, human-recognizable.
 */
function deriveParticipantId(email: string): string {
  const prefix = email.split('@')[0]?.toLowerCase() || 'unknown';
  const sanitized = prefix.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `user-${sanitized || 'unknown'}`;
}

/**
 * Derive a canonical display name from an email.
 * Title-cases the email prefix, then checks override map.
 */
function deriveName(email: string): string {
  const prefix = email.split('@')[0] || 'Unknown';
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

/**
 * Decode the payload of a Cloudflare Access JWT without verification.
 *
 * Cryptographic verification is unnecessary here: the request already passed
 * through Cloudflare Zero Trust (which validated the JWT) AND the cloudflared
 * tunnel secret check (which proves the request originated from our tunnel).
 * We only need the email claim — not proof of authenticity.
 */
function decodeCfAccessJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve a webgate-authenticated user's identity from request headers.
 *
 * Reads Cf-Access-Jwt-Assertion header (injected by Cloudflare Zero Trust),
 * decodes the JWT payload, extracts the email claim, and resolves it to a
 * canonical participant ID + display name via the identity-map override file.
 *
 * Returns null if:
 * - Request didn't come through the cloudflared tunnel
 * - Cf-Access-Jwt-Assertion header is missing or invalid
 * - JWT payload doesn't contain an email claim
 */
export async function resolveWebGateIdentity(
  request: NextRequest
): Promise<ResolvedWebGateIdentity | null> {
  // Must be a webgate-tunneled request
  if (!isCloudflaredRequest(request)) return null;

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return null;

  const payload = decodeCfAccessJwt(jwt);
  if (!payload) return null;

  const email = typeof payload.email === 'string' ? payload.email : null;
  if (!email) return null;

  const canonicalId = deriveParticipantId(email);

  // Check override map for explicit name mapping
  let canonicalName = deriveName(email);
  try {
    const overrideMap = await readJsonFile<Record<string, string>>(IDENTITY_MAP_PATH, {});
    if (overrideMap[email]) {
      canonicalName = overrideMap[email];
    }
  } catch {
    // Map file missing or unreadable — use derived name (non-fatal)
  }

  return { email, canonicalParticipantId: canonicalId, canonicalName };
}

/**
 * Synchronous variant that skips the override map (for use in hot paths
 * where the file read would contend the lock). Uses only derived name.
 */
export function resolveWebGateIdentitySync(request: NextRequest): ResolvedWebGateIdentity | null {
  if (!isCloudflaredRequest(request)) return null;

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return null;

  const payload = decodeCfAccessJwt(jwt);
  if (!payload) return null;

  const email = typeof payload.email === 'string' ? payload.email : null;
  if (!email) return null;

  return {
    email,
    canonicalParticipantId: deriveParticipantId(email),
    canonicalName: deriveName(email),
  };
}
