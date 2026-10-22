/**
 * Teams Integration - Authentication Module
 *
 * Handles Microsoft Graph API authentication using MSAL client credentials flow.
 * Caches tokens and auto-refreshes before expiry.
 */

import { ConfidentialClientApplication, ClientCredentialRequest } from '@azure/msal-node';

interface TeamsAuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

let msalClient: ConfidentialClientApplication | null = null;
let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;

function getConfig(): TeamsAuthConfig {
  const tenantId = process.env.TEAMS_TENANT_ID;
  const clientId = process.env.TEAMS_CLIENT_ID;
  const clientSecret = process.env.TEAMS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'Missing Teams integration credentials. Required env vars: ' +
      'TEAMS_TENANT_ID, TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET'
    );
  }

  return { tenantId, clientId, clientSecret };
}

function getMsalClient(): ConfidentialClientApplication {
  if (msalClient) return msalClient;

  const config = getConfig();

  msalClient = new ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientSecret: config.clientSecret,
    },
  });

  return msalClient;
}

/**
 * Get a valid access token for Microsoft Graph API.
 * Tokens are cached and refreshed 5 minutes before expiry.
 */
export async function getGraphToken(): Promise<string> {
  // Return cached token if still valid (with 5-minute buffer)
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 5 * 60 * 1000) {
    return cachedToken;
  }

  const client = getMsalClient();

  const tokenRequest: ClientCredentialRequest = {
    scopes: ['https://graph.microsoft.com/.default'],
  };

  const result = await client.acquireTokenByClientCredential(tokenRequest);

  if (!result || !result.accessToken) {
    throw new Error('Failed to acquire Graph API access token');
  }

  cachedToken = result.accessToken;
  // MSAL returns expiresOn as a Date object
  tokenExpiresAt = result.expiresOn ? result.expiresOn.getTime() : now + 60 * 60 * 1000;

  return cachedToken;
}

/**
 * Clear the cached token (for testing or forced re-auth).
 */
export function clearTokenCache(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
  msalClient = null;
}

/**
 * Check if Teams credentials are configured.
 */
export function isTeamsConfigured(): boolean {
  try {
    getConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * Test the connection by acquiring a token.
 * Returns details about the token on success.
 */
export async function testConnection(): Promise<{
  success: boolean;
  expiresAt?: string;
  error?: string;
}> {
  try {
    const token = await getGraphToken();
    // Decode JWT to check claims (without verification - just for info)
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString()
    );
    return {
      success: true,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
