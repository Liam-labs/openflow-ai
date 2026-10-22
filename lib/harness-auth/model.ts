/**
 * Harness sign-in health: the decisions, as pure functions.
 *
 * A CREDENTIAL is one harness login on one machine: claude@desktop, claude@server, codex@desktop, codex@server ("server" is the machine
 * DevFlow runs on, "desktop" the machine that runs the agents). A watcher on each machine (scripts/harness_health.py) reports what it sees;
 * this module turns reports into stored state, decides who needs telling, and shapes what the dashboard reads.
 * Design and evidence: platform/harness-signin-health.md. Nothing here touches disk or the network.
 */

import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';
export type HarnessId = 'claude' | 'codex';
/** Programs that can be signed in from the page. Antigravity (Gemini) has a login but no health watcher, so it is not a HarnessId. */
export type SignInHarnessId = HarnessId | 'antigravity';
export type HostId = 'desktop' | 'server';
export type CredentialState = 'ok' | 'needs_login' | 'limit_reached' | 'unknown';
export type AgentHealthState = 'ok' | 'needs_login' | 'limit_reached';

export const HARNESSES: readonly HarnessId[] = ['claude', 'codex'];
export const SIGN_IN_HARNESSES: readonly SignInHarnessId[] = [...HARNESSES, 'antigravity'];
export const HOSTS: readonly HostId[] = ['desktop', 'server'];
/** A report older than this is treated as "no recent check": the watcher may be down, and a badge must not outlive its evidence. */
export const REPORT_FRESH_MS = 15 * 60_000;
/** A problem that is still there is mentioned again after this long, not before. */
export const ALERT_REPEAT_MS = 6 * 3_600_000;

const MAX_AGENTS = 200;
const MAX_TEXT = 200;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function credentialId(harness: SignInHarnessId, host: HostId): string {
  return `${harness}@${host}`;
}

export function parseCredentialId(id: unknown): { harness: SignInHarnessId; host: HostId } | null {
  if (typeof id !== 'string') return null;
  const [harness, host, extra] = id.split('@');
  if (extra !== undefined || !SIGN_IN_HARNESSES.includes(harness as SignInHarnessId) || !HOSTS.includes(host as HostId)) return null;
  return { harness: harness as SignInHarnessId, host: host as HostId };
}

export function credentialLabel(harness: SignInHarnessId, host: HostId): string {
  return `${harness === 'claude' ? 'Claude' : harness === 'codex' ? 'Codex' : 'Antigravity'} on the ${host === 'desktop' ? 'desktop' : 'Remote server'}`;
}

export function harnessOfAgentType(agentType: unknown): HarnessId | null {
  return agentType === 'claude' || agentType === 'claude-terminal' ? 'claude' : agentType === 'codex' ? 'codex' : null;
}

export function hostOfAgent(agent: { runLocation?: string | null }): HostId {
  return agent.runLocation === 'server' ? 'server' : 'desktop';
}

export interface AtRiskAgent { channelId: string; name: string }

/** Running agents that use this login. Signing out does not stop one that is already running, but it cannot restart until the login is back. */
export function agentsAtRisk(agents: RosterAgentLite[], credential: string): AtRiskAgent[] {
  const parsed = parseCredentialId(credential);
  if (!parsed) return [];
  return agents
    .filter(a => a.status === 'running' && !!a.channelId && harnessOfAgentType(a.agentType) === parsed.harness && hostOfAgent(a) === parsed.host)
    .map(a => ({ channelId: a.channelId as string, name: a.name }));
}

export interface UsageInfo { percent: number; window: 'session' | 'weekly'; resetsAt: string | null }

export interface StoredCredential {
  id: string; harness: HarnessId; host: HostId;
  state: CredentialState; detail: string; plan: string | null; usage: UsageInfo | null;
  checkedAt: string; since: string; reportedAt: string;
}

export interface AlertRecord { state: string; alertedAt: string }
/** The account (email) each login was last seen signed in with. Kept after a sign-out, because a sign-out is exactly when it is needed. */
export interface AccountRecord { email: string; seenAt: string }
export interface Store { credentials: Record<string, StoredCredential>; alerts: Record<string, AlertRecord>; accounts?: Record<string, AccountRecord> }
export const emptyStore = (): Store => ({ credentials: {}, alerts: {}, accounts: {} });

export interface ReportAgent {
  channelId: string; participantId: string; name: string; credentialId: string;
  state: AgentHealthState; detail: string | null; resetsAt: string | null; window: 'session' | 'weekly' | null;
}
export interface ReportCredential {
  id: string; state: CredentialState; detail: string; plan: string | null; usage: UsageInfo | null; checkedAt: string; since: string | null;
  account?: string | null;
}
export interface Report { host: HostId; credentials: ReportCredential[]; agents: ReportAgent[] }

// ── Validation ────────────────────────────────────────────────────────────────

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = MAX_TEXT): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
/** An email address or null. Lenient on purpose: an account label is a convenience, so a bad one is dropped, never a reason to refuse a report. */
export const cleanEmail = (v: unknown): string | null => (typeof v === 'string' && v.length <= 254 && /^[^@\s]{1,64}@[^@\s]{1,190}$/.test(v) ? v : null);
const isoOrNull = (v: unknown): string | null | undefined => (v === null || v === undefined ? null : typeof v === 'string' && ISO_RE.test(v) ? v : undefined);

function checkUsage(v: unknown): UsageInfo | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) return undefined;
  const percent = v.percent;
  const window = v.window;
  const resetsAt = isoOrNull(v.resetsAt);
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 1000) return undefined;
  if (window !== 'session' && window !== 'weekly') return undefined;
  if (resetsAt === undefined) return undefined;
  return { percent, window, resetsAt };
}

/** Strict on shape and size: the watcher is trusted to be honest, not to be bug-free. */
export function validateReport(body: unknown): Checked<Report> {
  if (!isObj(body)) return { ok: false, error: 'body must be an object' };
  if (!HOSTS.includes(body.host as HostId)) return { ok: false, error: 'host must be desktop or server' };
  const host = body.host as HostId;
  if (!Array.isArray(body.credentials) || body.credentials.length > HARNESSES.length * HOSTS.length) return { ok: false, error: 'credentials must be a short array' };
  if (!Array.isArray(body.agents) || body.agents.length > MAX_AGENTS) return { ok: false, error: 'agents must be an array of at most 200' };
  const credentials: ReportCredential[] = [];
  for (const raw of body.credentials) {
    if (!isObj(raw)) return { ok: false, error: 'credential must be an object' };
    const parsed = parseCredentialId(raw.id);
    // A watcher reports the logins it tracks health for (claude, codex); Antigravity's state is read on demand, never reported.
    if (!parsed || parsed.host !== host || !HARNESSES.includes(parsed.harness as HarnessId)) return { ok: false, error: `credential id ${String(raw.id).slice(0, 40)} is not valid for host ${host}` };
    if (!['ok', 'needs_login', 'limit_reached', 'unknown'].includes(raw.state as string)) return { ok: false, error: 'credential state is not valid' };
    const detail = text(raw.detail);
    const usage = checkUsage(raw.usage);
    const checkedAt = isoOrNull(raw.checkedAt);
    const since = isoOrNull(raw.since);
    if (!detail) return { ok: false, error: 'credential detail is required (200 characters at most)' };
    if (usage === undefined) return { ok: false, error: 'credential usage is not valid' };
    if (checkedAt === undefined || since === undefined) return { ok: false, error: 'credential timestamps must be ISO UTC' };
    const plan = raw.plan === null || raw.plan === undefined ? null : text(raw.plan, 60);
    if (raw.plan !== null && raw.plan !== undefined && plan === null) return { ok: false, error: 'credential plan is not valid' };
    credentials.push({ id: raw.id as string, state: raw.state as CredentialState, detail, plan, usage, checkedAt: checkedAt ?? new Date(0).toISOString(), since, account: cleanEmail(raw.account) });
  }
  const agents: ReportAgent[] = [];
  for (const raw of body.agents) {
    if (!isObj(raw)) return { ok: false, error: 'agent must be an object' };
    const parsed = parseCredentialId(raw.credentialId);
    if (!parsed || parsed.host !== host) return { ok: false, error: 'agent credentialId is not valid for this host' };
    if (!['ok', 'needs_login', 'limit_reached'].includes(raw.state as string)) return { ok: false, error: 'agent state is not valid' };
    const channelId = text(raw.channelId, 100);
    const participantId = text(raw.participantId, 100);
    const name = text(raw.name, 80);
    const resetsAt = isoOrNull(raw.resetsAt);
    if (!channelId || !participantId || !name) return { ok: false, error: 'agent needs channelId, participantId and name' };
    if (resetsAt === undefined) return { ok: false, error: 'agent resetsAt must be ISO UTC' };
    const detail = raw.detail === null || raw.detail === undefined ? null : text(raw.detail);
    if (raw.detail !== null && raw.detail !== undefined && detail === null) return { ok: false, error: 'agent detail is not valid' };
    const window = raw.window === 'session' || raw.window === 'weekly' ? raw.window : null;
    agents.push({ channelId, participantId, name, credentialId: raw.credentialId as string, state: raw.state as AgentHealthState, detail, resetsAt, window });
  }
  return { ok: true, value: { host, credentials, agents } };
}

// ── Applying a report ─────────────────────────────────────────────────────────

export function isFresh(reportedAt: string | undefined, nowMs: number): boolean {
  const at = reportedAt ? Date.parse(reportedAt) : NaN;
  return Number.isFinite(at) && nowMs - at <= REPORT_FRESH_MS;
}

/** The stored credential as the dashboard should see it now: a stale report becomes "unknown", never a confident old answer. */
export function effectiveCredential(c: StoredCredential, nowMs: number): StoredCredential {
  if (isFresh(c.reportedAt, nowMs)) return c;
  return { ...c, state: 'unknown', detail: 'No recent check from the watcher on that machine', usage: null };
}

export interface CredentialChange { id: string; from: CredentialState | null; to: CredentialState }

export function applyReport(store: Store, report: Report, nowMs: number): { store: Store; changes: CredentialChange[] } {
  const reportedAt = new Date(nowMs).toISOString();
  const next: Store = { credentials: { ...store.credentials }, alerts: { ...store.alerts }, accounts: { ...(store.accounts ?? {}) } };
  const changes: CredentialChange[] = [];
  for (const c of report.credentials) {
    const parsed = parseCredentialId(c.id)! as { harness: HarnessId; host: HostId };
    const previous = store.credentials[c.id];
    const previousState = previous && isFresh(previous.reportedAt, nowMs) ? previous.state : previous ? 'unknown' : null;
    const unchanged = previous?.state === c.state;
    next.credentials[c.id] = {
      id: c.id, harness: parsed.harness, host: parsed.host, state: c.state, detail: c.detail, plan: c.plan, usage: c.usage,
      checkedAt: c.checkedAt, reportedAt, since: unchanged && previous ? previous.since : (c.since ?? reportedAt),
    };
    if (c.state === 'ok' && c.account && next.accounts![c.id]?.email !== c.account) next.accounts![c.id] = { email: c.account, seenAt: reportedAt };
    if (previousState !== c.state) changes.push({ id: c.id, from: previousState, to: c.state });
    if (c.state === 'ok' || c.state === 'unknown') delete next.alerts[c.id];    // a recovered credential may alert again at once if it relapses
  }
  return { store: next, changes };
}

// ── Telling the owner, once ────────────────────────────────────────────────────────

export interface Alert { credentialId: string; state: 'needs_login' | 'limit_reached'; channelId: string; text: string }

function formatReset(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${day} ${time} UTC`;
}

function names(list: string[]): string {
  if (list.length <= 2) return list.join(' and ');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** One message per channel that has blocked agents, when a credential newly breaks (or is still broken after ALERT_REPEAT_MS). */
export function planAlerts(
  store: Store, report: Report, nowMs: number, atRisk: Record<string, AtRiskAgent[]> = {},
): { alerts: Alert[]; alertedAt: Record<string, AlertRecord> } {
  const alerts: Alert[] = [];
  const alertedAt: Record<string, AlertRecord> = {};
  for (const c of report.credentials) {
    if (c.state !== 'needs_login' && c.state !== 'limit_reached') continue;
    const blocked = report.agents.filter(a => a.credentialId === c.id && a.state === c.state);
    // A signed-out login is worth telling the owner about before anything fails, as long as some running agent uses it.
    const warnOnly = blocked.length === 0 && c.state === 'needs_login' ? (atRisk[c.id] ?? []) : [];
    if (blocked.length === 0 && warnOnly.length === 0) continue;                // nobody is using or waiting on it, so nobody needs interrupting
    const prior = store.alerts[c.id];
    const repeat = prior && prior.state === c.state && nowMs - Date.parse(prior.alertedAt) >= ALERT_REPEAT_MS;
    if (prior && prior.state === c.state && !repeat) continue;
    const parsed = parseCredentialId(c.id)! as { harness: HarnessId; host: HostId };
    const label = credentialLabel(parsed.harness, parsed.host);
    const reset = blocked.map(a => a.resetsAt).filter((r): r is string => !!r).sort()[0];
    const byChannel = new Map<string, string[]>();
    for (const a of blocked.length ? blocked : warnOnly) byChannel.set(a.channelId, [...(byChannel.get(a.channelId) ?? []), a.name]);
    for (const [channelId, who] of byChannel) {
      const many = who.length > 1;
      const body = c.state === 'limit_reached'
        ? `**${label} has hit its usage limit.** ${names(who)} ${many ? 'are' : 'is'} paused${reset ? ` until ${formatReset(reset)}` : ''}.`
        : blocked.length
          ? `**${label} needs signing in.** ${names(who)} can't work until it's fixed. Click the red "Needs sign-in" badge on ${many ? 'their cards' : 'their card'}, or the key button in the sidebar, to sign in without a terminal.`
          : `**${label} is signed out.** ${names(who)} can keep going for now, but won't be able to restart until it's fixed. Click the key button in the sidebar to sign in without a terminal.`;
      alerts.push({ credentialId: c.id, state: c.state, channelId, text: `@${HUMAN_ROUTING_NAME} ${body}` });
    }
    alertedAt[c.id] = { state: c.state, alertedAt: new Date(nowMs).toISOString() };
  }
  return { alerts, alertedAt };
}

// ── The roster badge ──────────────────────────────────────────────────────────

export interface HarnessHealth { credentialId: string; state: 'needs_login' | 'limit_reached'; detail: string; resetsAt?: string; since: string; reportedAt?: string }

/** The new `harnessHealth` for a roster agent given a reported entry; undefined means "remove the badge". */
export function nextAgentHealth(existing: HarnessHealth | undefined, entry: ReportAgent, nowIso: string): HarnessHealth | undefined {
  if (entry.state === 'ok') return undefined;
  const sameProblem = existing && existing.credentialId === entry.credentialId && existing.state === entry.state;
  return {
    credentialId: entry.credentialId, state: entry.state,
    detail: entry.detail ?? (entry.state === 'needs_login' ? 'Login expired' : 'Usage limit reached'),
    ...(entry.resetsAt ? { resetsAt: entry.resetsAt } : {}),
    since: sameProblem ? existing.since : nowIso, reportedAt: nowIso,
  };
}

// ── What the dashboard reads ──────────────────────────────────────────────────

export interface SignInView {
  id: string; harness: SignInHarnessId; kind: 'paste-code' | 'device-code';
  state: 'starting' | 'waiting' | 'verifying' | 'done' | 'failed' | 'expired';
  url?: string | null; userCode?: string | null; message?: string | null; expiresAt?: string; startedAt?: string;
}
export interface AgentView { id: string; name: string; running: boolean; blocked: boolean }

/**
 * Plain-English help shown with a sign-in, so nobody has to work out which account to use or what to switch on first. All fields are
 * optional plain text.
 *
 * Nothing here names an account unless the system has actually SEEN one (`accountHint` comes from the account a login was last signed in
 * with). On 18 Oct 2026 a hard-coded address taken from a chat message was wrong: the owner's Codex login is his Gmail account. The Codex
 * setup steps exist because OpenAI refuses a device code until "device code sign-in" is switched on in the account's ChatGPT security
 * settings, and shows that refusal on its own web page, where the CLI cannot see it, so the only way to warn is up front.
 */
export interface SignInHints {
  /** The account this login was last signed in with, when we have seen it. */
  accountHint?: string;
  /** One line about the one-off thing the provider may demand before the code is accepted (for the list row). */
  setupHint?: string;
  /** Heading for the steps, and the steps themselves in order: short plain sentences, the first of which the link below belongs to. */
  setupTitle?: string;
  setupSteps?: string[];
  /** The link for the first step, and its text. */
  setupUrl?: string;
  setupLabel?: string;
}

const CHATGPT_SECURITY_URL = 'https://chatgpt.com/#settings/Security';

/**
 * `account` is the email this login was last seen with; `setupDone` is true once this program has been signed in on any machine
 * (the device-code switch belongs to the account, so it is already on). The one-off setup steps are shown only while it is not.
 */
export function signInHints(
  harness: SignInHarnessId,
  known: { account?: string | null; setupDone: boolean; otherMachine?: { email: string; where: string; label: string } | null },
): SignInHints {
  const hints: SignInHints = {};
  if (known.account) hints.accountHint = `Sign in with ${known.account}. It is the account this login used last.`;
  else if (known.otherMachine) hints.accountHint = `${known.otherMachine.label} last used ${known.otherMachine.email}. Sign in with the same account here.`;
  if (harness === 'codex' && !known.setupDone) {
    const who = known.account ?? known.otherMachine?.email ?? 'the ChatGPT account you use for Codex';
    hints.setupHint = 'First time only: if OpenAI says "Enable device code sign-in", switch it on in ChatGPT Security Settings, then press Sign in again for a fresh code.';
    hints.setupTitle = 'First time only: one-off setup';
    hints.setupSteps = [
      `Open ChatGPT Security Settings, signed in to ${who}.`,
      'Switch on "device code sign-in" (it names Codex, Excel, PowerPoint and Word).',
      'Come back here, press Cancel sign-in, then Sign in again for a fresh code. The old one expires.',
      `On the OpenAI page, check it is ${who}. If it offers another account, choose "Use another account". Enter the new code and press Continue. Codex turns to signed in within seconds.`,
    ];
    hints.setupUrl = CHATGPT_SECURITY_URL;
    hints.setupLabel = 'ChatGPT Security Settings';
  }
  return hints;
}

export interface CredentialView extends SignInHints {
  id: string; harness: SignInHarnessId; host: HostId; label: string; state: CredentialState; detail: string; plan?: string;
  /** The account (email) this login is signed in with now, or was last signed in with when it is signed out. Absent until one has been seen. */
  account?: string;
  usage?: UsageInfo; checkedAt: string; signIn: SignInView | null; agents: AgentView[];
}
export interface RosterAgentLite { id: string; name: string; channelId?: string; agentType?: string; runLocation?: string | null; status?: string; harnessHealth?: HarnessHealth }

export function buildViews(input: {
  store: Store; localProbes: Partial<Record<string, { state: CredentialState; detail: string; plan: string | null; checkedAt: string; account?: string | null }>>;
  agents: RosterAgentLite[]; signIns: Record<HostId, SignInView[]>; nowMs: number;
}): CredentialView[] {
  const views: CredentialView[] = [];
  // Once a program has been signed in anywhere its one-off setup is done (it belongs to the account, not the machine).
  const everSignedIn = (harness: HarnessId) => HOSTS.some(h => {
    const id = credentialId(harness, h);
    return input.store.credentials[id]?.state === 'ok' || input.localProbes[id]?.state === 'ok' || !!input.store.accounts?.[id];
  });
  for (const host of HOSTS) {
    for (const harness of HARNESSES) {
      const id = credentialId(harness, host);
      const stored = input.store.credentials[id];
      const probe = input.localProbes[id];
      const effective = stored ? effectiveCredential(stored, input.nowMs) : undefined;
      // The server's own logins can be probed directly; the desktop's come from its watcher, so without a fresh report they are "unknown".
      const useProbe = probe && (!effective || effective.state === 'unknown');
      const state: CredentialState = useProbe ? probe.state : effective ? effective.state : 'unknown';
      const detail = useProbe ? probe.detail : effective ? effective.detail : 'The watcher on that machine has not reported yet';
      const plan = (useProbe ? probe.plan : effective?.plan) ?? undefined;
      const usage = effective && effective.state !== 'unknown' && effective.usage ? effective.usage : undefined;
      const mine = input.agents.filter(a => harnessOfAgentType(a.agentType) === harness && hostOfAgent(a) === host);
      const agents: AgentView[] = mine
        .map(a => ({ id: a.id, name: a.name, running: a.status === 'running',
                     blocked: !!a.harnessHealth && a.harnessHealth.credentialId === id && isFresh(a.harnessHealth.reportedAt, input.nowMs) }))
        .filter(a => a.running || a.blocked);
      const hostSignIns = input.signIns[host] ?? [];
      const signIn = hostSignIns.find(s => s.harness === harness && (s.state === 'starting' || s.state === 'waiting' || s.state === 'verifying'))
        ?? hostSignIns.find(s => s.harness === harness) ?? null;
      // The account a login is using right now beats the one on record; the record is what is left when it is signed out.
      const accountOf = (credential: string) => (input.localProbes[credential]?.state === 'ok' ? input.localProbes[credential]?.account : null) || input.store.accounts?.[credential]?.email || undefined;
      const account = accountOf(id);
      // The same program is usually signed in with the same account on the other machine, so that is the best suggestion when this one has none.
      const otherHost = HOSTS.find(h => h !== host)!;
      const otherEmail = accountOf(credentialId(harness, otherHost));
      const otherMachine = !account && otherEmail ? { email: otherEmail, where: otherHost, label: credentialLabel(harness, otherHost) } : null;
      views.push({
        id, harness, host, label: credentialLabel(harness, host), state, detail, ...(plan ? { plan } : {}), ...(account ? { account } : {}),
        ...(usage ? { usage } : {}), checkedAt: useProbe ? probe.checkedAt : effective?.checkedAt ?? new Date(0).toISOString(), signIn, agents,
        ...signInHints(harness, { account, setupDone: everSignedIn(harness), otherMachine }),
      });
    }
  }
  return views;
}
