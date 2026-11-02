/**
 * The pre-filled "Create API token" link for the Cloudflare wizard: one click opens Cloudflare's token form with the four permissions
 * and the token name already set. Key names come from Cloudflare's own dashboard code (the public docs list no key for Tunnel or
 * Access). Cloudflare drops a key it does not recognise without any message, so the wizard still checks the token after it is pasted
 * and the page tells the person to look for four filled rows.
 *
 * Scope is `accountId=*` and `zoneId=all` because the zone id is not known before a token exists. The token check refuses a token
 * that reaches all zones, so the page tells the person to narrow Zone Resources to their one domain.
 */
import { PERMISSION_LIST } from './cloudflare-api';

export const TOKEN_LINK_BASE = 'https://dash.cloudflare.com/profile/api-tokens';

export function tokenName(label?: string | null): string {
  const l = (label ?? '').trim().replace(/[^\w .-]/g, '').slice(0, 30);
  return l ? `OpenFlow ${l}` : 'OpenFlow';
}

export function tokenLink(name: string): string {
  const keys = PERMISSION_LIST.map(p => ({ key: p.key, type: p.type }));
  return `${TOKEN_LINK_BASE}?permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}&accountId=%2A&zoneId=all&name=${encodeURIComponent(name)}`;
}

export { looksLikeCloudflareToken } from './cloudflare-token-shape';
