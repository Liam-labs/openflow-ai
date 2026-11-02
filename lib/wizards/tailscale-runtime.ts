import { spawn } from 'node:child_process';
import { emitWizardChanged } from './events';

// The container entrypoint owns this daemon and private directory. Never use the host socket.
export const ISOLATED_TAILSCALE_SOCKET = '/data/home/.openflow-tailscale/tailscaled.sock';
export function isolatedTailscaleNode(): boolean {
  return process.env.OPENFLOW_TAILSCALE_SOCKET === ISOLATED_TAILSCALE_SOCKET;
}
export function tailscaleSocketArgs(): string[] {
  return isolatedTailscaleNode() ? [`--socket=${ISOLATED_TAILSCALE_SOCKET}`] : [];
}
export type LoginResult = { ok: true; loginUrl?: string } | { ok: false; error: string };

/** Accept only the provider's approval URL, never an arbitrary link from process output. */
export function loginUrlFromOutput(output: string): string | undefined {
  const match = output.match(/https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+/);
  return match?.[0];
}
const runtime = globalThis as typeof globalThis & { __openflowTailscaleLogin?: Promise<LoginResult> };

/** One login process per node. It emits on completion, not on a status timer. */
export function loginIsolatedTailscale(): Promise<LoginResult> {
  if (!isolatedTailscaleNode()) return Promise.resolve({ ok: false, error: 'Use the Tailscale application on the host to sign in.' });
  if (runtime.__openflowTailscaleLogin) return runtime.__openflowTailscaleLogin;
  const promise = new Promise<LoginResult>((resolve) => {
    const child = spawn('tailscale', [...tailscaleSocketArgs(), 'up', '--json', '--accept-dns=false', '--accept-routes=false', '--hostname=openflow', '--timeout=10m'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const settle = (result: LoginResult) => { if (!settled) { settled = true; resolve(result); } };
    const firstResponse = setTimeout(() => {
      settle({ ok: false, error: 'Tailscale did not return a sign-in link. Check outbound access and try again.' });
      child.kill('SIGTERM');
    }, 15000);
    const receive = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16384);
      const loginUrl = loginUrlFromOutput(output);
      if (loginUrl) { clearTimeout(firstResponse); settle({ ok: true, loginUrl }); }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.on('error', () => {
      clearTimeout(firstResponse);
      settle({ ok: false, error: 'The isolated Tailscale client could not start.' });
    });
    child.on('close', (code) => {
      clearTimeout(firstResponse);
      runtime.__openflowTailscaleLogin = undefined;
      settle(code === 0 ? { ok: true } : { ok: false, error: 'Tailscale sign-in did not finish. Retry the connection.' });
      emitWizardChanged('tailscale');
    });
  });
  runtime.__openflowTailscaleLogin = promise;
  return promise;
}
