/**
 * Start-up check: if the dashboard can be reached from other computers, a sign-in password must exist.
 *
 * "Reachable from other computers" means any of: the server listens beyond this machine (DEVFLOW_BIND_HOST), remote access was
 * switched on in the setup wizard (.AppData/remote-access.json says enabled), or a tunnel secret is set (WEBGATE_TUNNEL_SECRET:
 * requests that carry it skip the sign-in, so whatever stands in front of the tunnel is the only lock).
 *
 * This runs at EVERY start, not just in the wizard, so a later edit of a settings file cannot quietly reopen the dashboard.
 * Escape hatch for a server that has its own front door (a tunnel that already demands a login, a VPN): DEVFLOW_ALLOW_OPEN_REMOTE=1.
 */

import { promises as fs } from 'fs';
import { DataPaths } from './data-paths';
import { listensOnLoopbackOnly } from './local-trust';

export const EXIT_CODE_EXPOSED_WITHOUT_LOGIN = 78;

type Env = Record<string, string | undefined>;

export interface ExposureFacts {
  /** Reasons the dashboard can be reached from other computers (empty = this machine only). */
  exposures: string[];
  passwordSet: boolean;
  allowOpen: boolean;
  /** DEVFLOW_SERVER_MODE=1 and DEVFLOW_REQUIRE_TOKEN=1 are both set. Absent means false (a desktop install). */
  serverMode?: boolean;
  requireToken?: boolean;
}

export interface ExposureVerdict {
  ok: boolean;
  exposures: string[];
  message?: string;
}

export function exposureReasons(env: Env, remoteAccessEnabled: boolean): string[] {
  const reasons: string[] = [];
  if (!listensOnLoopbackOnly(env)) reasons.push(`it listens beyond this machine (DEVFLOW_BIND_HOST=${(env.DEVFLOW_BIND_HOST || '').trim()})`);
  if (remoteAccessEnabled) reasons.push('remote access is switched on');
  if ((env.WEBGATE_TUNNEL_SECRET || '').trim()) reasons.push('a tunnel is set up (WEBGATE_TUNNEL_SECRET)');
  return reasons;
}

export function exposureVerdict(facts: ExposureFacts): ExposureVerdict {
  // A server install sits behind a proxy on this machine. A proxy that adds no forwarding header looks like the owner, so without the
  // token requirement an internet caller would be trusted as "this machine". This is checked at every start, like the password check.
  if (facts.serverMode && !facts.requireToken) {
    return {
      ok: false,
      exposures: facts.exposures,
      message:
        'The dashboard will not start: this is a server install (DEVFLOW_SERVER_MODE=1) but DEVFLOW_REQUIRE_TOKEN=1 is not set, so a proxy in front of it could make an internet caller look like this machine.\n' +
        '  Fix: run  ./scripts/setup --server  (it sets both), then start again.',
    };
  }
  if (!facts.exposures.length || facts.passwordSet || facts.allowOpen) return { ok: true, exposures: facts.exposures };
  return {
    ok: false,
    exposures: facts.exposures,
    message:
      `The dashboard will not start: other computers can reach it (${facts.exposures.join('; ')}) and no sign-in password is set.\n` +
      '  Fix: run  scripts/devflow-password set  on this machine, then start again.\n' +
      '  If something in front of it already checks who is calling (a tunnel with its own login, a VPN), set DEVFLOW_ALLOW_OPEN_REMOTE=1 instead.',
  };
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Is a password stored? An unreadable file counts as NOT set here (refusing is the safe answer at start-up). */
export async function passwordStored(file = DataPaths.dashboardAuth): Promise<boolean> {
  const data = await readJson(file);
  const pw = data?.password as { hash?: unknown } | undefined;
  return typeof pw?.hash === 'string' && pw.hash.length > 0;
}

/** Remote access is on when either wizard says so: Tailscale (remote-access.json) or Cloudflare (cloudflare-access.json). */
export async function remoteAccessEnabled(file = DataPaths.remoteAccess, cloudflareFile = DataPaths.cloudflareAccess): Promise<boolean> {
  return (await readJson(file))?.enabled === true || (await readJson(cloudflareFile))?.enabled === true;
}

export async function checkExposureAtStartup(env: Env = process.env): Promise<ExposureVerdict> {
  const exposures = exposureReasons(env, await remoteAccessEnabled());
  return exposureVerdict({ exposures, passwordSet: await passwordStored(), allowOpen: env.DEVFLOW_ALLOW_OPEN_REMOTE === '1', serverMode: env.DEVFLOW_SERVER_MODE === '1', requireToken: env.DEVFLOW_REQUIRE_TOKEN === '1' });
}
