/**
 * The pieces of the WebGate wizard that touch the disk: the scoped API token (a private file read only by the wizard code, not the
 * secret store, whose values every child process inherits), and the state the page shows.
 */
import { promises as fs } from 'fs';
import { DataPaths } from '../data-paths';
import { hasPassword } from '../dashboard-auth';
import { execFile } from 'child_process';
import { CloudflareApi, cloudflaredTooOld, MIN_CLOUDFLARED, PERMISSION_LIST } from './cloudflare-api';
import { tokenLink, tokenName } from './cloudflare-token-link';
import { checkToken, realIo, type CfRecord, type Io, type TokenCheck } from './cloudflare';
import { realRunner, type ConnectorRunner } from './cloudflared-runner';

export async function readApiToken(file = DataPaths.cloudflareApiToken): Promise<string | null> {
  try {
    const t = (await fs.readFile(file, 'utf8')).trim();
    return t || null;
  } catch {
    return null;
  }
}

export async function writeApiToken(token: string, file = DataPaths.cloudflareApiToken): Promise<void> {
  await fs.writeFile(file, token.trim(), { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/** Check a pasted token; keep it (and remember the domain list) only when it passes. The token never leaves this function except to Cloudflare. */
export async function saveToken(token: string, io: Io, api: CloudflareApi = new CloudflareApi(token.trim())): Promise<TokenCheck> {
  const result = await checkToken(api, token.trim());
  if (!result.ok) return result;
  await writeApiToken(token);
  const rec = await io.readRecord();
  await io.writeRecord({ ...rec, known: { accountId: result.accountId!, zones: result.zones } });
  return result;
}

export async function forgetToken(io: Io, file = DataPaths.cloudflareApiToken): Promise<{ ok: true } | { ok: false; error: string }> {
  const rec = await io.readRecord();
  if (rec.stage !== 'none') return { ok: false, error: 'Switch the address off first: the token is needed to remove what it made.' };
  await fs.rm(file, { force: true });
  await io.writeRecord({ enabled: false, stage: 'none' });
  return { ok: true };
}

/** The email address in git's global settings, or ''. Never throws and never waits more than 2 seconds. */
export function gitEmail(): Promise<string> {
  return new Promise(resolve => {
    try {
      execFile('git', ['config', '--global', 'user.email'], { timeout: 2000 }, (err, stdout) => {
        const v = err ? '' : String(stdout).trim();
        resolve(/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(v) ? v : '');
      });
    } catch { resolve(''); }
  });
}

export interface WizardState {
  passwordSet: boolean;
  tokenSaved: boolean;
  record: CfRecord;
  url: string | null;
  /** tooOld: below MIN_CLOUDFLARED (minimum names it for the screen); Switch on refuses it. */
  connector: { installed: boolean; version: string | null; running: boolean; tooOld: boolean; minimum: string };
  permissions: typeof PERMISSION_LIST;
  /** One click opens Cloudflare's token form with the four permissions and the name filled in (lib/wizards/cloudflare-token-link.ts). */
  tokenLink: string;
  tokenName: string;
  /** The address offered as the one allowed to sign in: DEVFLOW_DEFAULT_EMAIL, else the email in this computer's git settings. Empty when there is none. */
  defaultEmail: string;
}

export async function wizardState(io: Io = realIo(realRunner), runner: ConnectorRunner = realRunner): Promise<WizardState> {
  const [passwordSet, token, record, installed, running] = await Promise.all([hasPassword(), readApiToken(), io.readRecord(), runner.installed(), runner.running()]);
  return {
    passwordSet, tokenSaved: !!token, record,
    url: record.stage === 'live' && record.hostname ? `https://${record.hostname}` : null,
    connector: { installed: !!installed.path, version: installed.version, running, tooOld: !!installed.path && cloudflaredTooOld(installed.version), minimum: MIN_CLOUDFLARED },
    permissions: PERMISSION_LIST,
    tokenLink: tokenLink(tokenName(io.env.DEVFLOW_INSTANCE_LABEL)),
    tokenName: tokenName(io.env.DEVFLOW_INSTANCE_LABEL),
    defaultEmail: (io.env.DEVFLOW_DEFAULT_EMAIL ?? '').trim() || await gitEmail(),
  };
}

/** Start the connector again after the app restarts, while the wizard's address is on. */
export async function ensureConnectorAtStartup(io: Io = realIo(realRunner)): Promise<void> {
  const rec = await io.readRecord();
  if (rec.enabled && rec.stage === 'live') await io.runner.start();
}
