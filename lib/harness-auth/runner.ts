/**
 * Runs scripts/harness_signin.py on the machine that owns a login: locally for the server, through agent-hostd for the desktop.
 * The helper prints JSON; an expected refusal is {error, code}. Nothing here logs arguments: the pasted sign-in code travels on
 * stdin locally, and through hostd's in-memory queue (never written to disk) for the desktop.
 */
import { spawn } from 'child_process';
import path from 'path';
import { defaultHost, hostCall } from '@/lib/host-executor';
import type { HostId } from './model';

export type SignInAction = 'probe' | 'start' | 'status' | 'code' | 'cancel' | 'list';
export interface SignInArgs { harness?: string; id?: string; code?: string }
export interface Refusal { error: string; code: string }

export class HostOfflineError extends Error {
  readonly code = 'HOST_OFFLINE' as const;
}

export const isRefusal = (value: unknown): value is Refusal =>
  !!value && typeof value === 'object' && typeof (value as Refusal).error === 'string' && typeof (value as Refusal).code === 'string';

const ID_RE = /^[0-9a-f]{8}$/;
const HARNESS_RE = /^(claude|codex|antigravity)$/;
const script = () => process.env.DEVFLOW_SIGNIN_SCRIPT || path.join(process.cwd(), 'scripts', 'harness_signin.py');

/** True when the agents' machine is a different one from this server (DEVFLOW_AGENT_HOST is set). */
export const desktopIsRemote = (): boolean => !!defaultHost();

function runLocal(action: SignInAction, args: SignInArgs, timeoutMs: number): Promise<unknown> {
  const argv = [script(), action];
  if (args.harness) argv.push('--harness', args.harness);
  if (args.id) argv.push('--id', args.id);
  return new Promise((resolve, reject) => {
    const child = spawn('python3', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('The sign-in helper did not answer in time')); }, timeoutMs);
    child.stdout.on('data', chunk => { if (out.length < 65_536) out += chunk; });
    child.stderr.on('data', chunk => { if (err.length < 2_048) err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`The sign-in helper gave no answer${err ? `: ${err.trim().slice(0, 120)}` : ''}`)); }
    });
    child.stdin.end(action === 'code' ? (args.code ?? '') : '');
  });
}

export async function runSignInTool(host: HostId, action: SignInAction, args: SignInArgs, timeoutMs = 45_000): Promise<unknown> {
  if (args.harness !== undefined && !HARNESS_RE.test(args.harness)) throw new Error('harness must be claude, codex or antigravity');
  if (args.id !== undefined && !ID_RE.test(args.id)) return { error: 'That sign-in is gone; start again', code: 'NOT_FOUND' } satisfies Refusal;
  const remote = host === 'desktop' ? defaultHost() : null;
  if (remote) {
    try {
      return await hostCall<unknown>(remote, 'harness-signin', { action, ...args }, timeoutMs);
    } catch (error) {
      if ((error as { code?: string })?.code === 'EHOSTTIMEOUT') throw new HostOfflineError('The desktop is not answering');
      throw error;
    }
  }
  return runLocal(action, args, timeoutMs);
}
