import { runsInContainer } from '@/lib/runs-in-container';
import { isolatedTailscaleNode, tailscaleSocketArgs } from './tailscale-runtime';
/**
 * Remote-access wizard, Tailscale route (stage 1 of the setup wizards).
 *
 * Check  is Tailscale installed and signed in, can this tailnet use https, what is already served.
 * Do     `tailscale serve` this app's loopback address to the user's own tailnet. Serve only: nothing is put on the public
 *        internet, and no code path here can run the command that does that (see ALLOWED below; a test pins it).
 * Prove  a request with no credentials, sent through the real tailnet address, must land on the sign-in page, and the API
 *        must refuse it. Then the user opens the address on a second device and the wizard sees it arrive.
 * Undo   remove only the Serve entry this wizard added, and only if it is still the one we added.
 *
 * Needs a sign-in password first (lib/wizards/sign-in.ts): the app refuses to start with remote access on and none set.
 * Native hosts keep their existing login; the isolated container supports explicit owner-initiated sign-in.
 * Neither path changes ACLs or unrelated Serve entries.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { DataPaths } from '../data-paths';
import { readJsonFileStrict, writeJsonFile } from '../data-io';
import { listensOnLoopbackOnly } from '../local-trust';
import { hasPassword } from '../dashboard-auth';
import { isBrowserDebugPort } from './ports';

type Env = Record<string, string | undefined>;

export interface TsResult { code: number; stdout: string; stderr: string }
export type RunTs = (args: string[]) => Promise<TsResult>;

// ─── The only commands this wizard may run ───────────────────────────────────────────────────────────

const PORT = /^\d{1,5}$/;
const SERVE_FLAG = /^--(https|http)=(\d{1,5})$/;

/** True for exactly the Tailscale commands the wizard uses. `funnel` (public internet) is not among them, nor is anything else. */
export function allowedTailscaleArgs(args: string[]): boolean {
  const key = args.join(' ');
  if (key === 'version' || key === 'status --json' || key === 'serve status --json' || key === 'debug prefs') return true;
  if (args.length === 4 && args[0] === 'serve' && args[1] === '--bg') {
    const flag = SERVE_FLAG.exec(args[2]);
    const target = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(args[3] ?? '');
    return !!flag && !!target && validPort(Number(flag[2])) && validPort(Number(target[1]));
  }
  if (args.length === 3 && args[0] === 'serve' && args[2] === 'off') {
    const flag = SERVE_FLAG.exec(args[1]);
    return !!flag && validPort(Number(flag[2]));
  }
  return false;
}

function validPort(n: number): boolean { return Number.isInteger(n) && n >= 1 && n <= 65535; }

const MAC_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export function tailscaleBinary(): string {
  return existsSync(MAC_APP) ? MAC_APP : 'tailscale';
}

export const defaultRunTs: RunTs = (args) => new Promise((resolve) => {
  if (!allowedTailscaleArgs(args)) { resolve({ code: 126, stdout: '', stderr: 'command not allowed' }); return; }
  execFile(tailscaleBinary(), [...tailscaleSocketArgs(), ...args], { timeout: 20000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 127) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) + (error && code === 127 ? ` ${error.message}` : '') });
  });
});

// ─── Facts (pure parsing) ────────────────────────────────────────────────────────────────────────────

export interface ServeEntry { port: number; https: boolean; target: string | null }

export interface TailscaleFacts {
  installed: boolean;
  version: string | null;
  state: string | null;            // Running, NeedsLogin, Stopped ...
  dnsName: string | null;          // this computer's name on the tailnet, no trailing dot
  ips: string[];
  httpsReady: boolean;             // the tailnet has https certificates switched on
  operatorOk: boolean;             // may this user change Serve without sudo
  /** The app runs in a container: Tailscale belongs on the host computer, so the wizard shows commands instead of running them. */
  inContainer: boolean;
  isolatedNode?: boolean;
  serve: ServeEntry[];
}

export function parseStatus(json: string): Pick<TailscaleFacts, 'state' | 'dnsName' | 'ips' | 'httpsReady'> {
  try {
    const d = JSON.parse(json) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] }; CertDomains?: string[] | null };
    return {
      state: typeof d.BackendState === 'string' ? d.BackendState : null,
      dnsName: d.Self?.DNSName ? d.Self.DNSName.replace(/\.$/, '') : null,
      ips: Array.isArray(d.Self?.TailscaleIPs) ? d.Self!.TailscaleIPs!.filter((x): x is string => typeof x === 'string') : [],
      httpsReady: Array.isArray(d.CertDomains) && d.CertDomains.length > 0,
    };
  } catch {
    return { state: null, dnsName: null, ips: [], httpsReady: false };
  }
}

export function parseServe(json: string): ServeEntry[] {
  try {
    const d = JSON.parse(json) as { TCP?: Record<string, { HTTP?: boolean; HTTPS?: boolean; TCPForward?: string }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    const entries: ServeEntry[] = [];
    for (const [portText, tcp] of Object.entries(d.TCP ?? {})) {
      const port = Number(portText);
      if (!validPort(port)) continue;
      let target: string | null = tcp.TCPForward ?? null;
      for (const [hostPort, web] of Object.entries(d.Web ?? {})) {
        if (hostPort.endsWith(`:${port}`)) target = web.Handlers?.['/']?.Proxy ?? target;
      }
      entries.push({ port, https: !!tcp.HTTPS, target });
    }
    return entries;
  } catch {
    return [];
  }
}

export { runsInContainer };

export async function gatherFacts(run: RunTs = defaultRunTs, inContainer: boolean = runsInContainer()): Promise<TailscaleFacts> {
  const isolatedNode = inContainer && isolatedTailscaleNode();
  if (inContainer && !isolatedNode) return { installed: false, version: null, state: null, dnsName: null, ips: [], httpsReady: false, operatorOk: false, inContainer: true, serve: [] };
  const version = await run(['version']);
  if (version.code !== 0) return { installed: false, version: null, state: null, dnsName: null, ips: [], httpsReady: false, operatorOk: false, inContainer: false, serve: [] };
  const [status, serve, prefs] = await Promise.all([run(['status', '--json']), run(['serve', 'status', '--json']), run(['debug', 'prefs'])]);
  let operatorOk = false;
  try { operatorOk = !!(JSON.parse(prefs.stdout) as { OperatorUser?: string }).OperatorUser || (typeof process.getuid === 'function' && process.getuid() === 0); } catch { /* unreadable prefs: ask for the one-time command */ }
  return { installed: true, version: version.stdout.split('\n')[0].trim() || null, ...parseStatus(status.stdout), operatorOk: operatorOk || isolatedNode, inContainer, isolatedNode, serve: parseServe(serve.stdout) };
}

// ─── The plan (pure) ─────────────────────────────────────────────────────────────────────────────────

export interface ServePlan { ok: true; https: boolean; port: number; target: string; url: string }
export type PlanResult = ServePlan | { ok: false; reason: string; fix?: string };

/** What the wizard would do, or why it cannot. Never plans over a port something else already serves. */
export function planServe(facts: TailscaleFacts, appPort: number): PlanResult {
  if (facts.inContainer && !facts.isolatedNode) return { ok: false, reason: 'This app runs in a container, so Tailscale has to be set up on the computer that hosts it.', fix: 'container' };
  if (facts.isolatedNode && !facts.httpsReady && facts.state === 'Running') return { ok: false, reason: 'Enable HTTPS certificates in your Tailscale account before sharing this server. Owner sign-in requires HTTPS.', fix: 'https' };
  if (isBrowserDebugPort(appPort)) return { ok: false, reason: 'That port is a browser debugging port. It controls every website you are signed in to and is never shared.' };
  if (!facts.installed) return { ok: false, reason: 'Tailscale is not installed on this computer.', fix: 'install' };
  if (facts.state !== 'Running' || !facts.dnsName) return { ok: false, reason: 'Tailscale is installed but not signed in and running.', fix: 'login' };
  if (!facts.operatorOk) return { ok: false, reason: 'Tailscale needs a one-time permission so this app can set up Serve.', fix: 'operator' };
  const used = new Set(facts.serve.map((e) => e.port));
  const candidates = facts.httpsReady ? [443, 8443, 8444, 8445] : [8080, 8081, 8082, 8083];
  const port = candidates.find((p) => !used.has(p));
  if (!port) return { ok: false, reason: 'Every port this wizard would use is already used by another Tailscale Serve entry.' };
  const https = facts.httpsReady;
  const host = facts.dnsName;
  const url = `${https ? 'https' : 'http'}://${host}${(https && port === 443) ? '' : `:${port}`}`;
  return { ok: true, https, port, target: `http://127.0.0.1:${appPort}`, url };
}

// ─── What we recorded (so undo touches only our entry) ───────────────────────────────────────────────

export interface RemoteRecord { enabled: boolean; tailscale?: { port: number; https: boolean; target: string; url: string; at: string } }

export async function readRecord(file = DataPaths.remoteAccess): Promise<RemoteRecord> {
  const data = await readJsonFileStrict<RemoteRecord>(file, { enabled: false }).catch(() => ({ enabled: false } as RemoteRecord));
  return data && typeof data === 'object' ? data : { enabled: false };
}

/** Is the recorded entry still exactly what is being served? Undo only removes it when so. */
export function recordMatches(record: RemoteRecord, serve: ServeEntry[]): boolean {
  const ts = record.tailscale;
  if (!ts) return false;
  const entry = serve.find((e) => e.port === ts.port);
  return !!entry && entry.https === ts.https && entry.target === ts.target;
}

// ─── Enable ──────────────────────────────────────────────────────────────────────────────────────────

export type StepResult = { ok: true; url?: string; note?: string } | { ok: false; error: string; fix?: string };

export interface Deps {
  run: RunTs;
  env: Env;
  passwordSet: () => Promise<boolean>;
  readRecord: () => Promise<RemoteRecord>;
  writeRecord: (record: RemoteRecord) => Promise<void>;
  now: () => string;
}

export const realDeps = (env: Env = process.env): Deps => ({
  run: defaultRunTs,
  env,
  passwordSet: hasPassword,
  readRecord: () => readRecord(),
  writeRecord: (record) => writeJsonFile(DataPaths.remoteAccess, record),
  now: () => new Date().toISOString(),
});

export async function enableTailscale(deps: Deps = realDeps()): Promise<StepResult> {
  if (!(await deps.passwordSet())) return { ok: false, error: 'Set a sign-in password first. Remote access without one would let anyone on your tailnet open the dashboard.', fix: 'password' };
  if (!listensOnLoopbackOnly(deps.env)) return { ok: false, error: 'The app listens beyond this computer (DEVFLOW_BIND_HOST). Serve needs it on 127.0.0.1 only, so the sign-in cannot be bypassed.' };
  const existing = await deps.readRecord();
  const facts = await gatherFacts(deps.run);
  if (existing.tailscale && recordMatches(existing, facts.serve)) return { ok: true, url: existing.tailscale.url, note: 'Already switched on.' };
  const plan = planServe(facts, Number(deps.env.PORT) || 3000);
  if (!plan.ok) return { ok: false, error: plan.reason, fix: plan.fix };

  const flag = `--${plan.https ? 'https' : 'http'}=${plan.port}`;
  const ran = await deps.run(['serve', '--bg', flag, plan.target]);
  if (ran.code !== 0) {
    const denied = /access denied|operator/i.test(ran.stderr + ran.stdout);
    return { ok: false, error: denied ? 'Tailscale refused: this user is not allowed to change Serve yet.' : `Tailscale could not start Serve: ${(ran.stderr || ran.stdout).trim().split('\n')[0] || `exit ${ran.code}`}`, fix: denied ? 'operator' : undefined };
  }
  const after = parseServe((await deps.run(['serve', 'status', '--json'])).stdout);
  const mine = after.find((e) => e.port === plan.port);
  if (!mine || mine.target !== plan.target) {
    await deps.run(['serve', flag, 'off']);
    return { ok: false, error: 'Tailscale accepted the command but the Serve entry did not appear as expected. Nothing was left switched on.' };
  }
  try {
    await deps.writeRecord({ enabled: true, tailscale: { port: plan.port, https: plan.https, target: plan.target, url: plan.url, at: deps.now() } });
  } catch (error) {
    await deps.run(['serve', flag, 'off']);
    return { ok: false, error: `Could not save the setting (${error instanceof Error ? error.message : 'unknown error'}). Serve was switched off again.` };
  }
  return { ok: true, url: plan.url };
}

// ─── Undo ────────────────────────────────────────────────────────────────────────────────────────────

export async function disableTailscale(deps: Deps = realDeps()): Promise<StepResult> {
  const record = await deps.readRecord();
  const ts = record.tailscale;
  if (!ts) return { ok: true, note: 'Remote access through Tailscale was not switched on here.' };
  const before = parseServe((await deps.run(['serve', 'status', '--json'])).stdout);
  let note = 'Switched off.';
  if (recordMatches(record, before)) {
    const ran = await deps.run(['serve', `--${ts.https ? 'https' : 'http'}=${ts.port}`, 'off']);
    if (ran.code !== 0) return { ok: false, error: `Tailscale could not remove the Serve entry: ${(ran.stderr || ran.stdout).trim().split('\n')[0] || `exit ${ran.code}`}`, fix: /access denied|operator/i.test(ran.stderr + ran.stdout) ? 'operator' : undefined };
    const after = parseServe((await deps.run(['serve', 'status', '--json'])).stdout);
    const others = before.filter((e) => e.port !== ts.port);
    const same = others.length === after.length && others.every((e, i) => after[i].port === e.port && after[i].target === e.target && after[i].https === e.https);
    if (!same) return { ok: false, error: 'After removing it, Tailscale Serve did not look as expected. Check `tailscale serve status` yourself.' };
  } else {
    note = 'That Serve entry had already been changed or removed outside this wizard, so Tailscale was left alone.';
  }
  await deps.writeRecord({ enabled: false });
  return { ok: true, note };
}

// ─── Prove ───────────────────────────────────────────────────────────────────────────────────────────

export interface Fetch1 { (url: string): Promise<{ status: number }> }
export interface ProofStep { name: string; ok: boolean; detail: string }

export const realFetch1: Fetch1 = async (url) => {
  if (isolatedTailscaleNode()) {
    const code = await new Promise<string>((resolve, reject) => {
      execFile('curl', ['--silent', '--show-error', '--proxy', 'http://127.0.0.1:1055', '--max-time', '10', '--output', '/dev/null', '--write-out', '%{http_code}', url], { timeout: 12000, maxBuffer: 4096 }, (error, stdout) => error ? reject(new Error('The isolated tailnet proxy could not reach the address.')) : resolve(stdout));
    });
    return { status: Number(code) };
  }
  const res = await fetch(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  return { status: res.status };
};

/**
 * From this computer: does the tailnet address reach the app at all? A request from this computer's own tailnet address counts as
 * this computer (it opens without sign-in, as it always does), so this step cannot show the sign-in holds. That is the second device's job.
 */
export async function proveReachable(url: string, fetch1: Fetch1 = realFetch1): Promise<{ ok: boolean; steps: ProofStep[] }> {
  try {
    const res = await fetch1(`${url}/api/auth/session`);
    const ok = res.status === 200;
    return { ok, steps: [{ name: 'The address reaches this app through Tailscale', ok, detail: ok ? 'The tailnet address answered.' : `Answer ${res.status} from ${url}.` }] };
  } catch (error) {
    return { ok: false, steps: [{ name: 'The address reaches this app through Tailscale', ok: false, detail: `Could not reach ${url}: ${error instanceof Error ? error.message : 'unknown error'}. Is Tailscale running on this computer?` }] };
  }
}

export interface SecondDevice { state: 'waiting' | 'ok' | 'open'; detail: string }

/** What the visits from OTHER devices say. One that got in without signing in beats any number that were turned away. */
export function judgeSecondDevice(visits: { device: string; allowed: boolean; authenticated?: boolean }[]): SecondDevice {
  const open = visits.find((v) => v.allowed && !v.authenticated);
  if (open) return { state: 'open', detail: `${open.device} opened the dashboard WITHOUT signing in. Something is treating Tailscale devices as this computer (DEVFLOW_TRUST_TAILNET=1). Switch remote access off and turn that setting off.` };
  const signedIn = visits.find((v) => v.allowed && v.authenticated);
  if (signedIn) return { state: 'ok', detail: `${signedIn.device} reached the dashboard with a verified owner sign-in.` };
  if (visits.length) return { state: 'ok', detail: `${visits[visits.length - 1].device} reached it and was sent to the sign-in page.` };
  return { state: 'waiting', detail: 'Waiting for another device to open the address.' };
}
