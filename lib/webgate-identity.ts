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
import { accessConfigFromEnv, verifyAccessJwt } from './cf-access-jwt';
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
 * Resolve a webgate-authenticated user's identity from request headers.
 *
 * Reads Cf-Access-Jwt-Assertion header (injected by Cloudflare Zero Trust),
 * verifies Cloudflare's signature on it (lib/cf-access-jwt.ts), extracts the
 * email claim, and resolves it to a canonical participant ID + display name
 * via the identity-map override file.
 *
 * Returns null if:
 * - Request didn't come through the cloudflared tunnel
 * - WEBGATE_ACCESS_TEAM_DOMAIN / WEBGATE_ACCESS_AUD are not set
 * - Cf-Access-Jwt-Assertion header is missing, forged, expired or for another application
 * - JWT payload doesn't contain an email claim
 */
export async function resolveWebGateIdentity(
  request: NextRequest
): Promise<ResolvedWebGateIdentity | null> {
  // Must be a webgate-tunneled request
  if (!isCloudflaredRequest(request)) return null;

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return null;

  const payload = await verifyAccessJwt(jwt, accessConfigFromEnv());
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
