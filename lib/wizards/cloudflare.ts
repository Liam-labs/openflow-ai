/**
 * WebGate wizard (stage 2 of the setup wizards): put the dashboard on the user's own Cloudflare domain behind Cloudflare Access.
 *
 * Do      in an order that never leaves the address open: the Access policy and application first (an application with no matching
 *         person denies everyone), then the tunnel, its route, and the DNS record last. Every id is recorded as it is made, so a stop
 *         half way can be finished or undone.
 * Prove   a request with no credentials to the real public address must land on Cloudflare's sign-in page, not the dashboard. If it
 *         ever returns the dashboard, everything is taken down again at once.
 * Undo    removes only what this wizard made, address first, Access last.
 *
 * Needs the sign-in password (lib/wizards/sign-in.ts): Access is the front door, the dashboard's own sign-in is the second lock.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { DataPaths } from '../data-paths';
import { readJsonFileStrict, writeJsonFile } from '../data-io';
import { hasPassword } from '../dashboard-auth';
import { listensOnLoopbackOnly } from '../local-trust';
import { CloudflareApi, cloudflaredTooOld, MIN_CLOUDFLARED, hostnameFor, inspectTokenPolicies, judgeBreadth, refusedAnswer, originPortProblem, parseEmails, probesFor, subdomainProblem, tokenShapeProblem, type BreadthVerdict, type ProbeResult } from './cloudflare-api';
import type { ConnectorRunner } from './cloudflared-runner';

type Env = Record<string, string | undefined>;

export type Stage = 'none' | 'policy' | 'app' | 'tunnel' | 'config' | 'dns' | 'live';
const ORDER: Stage[] = ['none', 'policy', 'app', 'tunnel', 'config', 'dns', 'live'];
const atLeast = (stage: Stage, wanted: Stage) => ORDER.indexOf(stage) >= ORDER.indexOf(wanted);

export interface CfRecord {
  enabled: boolean;
  stage: Stage;
  accountId?: string; zoneId?: string; zoneName?: string; hostname?: string; emails?: string[]; port?: number;
  policyId?: string; appId?: string; tunnelId?: string; dnsRecordId?: string;
  /** What the token check found, so the domain list survives a page reload (no secret in it). */
  known?: { accountId: string; zones: ZoneInfo[] };
  at?: string;
}

export const emptyRecord = (): CfRecord => ({ enabled: false, stage: 'none' });

export interface Io {
  env: Env;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  passwordSet: () => Promise<boolean>;
  readRecord: () => Promise<CfRecord>;
  writeRecord: (r: CfRecord) => Promise<void>;
  writeTunnelToken: (token: string) => Promise<void>;
  removeTunnelToken: () => Promise<void>;
  runner: ConnectorRunner;
  fetchPublic: (url: string) => Promise<{ status: number; location: string | null }>;
}

export const realIo = (runner: ConnectorRunner, env: Env = process.env): Io => ({
  env,
  now: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  passwordSet: hasPassword,
  readRecord: async () => ({ ...emptyRecord(), ...(await readJsonFileStrict<CfRecord>(DataPaths.cloudflareAccess, emptyRecord()).catch(() => emptyRecord())) }),
  writeRecord: (r) => writeJsonFile(DataPaths.cloudflareAccess, r),
  writeTunnelToken: (token) => fs.writeFile(DataPaths.cloudflaredToken, token, { mode: 0o600 }),
  removeTunnelToken: () => fs.rm(DataPaths.cloudflaredToken, { force: true }),
  runner,
  fetchPublic: async (url) => {
    const res = await fetch(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    return { status: res.status, location: res.headers.get('location') };
  },
});

export type StepResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; fix?: string };

// ─── Token: check before saving ──────────────────────────────────────────────────────────────────────

export interface ZoneInfo { id: string; name: string; accountId: string }

export interface TokenCheck {
  ok: boolean;
  problems: string[];
  notes: string[];
  zones: ZoneInfo[];
  accountId: string | null;
  /** What was asked of Cloudflare and what it answered. No secret in it: only the first 8 characters of the token's SHA-256 identify it. */
  details?: string[];
}

/** Short, non-secret identity of a token, so "which token was checked" can be answered later. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex').slice(0, 8);
}

/** Everything the wizard asks Cloudflare before it will keep a token. Read-only calls only. */
export async function checkToken(api: CloudflareApi, token: string): Promise<TokenCheck> {
  const shape = tokenShapeProblem(token);
  if (shape) return { ok: false, problems: [shape], notes: [], zones: [], accountId: null };

  const verify = await api.call('GET', '/user/tokens/verify');
  let tokenId: string | null = null;
  if (verify.success) {
    if (verify.result?.status !== 'active') return { ok: false, problems: [`The token is ${String(verify.result?.status ?? 'not active')}.`], notes: [], zones: [], accountId: null };
    tokenId = typeof verify.result?.id === 'string' ? verify.result.id : null;
  }
  // (An account-owned token is not verified here: it falls through to the listings, which fail clearly for a bad token.)

  const [zonesRes, accountsRes] = await Promise.all([api.call('GET', '/zones?per_page=50'), api.call('GET', '/accounts?per_page=50')]);
  if (!zonesRes.success && !accountsRes.success) {
    return { ok: false, problems: [zonesRes.status === 0 ? zonesRes.message : 'Cloudflare did not accept this token. Check it was copied whole and has not expired.'], notes: [], zones: [], accountId: null };
  }
  const zones: ZoneInfo[] = (Array.isArray(zonesRes.result) ? zonesRes.result : []).map((z: { id?: string; name?: string; account?: { id?: string } }) => ({ id: String(z.id), name: String(z.name), accountId: String(z.account?.id ?? '') })).filter((z: ZoneInfo) => z.id && z.name);
  const accounts: string[] = (Array.isArray(accountsRes.result) ? accountsRes.result : []).map((a: { id?: string }) => String(a.id)).filter(Boolean);
  const accountId = zones[0]?.accountId || accounts[0] || null;
  if (!zones.length || !accountId) {
    return { ok: false, problems: ['The token cannot see any domain. Add "Zone: Read" and "DNS: Edit" for the domain you will use.'], notes: [], zones: [], accountId };
  }

  // Cloudflare lists every domain on the account for a token that has account permissions, so the list is not the token's reach.
  // What the token can really use is the domains whose DNS records it can read.
  const reach = await Promise.all(zones.map(async (z) => ({ z, r: await api.call('GET', `/zones/${z.id}/dns_records?per_page=1`) })));
  const usable = reach.filter((x) => x.r.success).map((x) => x.z);
  const details: string[] = [`Token ${tokenFingerprint(token)} (first 8 characters of its SHA-256).`, `Cloudflare listed ${zones.length} domains on the account. The token can read DNS records for ${usable.length}${usable.length ? `: ${usable.slice(0, 5).map((z) => z.name).join(', ')}${usable.length > 5 ? ` and ${usable.length - 5} more` : ''}` : ''}.`];
  if (!usable.length) {
    return { ok: false, problems: ['The token cannot read the DNS records of any domain. Add "Zone: DNS: Edit" for the domain you will use.'], notes: [], zones: [], accountId, details };
  }

  const probes: ProbeResult[] = await Promise.all(probesFor(accountId, usable[0].id).map(async (probe) => {
    const r = await api.call('GET', probe.path);
    return { probe, status: r.status, success: r.success, codes: r.codes };
  }));
  // An account that never set up a workers.dev subdomain may answer the Workers probe with neither yes nor no. Then the script
  // list decides: it holds the account's scripts only for a token that has Workers (empty without), so a non-empty list is reach.
  const workers = probes.find((r) => r.probe.name === 'Workers');
  if (workers && !workers.success && !refusedAnswer(workers)) {
    const list = await api.call('GET', `/accounts/${accountId}/workers/scripts`);
    if (list.success && Array.isArray(list.result) && list.result.length > 0) Object.assign(workers, { status: list.status, success: true, codes: list.codes });
  }
  for (const r of probes) details.push(`${r.probe.name}: Cloudflare answered ${r.status}${r.codes.length ? ` (code ${r.codes.join(', ')})` : ''}${r.probe.expect === 'refused' ? (r.success ? ', which means the token can reach it' : ', refused as wanted') : ''}.`);

  let extraGroups: string[] | null = null;
  let wildcardZone = false;
  if (tokenId) {
    const own = await api.call('GET', `/user/tokens/${tokenId}`);
    if (own.success) {
      const inspected = inspectTokenPolicies(own.result);
      if (inspected) { extraGroups = inspected.extraGroups; wildcardZone = inspected.wildcardZone; }
    }
  }
  const verdict: BreadthVerdict = judgeBreadth({ probes, zoneCount: usable.length, zoneNames: usable.map((z) => z.name), accountCount: Math.max(accounts.length, new Set(usable.map((z) => z.accountId)).size), extraGroups, wildcardZone });
  if (probes.some((r) => r.probe.expect === 'refused' && r.success)) {
    // Read-only look at the neighbouring Workers and Pages endpoints, so a wrong answer can be told from a real permission.
    for (const [name, path] of [['Workers subdomain', `/accounts/${accountId}/workers/subdomain`], ['Workers domains', `/accounts/${accountId}/workers/domains`], ['Pages projects', `/accounts/${accountId}/pages/projects?per_page=1`]] as const) {
      const r = await api.call('GET', path);
      details.push(`Extra look, ${name}: Cloudflare answered ${r.status}${r.codes.length ? ` (code ${r.codes.join(', ')})` : ''}.`);
    }
    const w = probes.find((r) => r.probe.name === 'Workers');
    const scripts = await api.call('GET', `/accounts/${accountId}/workers/scripts`);
    if (w && scripts.success) details.push(`Extra look, Workers list: ${Array.isArray(scripts.result) ? scripts.result.length : 'not a list'} scripts returned.`);
  }
  console.info(`[cloudflare-wizard] token check ${verdict.ok ? 'passed' : 'failed'}: ${details.join(' | ')}`);
  return { ok: verdict.ok, problems: verdict.problems, notes: verdict.notes, zones: usable, accountId, details };
}

// ─── Enable ──────────────────────────────────────────────────────────────────────────────────────────

export interface EnableParams { zoneId: string; subdomain: string; emails: unknown; accountId: string; zones: ZoneInfo[] }

export async function enableWebgate(api: CloudflareApi, p: EnableParams, io: Io): Promise<StepResult<{ url: string; exposed?: false }>> {
  if (!(await io.passwordSet())) return { ok: false, error: 'Set a sign-in password first (the dashboard keeps its own sign-in behind Cloudflare Access).', fix: 'password' };
  if (!listensOnLoopbackOnly(io.env)) return { ok: false, error: 'The app listens beyond this computer (DEVFLOW_BIND_HOST). It must stay on 127.0.0.1 so the tunnel is the only way in.' };
  const zone = p.zones.find((z) => z.id === p.zoneId);
  if (!zone) return { ok: false, error: 'Pick one of your domains.' };
  const sub = subdomainProblem(p.subdomain);
  if (sub) return { ok: false, error: sub };
  const who = parseEmails(p.emails);
  if (!who.ok) return { ok: false, error: who.error };
  const port = Number(io.env.PORT) || 3000;
  const portProblem = originPortProblem(port, port);
  if (portProblem) return { ok: false, error: portProblem };
  const installed = await io.runner.installed();
  if (!installed.path) return { ok: false, error: 'cloudflared (Cloudflare\'s connector program) is not installed on this computer.', fix: 'cloudflared' };
  if (cloudflaredTooOld(installed.version)) return { ok: false, error: `This cloudflared (${installed.version}) is older than ${MIN_CLOUDFLARED}, the oldest version Cloudflare still supports. Update it, then press Switch on again.`, fix: 'cloudflared' };

  const hostname = hostnameFor(p.subdomain, zone.name);
  let rec = await io.readRecord();
  if (rec.stage !== 'none' && rec.hostname !== hostname) {
    return { ok: false, error: `This wizard already made ${rec.hostname ?? 'something'}. Undo that first.` };
  }
  rec = { ...rec, enabled: true, accountId: p.accountId, zoneId: zone.id, zoneName: zone.name, hostname, emails: who.emails, port, at: rec.at ?? io.now() };
  const save = async (stage: Stage, extra: Partial<CfRecord> = {}) => { rec = { ...rec, ...extra, stage }; await io.writeRecord(rec); };
  const fail = (error: string): StepResult<never> => ({ ok: false, error });

  // Zero Trust must be set up on the account (a one-time click in the Cloudflare dashboard). Reading the organization needs a
  // permission outside the four the token has, so Cloudflare usually refuses the look (403, code 10000): that is "cannot tell",
  // not "not set up". Then the first create below answers the question, and changes nothing if Zero Trust is missing.
  const zeroTrustMissing = { ok: false as const, error: 'Cloudflare Zero Trust is not set up on this account yet. Open the Zero Trust page in your Cloudflare dashboard once, pick a team name (the free plan is enough), then try again.', fix: 'zerotrust' as const };
  const org = await api.call('GET', `/accounts/${p.accountId}/access/organizations`);
  if (!org.success && !refusedAnswer(org)) return zeroTrustMissing;

  // 0. Never touch a name that already exists. This runs before anything is made: an Access app on a live name would put a
  // sign-in page in front of the user's own site, even though step 5 would then refuse to replace its DNS record.
  if (!atLeast(rec.stage, 'dns')) {
    const taken = await api.call('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`);
    if (!taken.success) return fail(`Could not look at your DNS records: ${taken.message || `answer ${taken.status}`}`);
    if ((taken.result ?? []).length) return fail(`${hostname} already exists in your DNS. Pick another name; this wizard never touches an existing record.`);
  }

  // 1. Who may sign in.
  if (!atLeast(rec.stage, 'policy')) {
    const r = await api.call('POST', `/accounts/${p.accountId}/access/policies`, {
      name: `openflow ${hostname}`, decision: 'allow', session_duration: '24h',
      include: who.emails.map((email) => ({ email: { email } })),
    });
    if (!r.success && /not_enabled|organization/i.test(r.message || '')) return zeroTrustMissing;
    if (!r.success || !r.result?.id) return fail(`Cloudflare would not create the sign-in rule: ${r.message || `answer ${r.status}`}`);
    await save('policy', { policyId: String(r.result.id) });
  }
  // 2. The Access application that applies it to the address. Until the address exists, nothing can reach it.
  if (!atLeast(rec.stage, 'app')) {
    const r = await api.call('POST', `/accounts/${p.accountId}/access/apps`, {
      name: `openflow ${hostname}`, domain: hostname, type: 'self_hosted', session_duration: '24h', app_launcher_visible: false,
      policies: [{ id: rec.policyId, precedence: 1 }],
    });
    if (!r.success || !r.result?.id) return fail(`Cloudflare would not create the Access application: ${r.message || `answer ${r.status}`}`);
    await save('app', { appId: String(r.result.id) });
  }
  // The application must really carry our rule and our address before anything is published.
  const app = await api.call('GET', `/accounts/${p.accountId}/access/apps/${rec.appId}`);
  const carries = (app.result?.policies ?? []).some((x: { id?: string }) => x?.id === rec.policyId);
  if (!app.success || String(app.result?.domain).toLowerCase() !== hostname || !carries) return fail('The Access application did not come back as expected, so nothing was published. Undo and try again.');

  // 3. The tunnel.
  if (!atLeast(rec.stage, 'tunnel')) {
    const r = await api.call('POST', `/accounts/${p.accountId}/cfd_tunnel`, { name: `openflow-${hostname.replace(/\./g, '-')}`, config_src: 'cloudflare' });
    if (!r.success || !r.result?.id || typeof r.result?.token !== 'string') return fail(`Cloudflare would not create the tunnel: ${r.message || `answer ${r.status}`}`);
    await io.writeTunnelToken(r.result.token);
    await save('tunnel', { tunnelId: String(r.result.id) });
  }
  // 4. Route that address, and only that address, to this app. Everything else gets 404.
  if (!atLeast(rec.stage, 'config')) {
    const r = await api.call('PUT', `/accounts/${p.accountId}/cfd_tunnel/${rec.tunnelId}/configurations`, {
      config: { ingress: [{ hostname, service: `http://127.0.0.1:${port}`, originRequest: {} }, { service: 'http_status:404' }] },
    });
    if (!r.success) return fail(`Cloudflare would not save the tunnel route: ${r.message || `answer ${r.status}`}`);
    await save('config');
  }
  // 5. The address itself, last. Never take over a name that already exists.
  if (!atLeast(rec.stage, 'dns')) {
    const existing = await api.call('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`);
    if (!existing.success) return fail(`Could not look at your DNS records: ${existing.message || `answer ${existing.status}`}`);
    if ((existing.result ?? []).length) return fail(`${hostname} already exists in your DNS. Pick another name; this wizard never replaces an existing record.`);
    const r = await api.call('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: hostname, content: `${rec.tunnelId}.cfargotunnel.com`, proxied: true, comment: 'openflow wizard' });
    if (!r.success || !r.result?.id) return fail(`Cloudflare would not create the address: ${r.message || `answer ${r.status}`}`);
    await save('dns', { dnsRecordId: String(r.result.id) });
  }
  // 6. Start the connector and wait for the tunnel to be healthy.
  const started = await io.runner.start();
  if (!started.ok) return fail(`The connector did not start: ${started.error}`);
  let healthy = false;
  for (let i = 0; i < 30 && !healthy; i++) {
    const t = await api.call('GET', `/accounts/${p.accountId}/cfd_tunnel/${rec.tunnelId}`);
    healthy = t.success && t.result?.status === 'healthy';
    if (!healthy) await io.sleep(2000);
  }
  if (!healthy) return fail('The tunnel did not become healthy in a minute. Check the computer can reach Cloudflare on port 7844, then press Switch on again to continue.');
  await save('live');

  // 7. Prove it, and take everything down if it is open.
  const proof = await proveWebgate(rec.hostname!, io);
  if (proof.exposed) {
    await disableWebgate(api, io);
    return { ok: false, error: 'The address showed the dashboard to a visitor who had not signed in. Everything was taken down again. Nothing is published.' };
  }
  return { ok: true, url: `https://${hostname}` };
}

// ─── Prove ───────────────────────────────────────────────────────────────────────────────────────────

export interface ProofStep { name: string; ok: boolean; detail: string }

/** Is this answer Cloudflare Access's sign-in page? */
export function isAccessLogin(r: { status: number; location: string | null }): boolean {
  if (r.status < 300 || r.status >= 400 || !r.location) return false;
  try {
    const u = new URL(r.location);
    return u.protocol === 'https:' && u.hostname.toLowerCase().endsWith('.cloudflareaccess.com') && u.pathname.startsWith('/cdn-cgi/access/');
  } catch {
    return false;
  }
}

export async function proveWebgate(hostname: string, io: Pick<Io, 'fetchPublic' | 'sleep'>, attempts = 12): Promise<{ ok: boolean; exposed: boolean; steps: ProofStep[] }> {
  const paths: [string, string][] = [['/', 'The address asks for Cloudflare sign-in'], ['/api/connectors', 'The data behind it asks for Cloudflare sign-in too']];
  const steps: ProofStep[] = [];
  for (const [p, name] of paths) {
    let last = 'no answer';
    let done = false;
    for (let i = 0; i < attempts && !done; i++) {
      try {
        const r = await io.fetchPublic(`https://${hostname}${p}`);
        if (isAccessLogin(r)) { steps.push({ name, ok: true, detail: 'A visitor with no credentials was sent to the Cloudflare Access sign-in page.' }); done = true; break; }
        if (r.status >= 200 && r.status < 300) {
          steps.push({ name, ok: false, detail: `Answer ${r.status}: the page opened WITHOUT Cloudflare sign-in.` });
          return { ok: false, exposed: true, steps };
        }
        last = `answer ${r.status}${r.location ? ` to ${r.location.slice(0, 80)}` : ''}`;
      } catch (error) {
        last = error instanceof Error ? error.message : 'error';
      }
      if (i < attempts - 1) await io.sleep(5000);
    }
    if (!done) steps.push({ name, ok: false, detail: `Not ready yet (${last}). A new address can take a minute to appear.` });
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), exposed: false, steps };
}

// ─── Undo ────────────────────────────────────────────────────────────────────────────────────────────

export async function disableWebgate(api: CloudflareApi, io: Io): Promise<StepResult<{ note?: string }>> {
  const rec = await io.readRecord();
  if (rec.stage === 'none' && !rec.enabled) return { ok: true, note: 'Nothing was switched on here.' };
  const a = rec.accountId;
  const problems: string[] = [];
  const gone = (r: { status: number; success: boolean }) => r.success || r.status === 404;

  // The address first, so it stops resolving before anything behind it goes.
  if (rec.dnsRecordId && rec.zoneId) {
    const cur = await api.call('GET', `/zones/${rec.zoneId}/dns_records/${rec.dnsRecordId}`);
    if (cur.success && cur.result?.content !== `${rec.tunnelId}.cfargotunnel.com`) problems.push(`The DNS record for ${rec.hostname} no longer points at our tunnel, so it was left alone.`);
    else {
      const r = await api.call('DELETE', `/zones/${rec.zoneId}/dns_records/${rec.dnsRecordId}`);
      if (!gone(r)) return { ok: false, error: `Could not remove the address ${rec.hostname}: ${r.message || `answer ${r.status}`}. Nothing else was removed.` };
    }
    rec.dnsRecordId = undefined; await io.writeRecord({ ...rec });
  }
  await io.runner.stop();
  if (rec.tunnelId && a) {
    await api.call('DELETE', `/accounts/${a}/cfd_tunnel/${rec.tunnelId}/connections`);
    const r = await api.call('DELETE', `/accounts/${a}/cfd_tunnel/${rec.tunnelId}`);
    if (!gone(r)) return { ok: false, error: `Could not remove the tunnel: ${r.message || `answer ${r.status}`}. The address is already gone; the Access rule was kept.` };
    rec.tunnelId = undefined; await io.writeRecord({ ...rec });
  }
  await io.removeTunnelToken();
  // Access last: while it exists nobody gets in without it.
  if (rec.appId && a) {
    const r = await api.call('DELETE', `/accounts/${a}/access/apps/${rec.appId}`);
    if (!gone(r)) return { ok: false, error: `Could not remove the Access application: ${r.message || `answer ${r.status}`}.` };
    rec.appId = undefined; await io.writeRecord({ ...rec });
  }
  if (rec.policyId && a) {
    const r = await api.call('DELETE', `/accounts/${a}/access/policies/${rec.policyId}`);
    if (!gone(r)) problems.push(`The sign-in rule could not be removed (${r.message || `answer ${r.status}`}); it is harmless on its own.`);
  }
  await io.writeRecord({ ...emptyRecord(), known: rec.known });
  return { ok: true, note: problems.length ? problems.join(' ') : 'Switched off. The address, tunnel and Access rule this wizard made are gone.' };
}
