/**
 * Harness sign-in health: the parts that touch disk, channels and the sign-in helper. The decisions live in ./model.ts (pure, tested);
 * this file wires them to the store, the roster, the channel messages and scripts/harness_signin.py.
 */
import { randomUUID } from 'crypto';
import { readJsonFile } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { appendMessage } from '@/lib/collab-message-io';
import type { CollabChannelsData, CollabMessage } from '@/lib/types';
import {
  HARNESSES, HOSTS, agentsAtRisk, applyReport, buildViews, cleanEmail, credentialId, credentialLabel, isFresh, nextAgentHealth, parseCredentialId, planAlerts,
  type AtRiskAgent, type CredentialState, type CredentialView, type HarnessId, type HostId, type SignInHarnessId, type Report, type RosterAgentLite, type SignInView,
} from './model';
import { desktopIsRemote, isRefusal, runSignInTool, type Refusal } from './runner';
import { readStore, updateStore } from './store';

// Short on purpose: the Logins list and the Run-remote unlock refresh every 10-15 s, and a login that has just finished should show within one refresh. A probe takes about 0.2 s.
const PROBE_TTL_MS = 10_000;
const LIST_TTL_MS = 3_000;
const LIST_TIMEOUT_MS = 4_000;

/** Sign-in ids are only unique per machine, so remember which machine owns each one we started. */
const signInOwner = new Map<string, HostId>();
const g = globalThis as unknown as { __harnessAuthCache?: { probes: Map<string, { at: number; value: Probe }>; lists: Map<string, { at: number; value: SignInView[] }> } };
const cache = (g.__harnessAuthCache ??= { probes: new Map(), lists: new Map() });

interface Probe { state: CredentialState; detail: string; plan: string | null; checkedAt: string; account?: string | null }

/** What is installed and signed in on the server itself, for the laptop-readiness check. */
export async function probeServerHarnesses(): Promise<Record<HarnessId, { state: CredentialState; detail: string } | null>> {
  const [claude, codex] = await Promise.all([probe('server', 'claude'), probe('server', 'codex')]);
  return { claude, codex };
}

/** Tests only: forget cached probes, sign-in lists and sign-in owners. */
export function resetCachesForTests(): void {
  cache.probes.clear();
  cache.lists.clear();
  signInOwner.clear();
}

export class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) { super(message); }
}

// ── Reading ──────────────────────────────────────────────────────────────────

async function rosterAgents(): Promise<RosterAgentLite[]> {
  const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, { channels: [], lastUpdated: new Date().toISOString() });
  const seen = new Set<string>();
  const out: RosterAgentLite[] = [];
  for (const channel of data.channels) {
    for (const agent of channel.roster?.agents ?? []) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      out.push({ id: agent.id, name: agent.name, channelId: channel.id, agentType: agent.agentType, runLocation: agent.runLocation ?? null, status: agent.status, harnessHealth: agent.harnessHealth });
    }
  }
  return out;
}

async function probe(host: HostId, harness: SignInHarnessId): Promise<Probe | null> {
  const key = credentialId(harness, host);
  const hit = cache.probes.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;
  try {
    const result = await runSignInTool(host, 'probe', { harness }, LIST_TIMEOUT_MS);
    if (isRefusal(result)) return null;
    const value = result as Probe;
    cache.probes.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

function asView(raw: Record<string, unknown>): SignInView {
  const { alreadyActive: _ignored, ...rest } = raw;
  return rest as unknown as SignInView;
}

async function listSignIns(host: HostId): Promise<SignInView[]> {
  const hit = cache.lists.get(host);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
  try {
    const result = await runSignInTool(host, 'list', {}, LIST_TIMEOUT_MS);
    const value = Array.isArray(result) ? (result as Record<string, unknown>[]).map(asView) : [];
    cache.lists.set(host, { at: Date.now(), value });
    for (const s of value) signInOwner.set(s.id, host);
    return value;
  } catch {
    return [];
  }
}

export async function listCredentialViews(nowMs = Date.now()): Promise<CredentialView[]> {
  const [store, agents, desktopSignIns, serverSignIns] = await Promise.all([readStore(), rosterAgents(), listSignIns('desktop'), listSignIns('server')]);
  // The server's own logins can be probed directly. The desktop's are probed here only when it is this same machine; otherwise its watcher reports them.
  const localHosts: HostId[] = desktopIsRemote() ? ['server'] : ['desktop', 'server'];
  const localProbes: Record<string, Probe> = {};
  await Promise.all(localHosts.flatMap(host => HARNESSES.map(async harness => {
    const result = await probe(host, harness);
    if (result) localProbes[credentialId(harness, host)] = result;
  })));
  await finishCompletedSignIns({ desktop: desktopSignIns, server: serverSignIns }, store.credentials);
  await rememberAccounts(store, localProbes);
  const fresh = await readStore();
  const views = buildViews({ store: fresh, localProbes, agents, signIns: { desktop: desktopSignIns, server: serverSignIns }, nowMs });
  return [...views, await antigravityView(desktopSignIns)];
}

/**
 * Antigravity (Gemini) on the agents' machine. It has no health watcher, so its state is read on demand from the program's login file
 * (scripts/harness_signin.py) and nothing about it is stored. The setup wizard and the Logins list both read this row.
 */
async function antigravityView(signIns: SignInView[]): Promise<CredentialView> {
  const result = await probe('desktop', 'antigravity');
  const mine = signIns.filter(s => s.harness === 'antigravity');
  const signIn = mine.find(s => s.state === 'starting' || s.state === 'waiting' || s.state === 'verifying') ?? mine[0] ?? null;
  const account = cleanEmail(result?.account);
  return {
    id: credentialId('antigravity', 'desktop'), harness: 'antigravity', host: 'desktop', label: credentialLabel('antigravity', 'desktop'),
    state: result?.state ?? 'unknown', detail: result?.detail ?? 'Could not check this login right now',
    ...(account ? { account } : {}), checkedAt: result?.checkedAt ?? new Date(0).toISOString(), signIn, agents: [],
  };
}

/**
 * The account a login is signed in with is remembered the moment we see it, because a sign-out (or a new sign-in, which deletes the old
 * Codex login) leaves nothing to read it from afterwards. The desktop's accounts arrive in the watcher's reports; the logins this machine
 * can probe itself are recorded here. Writes only when something changed.
 */
async function rememberAccounts(store: { accounts?: Record<string, { email: string }> }, localProbes: Record<string, Probe>) {
  const news = Object.entries(localProbes).filter(([id, p]) => p.state === 'ok' && cleanEmail(p.account) && store.accounts?.[id]?.email !== p.account);
  if (!news.length) return;
  await updateStore(current => {
    const accounts = { ...(current.accounts ?? {}) };
    for (const [id, p] of news) accounts[id] = { email: p.account as string, seenAt: p.checkedAt };
    return { store: { ...current, accounts }, result: null };
  });
}

/** A finished sign-in should turn the credential green now, not at the watcher's next report. */
async function finishCompletedSignIns(signIns: Record<HostId, SignInView[]>, stored: Record<string, { state: CredentialState }>) {
  for (const host of HOSTS) {
    for (const s of signIns[host]) {
      if (s.harness === 'antigravity') continue;             // its view is read live from the program's login file, nothing is stored
      const id = credentialId(s.harness, host);
      if (s.state !== 'done' || stored[id]?.state === 'ok') continue;
      const verdict = await probe(host, s.harness);
      if (!verdict || verdict.state !== 'ok') continue;
      const report: Report = { host, agents: [], credentials: [{ id, state: 'ok', detail: 'Signed in', plan: verdict.plan, usage: null, checkedAt: verdict.checkedAt, since: null, account: cleanEmail(verdict.account) }] };
      await updateStore(store => { const applied = applyReport(store, report, Date.now()); return { store: applied.store, result: null }; });
      cache.probes.delete(id);
    }
  }
}

// ── Reports from the watcher ─────────────────────────────────────────────────

function systemMessage(channelId: string, content: string): CollabMessage {
  const now = new Date().toISOString();
  return { id: randomUUID(), channelId, from: { id: 'system', type: 'user' as const, name: 'System', source: 'DevFlow', joinedAt: now, lastSeen: now }, content, timestamp: now };
}

export async function recordReport(report: Report, nowMs = Date.now()): Promise<{ changed: number; alerted: number }> {
  // A signed-out login is announced even if no agent has failed yet, so find who is running on it.
  const atRisk: Record<string, AtRiskAgent[]> = {};
  const signedOut = report.credentials.filter(c => c.state === 'needs_login');
  if (signedOut.length) {
    const roster = await rosterAgents();
    for (const c of signedOut) atRisk[c.id] = agentsAtRisk(roster, c.id);
  }
  const outcome = await updateStore(store => {
    const plan = planAlerts(store, report, nowMs, atRisk);
    const applied = applyReport(store, report, nowMs);
    applied.store.alerts = { ...applied.store.alerts, ...plan.alertedAt };
    return { store: applied.store, result: { alerts: plan.alerts, changes: applied.changes } };
  });
  const nowIso = new Date(nowMs).toISOString();
  try {
    await mutateChannels('harness-health:record', async data => {
      let dirty = false;
      for (const entry of report.agents) {
        const channel = data.channels.find(c => c.id === entry.channelId);
        const rosterAgent = channel?.roster?.agents.find(a => a.participantId === entry.participantId);
        if (!rosterAgent) continue;
        const next = nextAgentHealth(rosterAgent.harnessHealth, entry, nowIso);
        if (JSON.stringify(next) !== JSON.stringify(rosterAgent.harnessHealth)) {
          if (next) rosterAgent.harnessHealth = next; else delete rosterAgent.harnessHealth;
          dirty = true;
        }
      }
      if (dirty) await saveChannels(data);
    });
  } catch {
    // The badge is best effort; the credential state above is already stored.
  }
  for (const alert of outcome.alerts) {
    try { await appendMessage(alert.channelId, systemMessage(alert.channelId, alert.text)); } catch { /* a missed alert must not fail the report */ }
  }
  return { changed: outcome.changes.length, alerted: outcome.alerts.length };
}

// ── Signing in ───────────────────────────────────────────────────────────────

const SIGN_IN_ID_RE = /^[0-9a-f]{8}$/;

function refusalToError(refusal: Refusal): RequestError {
  switch (refusal.code) {
    case 'BAD_CODE': return new RequestError(400, 'BAD_CODE', refusal.error);
    case 'NOT_FOUND': return new RequestError(404, 'NOT_FOUND', refusal.error);
    case 'NOT_INSTALLED': return new RequestError(409, 'NOT_INSTALLED', refusal.error);
    default: return new RequestError(409, refusal.code, refusal.error);   // SIGN_IN_ENDED, NOT_READY, NO_CODE_NEEDED, ALREADY_SIGNED_IN
  }
}

async function call(host: HostId, action: Parameters<typeof runSignInTool>[1], args: Parameters<typeof runSignInTool>[2]): Promise<Record<string, unknown>> {
  try {
    const result = await runSignInTool(host, action, args);
    if (isRefusal(result)) throw refusalToError(result);
    return result as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if ((error as { code?: string })?.code === 'HOST_OFFLINE') throw new RequestError(503, 'HOST_OFFLINE', 'That machine is not answering right now');
    throw new RequestError(502, 'SIGN_IN_HELPER', error instanceof Error ? error.message : 'The sign-in helper failed');
  }
}

export async function startSignIn(credential: unknown): Promise<{ signIn: SignInView; alreadyActive: boolean }> {
  const parsed = parseCredentialId(credential);
  if (!parsed) throw new RequestError(400, 'BAD_CREDENTIAL', 'credentialId must be claude@desktop, claude@server, codex@desktop, codex@server, antigravity@desktop or antigravity@server');
  const result = await call(parsed.host, 'start', { harness: parsed.harness });
  const view = asView(result);
  signInOwner.set(view.id, parsed.host);
  cache.lists.delete(parsed.host);
  return { signIn: view, alreadyActive: result.alreadyActive === true };
}

async function ownerOf(signInId: string): Promise<HostId> {
  if (!SIGN_IN_ID_RE.test(signInId)) throw new RequestError(404, 'NOT_FOUND', 'That sign-in is gone; start again');
  const known = signInOwner.get(signInId);
  if (known) return known;
  for (const host of HOSTS) {                       // after a server restart: ask each machine
    try { await call(host, 'status', { id: signInId }); signInOwner.set(signInId, host); return host; } catch { /* not there */ }
  }
  throw new RequestError(404, 'NOT_FOUND', 'That sign-in is gone; start again');
}

export async function submitCode(signInId: unknown, code: unknown): Promise<SignInView> {
  if (typeof signInId !== 'string') throw new RequestError(400, 'BAD_REQUEST', 'signInId is required');
  if (typeof code !== 'string' || code.length < 8 || code.length > 512) throw new RequestError(400, 'BAD_CODE', "That doesn't look like a sign-in code. Copy the whole code from the page.");
  const host = await ownerOf(signInId);
  const view = asView(await call(host, 'code', { id: signInId, code }));
  cache.lists.delete(host);
  return view;
}

export async function cancelSignIn(signInId: unknown): Promise<void> {
  if (typeof signInId !== 'string') throw new RequestError(400, 'BAD_REQUEST', 'signInId is required');
  const host = await ownerOf(signInId);
  await call(host, 'cancel', { id: signInId });
  cache.lists.delete(host);
}

// ── Restarting what was blocked ──────────────────────────────────────────────

export async function restartBlocked(credential: unknown, origin: string): Promise<{ restarted: string[]; skipped: Array<{ name: string; reason: string }> }> {
  const parsed = parseCredentialId(credential);
  if (!parsed) throw new RequestError(400, 'BAD_CREDENTIAL', 'credentialId is not valid');
  const id = credentialId(parsed.harness, parsed.host);
  const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, { channels: [], lastUpdated: new Date().toISOString() });
  const restarted: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const nowMs = Date.now();
  for (const channel of data.channels) {
    for (const agent of channel.roster?.agents ?? []) {
      const health = agent.harnessHealth;
      if (!health || health.credentialId !== id || !isFresh(health.reportedAt, nowMs)) continue;
      if (agent.status !== 'running') { skipped.push({ name: agent.name, reason: 'not running' }); continue; }
      try {
        const response = await fetch(`${origin}/api/collab/pty`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'roster_respawn', channelId: channel.id, agentId: agent.id }),
        });
        const body = await response.json().catch(() => ({} as { error?: string }));
        if (response.ok && body.success !== false) restarted.push(agent.name);
        else skipped.push({ name: agent.name, reason: String(body.error ?? `HTTP ${response.status}`).slice(0, 120) });
      } catch (error) {
        skipped.push({ name: agent.name, reason: error instanceof Error ? error.message.slice(0, 120) : 'failed' });
      }
    }
  }
  return { restarted, skipped };
}
