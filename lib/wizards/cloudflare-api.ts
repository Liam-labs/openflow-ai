/**
 * Cloudflare API access for the WebGate wizard (lib/wizards/cloudflare.ts): a tiny client and the pure checks around it.
 *
 * The user makes a scoped API token from the permission list below and pastes it once. Before it is saved it is checked two ways:
 * the calls the wizard needs must work, and calls it must NOT be able to make (Workers, storage, members ...) must be refused.
 * A token that reaches more than the list, more than one domain, or more than one account is refused, not stored.
 * The token is only ever sent to api.cloudflare.com and never appears in a result, a log line or an error.
 */

import { isBrowserDebugPort } from './ports';

const API = 'https://api.cloudflare.com/client/v4';

export interface CfFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; json(): Promise<unknown> }>;
}

export const realCfFetch: CfFetch = (url, init) => fetch(url, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000) });

export interface CfResponse {
  status: number;
  success: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  codes: number[];
  message: string;
}

export class CloudflareApi {
  constructor(private readonly token: string, private readonly doFetch: CfFetch = realCfFetch) {}

  async call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<CfResponse> {
    if (!path.startsWith('/')) throw new Error('path must start with /');
    try {
      const res = await this.doFetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: { code?: number; message?: string }[] };
      const errors = Array.isArray(data.errors) ? data.errors : [];
      return {
        status: res.status,
        success: res.status >= 200 && res.status < 300 && data.success === true,
        result: data.result,
        codes: errors.map((e) => Number(e.code)).filter((n) => Number.isFinite(n)),
        message: errors.map((e) => e.message).filter(Boolean).join('; ').slice(0, 300),
      };
    } catch (error) {
      return { status: 0, success: false, result: undefined, codes: [], message: `Could not reach Cloudflare (${error instanceof Error ? error.name : 'error'}).` };
    }
  }
}

// ─── What to ask the user for ────────────────────────────────────────────────────────────────────────

export const PERMISSION_LIST = [
  { scope: 'Account', name: 'Cloudflare Tunnel', level: 'Edit', key: 'argotunnel', type: 'edit' },
  { scope: 'Account', name: 'Access: Apps and Policies', level: 'Edit', key: 'access', type: 'edit' },
  { scope: 'Zone (only the domain you will use)', name: 'DNS', level: 'Edit', key: 'dns', type: 'edit' },
  { scope: 'Zone (only the domain you will use)', name: 'Zone', level: 'Read', key: 'zone', type: 'read' },
] as const;

/** Permission group names that match the list above (Cloudflare shows Edit as Write in some places). */
const ALLOWED_GROUPS = new Set([
  'cloudflare tunnel write', 'cloudflare tunnel edit', 'cloudflare tunnel read',
  'access: apps and policies write', 'access: apps and policies edit', 'access: apps and policies read',
  'dns write', 'dns edit', 'dns read',
  'zone read',
]);

/** The oldest connector Cloudflare still supports (its notice of 27 Oct 2026 about the eMudhra certificates). */
export const MIN_CLOUDFLARED = '2026.10.2';

/** True when `cloudflared --version` names a release older than MIN_CLOUDFLARED. An unreadable version is not refused (a developer build). */
export function cloudflaredTooOld(version: string | null | undefined, min = MIN_CLOUDFLARED): boolean {
  const m = /(\d{4})\.(\d+)\.(\d+)/.exec(version || '');
  if (!m) return false;
  const have = m.slice(1).map(Number);
  const need = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] < need[i];
  return false;
}

export function tokenShapeProblem(token: unknown): string | null {
  if (typeof token !== 'string' || !token.trim()) return 'Paste the API token.';
  const t = token.trim();
  if (/^[0-9a-f]{37}$/i.test(t) || /^cfk_/.test(t)) return 'That looks like your Global API Key, which can do everything on your account. Make a scoped API token from the list instead.';
  if (!/^[A-Za-z0-9_-]{30,200}$/.test(t)) return 'That does not look like a Cloudflare API token (letters, numbers, - and _ only).';
  return null;
}

// ─── Hostname and people ─────────────────────────────────────────────────────────────────────────────

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The subdomain label the user chose, checked on its own. */
export function subdomainProblem(label: unknown): string | null {
  if (typeof label !== 'string' || !LABEL.test(label.trim().toLowerCase())) return 'Use letters, numbers and - for the address name (for example "openflow").';
  if (label.trim().toLowerCase() === 'www') return 'Pick a name other than "www".';
  return null;
}

export function hostnameFor(label: string, zoneName: string): string {
  return `${label.trim().toLowerCase()}.${zoneName.trim().toLowerCase()}`;
}

const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}$/i;

/** Who may sign in: a short list of exact addresses. No wildcards, no whole domains, no "everyone". */
export function parseEmails(input: unknown): { ok: true; emails: string[] } | { ok: false; error: string } {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,;]+/) : [];
  const emails = [...new Set(raw.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return { ok: false, error: 'Enter at least one email address that may sign in.' };
  if (emails.length > 20) return { ok: false, error: 'At most 20 addresses.' };
  const bad = emails.find((e) => !EMAIL.test(e));
  if (bad) return { ok: false, error: `"${bad.slice(0, 40)}" is not a single email address. Wildcards and whole domains are not allowed here.` };
  return { ok: true, emails };
}

/** Only the app's own port may be published, and never a browser-debugging one. */
export function originPortProblem(port: number, appPort: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'That is not a port number.';
  if (isBrowserDebugPort(port)) return 'That port is a browser debugging port. It controls every website you are signed in to and is never published.';
  if (port !== appPort) return 'Only this app\'s own port can be published.';
  return null;
}

// ─── Is the token too broad? ─────────────────────────────────────────────────────────────────────────

export interface Probe { name: string; path: string; expect: 'allowed' | 'refused' }

export function probesFor(accountId: string, zoneId: string): Probe[] {
  return [
    { name: 'Tunnels', path: `/accounts/${accountId}/cfd_tunnel?per_page=1&is_deleted=false`, expect: 'allowed' },
    { name: 'Access applications', path: `/accounts/${accountId}/access/apps?per_page=1`, expect: 'allowed' },
    { name: 'Access policies', path: `/accounts/${accountId}/access/policies?per_page=1`, expect: 'allowed' },
    { name: 'DNS records', path: `/zones/${zoneId}/dns_records?per_page=1`, expect: 'allowed' },
    // Not /workers/scripts: Cloudflare answers that list with 200 to any token on the account (empty without the permission).
    // The subdomain endpoint enforces it: 403 code 10000 without Workers, 200 with it (checked against real tokens, 29 Oct 2026).
    { name: 'Workers', path: `/accounts/${accountId}/workers/subdomain`, expect: 'refused' },
    { name: 'Key-value storage', path: `/accounts/${accountId}/storage/kv/namespaces?per_page=1`, expect: 'refused' },
    { name: 'R2 storage', path: `/accounts/${accountId}/r2/buckets`, expect: 'refused' },
    { name: 'Databases (D1)', path: `/accounts/${accountId}/d1/database?per_page=1`, expect: 'refused' },
    { name: 'Account members', path: `/accounts/${accountId}/members?per_page=1`, expect: 'refused' },
    { name: 'Domain settings', path: `/zones/${zoneId}/settings`, expect: 'refused' },
  ];
}

export interface ProbeResult { probe: Probe; status: number; success: boolean; codes: number[] }

/** Cloudflare's own "you may not" answers. */
export function refusedAnswer(r: { status: number; codes: number[] }): boolean {
  return r.status === 401 || r.status === 403 || r.codes.some((c) => c === 10000 || c === 9109 || c === 9103 || c === 10001);
}

export interface BreadthVerdict { ok: boolean; problems: string[]; notes: string[] }

/** " (a.com, b.com, c.com and 10 more)" so the person can see which token was checked. */
function namesOf(names: string[] | undefined): string {
  if (!names?.length) return '';
  const shown = names.slice(0, 3).join(', ');
  return ` (${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''})`;
}

export function judgeBreadth(input: { probes: ProbeResult[]; zoneCount: number; zoneNames?: string[]; accountCount: number; extraGroups: string[] | null; wildcardZone: boolean }): BreadthVerdict {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const r of input.probes) {
    if (r.probe.expect === 'allowed' && !r.success) problems.push(`The token cannot use "${r.probe.name}", which the wizard needs. Add that permission.`);
    if (r.probe.expect === 'refused') {
      // The token's own permission list is the exact record of what it was given. When it was read and holds nothing beyond the list,
      // a probe that Cloudflare nevertheless answered is Cloudflare being lenient on that endpoint, not a permission the token has.
      if (r.success && input.extraGroups?.length === 0) notes.push(`Cloudflare answered a request for "${r.probe.name}", but the token's permission list holds nothing beyond the four listed, so it was accepted.`);
      else if (r.success) problems.push(`The token can also reach "${r.probe.name}" (Cloudflare answered ${r.status}), which the wizard does not need. Make a new token with only the listed permissions.`);
      else if (!refusedAnswer(r)) notes.push(`Could not tell whether the token reaches "${r.probe.name}" (answer ${r.status}).`);
    }
  }
  if (input.zoneCount > 1) problems.push(`The token covers ${input.zoneCount} domains${namesOf(input.zoneNames)}. Limit it to the one domain you will use.`);
  if (input.accountCount > 1) problems.push(`The token covers ${input.accountCount} Cloudflare accounts. Limit it to one.`);
  if (input.wildcardZone) problems.push('The token is set to "All zones". Limit it to the one domain you will use.');
  if (input.extraGroups?.length) problems.push(`The token carries permissions the wizard does not need: ${input.extraGroups.join(', ')}.`);
  return { ok: problems.length === 0, problems, notes };
}

/** Resources look like {"com.cloudflare.api.account.zone.<id>": "*"} for one domain and nest {"...zone.*": "*"} for all of them. */
function hasZoneWildcard(resources: Record<string, unknown>): boolean {
  return Object.entries(resources).some(([key, value]) => key === 'com.cloudflare.api.account.zone.*' || (!!value && typeof value === 'object' && hasZoneWildcard(value as Record<string, unknown>)));
}

/** From GET /user/tokens/{id}: permission groups outside the list, and whether any zone grant is "all zones". */
export function inspectTokenPolicies(token: unknown): { extraGroups: string[]; wildcardZone: boolean } | null {
  const policies = (token as { policies?: unknown })?.policies;
  if (!Array.isArray(policies)) return null;
  const extra = new Set<string>();
  let wildcardZone = false;
  for (const p of policies as { effect?: string; permission_groups?: { name?: string }[]; resources?: Record<string, unknown> }[]) {
    if (p.effect && p.effect !== 'allow') continue;
    for (const g of p.permission_groups ?? []) {
      const name = String(g.name ?? '');
      if (name && !ALLOWED_GROUPS.has(name.toLowerCase())) extra.add(name);
    }
    if (p.resources && hasZoneWildcard(p.resources)) wildcardZone = true;
  }
  return { extraGroups: [...extra], wildcardZone };
}
