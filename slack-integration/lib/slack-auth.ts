/**
 * Slack Integration - Authentication Module
 *
 * Manages Slack Bot Token and App-Level Token.
 * Slack uses static bot tokens (xoxb-...) — no refresh flow needed.
 * App-level tokens (xapp-...) are used for Socket Mode connections.
 */

interface SlackAuthConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
}

function getConfig(): SlackAuthConfig {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!botToken || !appToken || !signingSecret) {
    throw new Error(
      'Missing Slack integration credentials. Required env vars: ' +
      'SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET'
    );
  }

  return { botToken, appToken, signingSecret };
}

/**
 * Get the Bot User OAuth Token (xoxb-...).
 * Used for Slack Web API calls (posting messages, managing channels, etc.).
 */
export function getBotToken(): string {
  const config = getConfig();
  return config.botToken;
}

/**
 * Get the App-Level Token (xapp-...).
 * Used for Socket Mode WebSocket connections.
 */
export function getAppToken(): string {
  const config = getConfig();
  return config.appToken;
}

/**
 * Get the Signing Secret.
 * Used to verify incoming webhook requests from Slack.
 */
export function getSigningSecret(): string {
  const config = getConfig();
  return config.signingSecret;
}

/**
 * Check if Slack credentials are configured.
 */
export function isSlackConfigured(): boolean {
  try {
    getConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * Test the connection by calling Slack's auth.test endpoint.
 * Returns bot identity details on success.
 */
export async function testConnection(): Promise<{
  success: boolean;
  botUserId?: string;
  teamId?: string;
  teamName?: string;
  error?: string;
}> {
  try {
    const token = getBotToken();
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const data = await res.json() as {
      ok: boolean;
      user_id?: string;
      team_id?: string;
      team?: string;
      error?: string;
    };

    if (!data.ok) {
      return {
        success: false,
        error: data.error || 'auth.test failed',
      };
    }

    return {
      success: true,
      botUserId: data.user_id,
      teamId: data.team_id,
      teamName: data.team,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
