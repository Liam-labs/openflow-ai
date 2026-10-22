/**
 * Reads the firewall facts from the machine DevFlow runs on (the Remote server). Everything privileged goes through `sudo -n` with a fixed
 * command line, and /etc/sudoers.d/devflow-firewall-read allows exactly these command lines and nothing else (platform/security-lockdown.md).
 * The commands are read-only; none takes input from a request.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { RawServerFacts } from './server-model';

export interface CommandResult { ok: boolean; out: string; err: string }
export type Runner = (command: string, args: string[]) => Promise<CommandResult>;

/** The only commands run with sudo. Keep in step with /etc/sudoers.d/devflow-firewall-read (scripts/firewall/devflow-firewall-read.sudoers). */
export const SUDO_COMMANDS = {
  ufw: ['/usr/sbin/ufw', 'status', 'verbose'],
  iptablesV4: ['/usr/sbin/iptables', '-S'],
  iptablesV6: ['/usr/sbin/ip6tables', '-S'],
  natDocker: ['/usr/sbin/iptables', '-t', 'nat', '-S', 'DOCKER'],
  ss: ['/usr/bin/ss', '-H', '-ltnup'],
  sshd: ['/usr/sbin/sshd', '-T'],
  fail2ban: ['/usr/bin/fail2ban-client', 'status', 'sshd'],
} as const;

export const defaultRunner: Runner = (command, args) => new Promise(resolve => {
  execFile(command, args, { timeout: 10000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
    resolve({ ok: !error, out: String(stdout ?? ''), err: String(stderr || error?.message || '').trim().slice(0, 300) });
  });
});

export interface ServerCollection {
  raw: RawServerFacts;
  sshd: string;
  fail2ban: string;
  rebootRequired: boolean | null;
  /** Facts the report cannot be built without that could not be read, with the reason. Empty when all is well. */
  missing: string[];
}

const asRoot = (run: Runner, argv: readonly string[]): Promise<CommandResult> => run('sudo', ['-n', ...argv]);

export async function collectServer(
  run: Runner = defaultRunner,
  rebootFlag: () => boolean | null = () => { try { return existsSync('/var/run/reboot-required'); } catch { return null; } },
): Promise<ServerCollection> {
  const [ufw, v4, v6, nat, ss, sshd, fail2ban, ip, tailscale] = await Promise.all([
    asRoot(run, SUDO_COMMANDS.ufw), asRoot(run, SUDO_COMMANDS.iptablesV4), asRoot(run, SUDO_COMMANDS.iptablesV6), asRoot(run, SUDO_COMMANDS.natDocker),
    asRoot(run, SUDO_COMMANDS.ss), asRoot(run, SUDO_COMMANDS.sshd), asRoot(run, SUDO_COMMANDS.fail2ban),
    run('/usr/sbin/ip', ['-j', 'addr']), run('/usr/bin/tailscale', ['status', '--json']),
  ]);
  const missing: string[] = [];
  const need = (what: string, r: CommandResult): void => { if (!r.ok || !r.out.trim()) missing.push(`${what}: ${r.err || 'no output'}`); };
  need('the firewall rules (ufw status)', ufw);
  need('the packet filter (iptables -S)', v4);
  need('the listening ports (ss)', ss);
  need('the network cards (ip addr)', ip);
  return {
    raw: {
      ufw: ufw.out, iptablesV4: v4.out, iptablesV6: v6.ok ? v6.out : '', natDocker: nat.ok ? nat.out : '', ss: ss.out, ipAddrJson: ip.out,
      tailscaleJson: tailscale.ok ? tailscale.out : '',
    },
    sshd: sshd.ok ? sshd.out : '',
    fail2ban: fail2ban.ok ? fail2ban.out : '',
    rebootRequired: rebootFlag(),
    missing,
  };
}
