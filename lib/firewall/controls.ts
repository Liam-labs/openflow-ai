/** The lockdown measures on the DevFlow server, each with its current state and how to see it for yourself. Built from the same captured facts as the ports. */
import type { UfwStatus } from './parse-host';
import type { HostModel } from './exposure';
import type { FirewallControl, FirewallPort } from './types';

export interface ServerControlFacts {
  ufw: UfwStatus;
  model: HostModel;
  ports: FirewallPort[];
  /** Output of `sshd -T`, or '' when it could not be read. */
  sshd: string;
  /** Output of `fail2ban-client status sshd`, or '' when it could not be read. */
  fail2ban: string;
  /** True when /var/run/reboot-required exists, null when it could not be checked. */
  rebootRequired: boolean | null;
}

function sshdSetting(text: string, key: string): string | undefined {
  const line = text.split('\n').find(l => l.toLowerCase().startsWith(`${key} `));
  return line ? line.slice(key.length).trim() : undefined;
}

function number(text: string, label: string): number | null {
  const m = new RegExp(`${label}:\\s*(\\d+)`).exec(text);
  return m ? Number(m[1]) : null;
}

export function serverControls(f: ServerControlFacts): FirewallControl[] {
  const out: FirewallControl[] = [];

  const allowRules = f.ufw.rules.filter(r => r.action === 'allow' && !r.v6).length;
  const denyIn = f.ufw.defaultIncoming === 'deny' || f.ufw.defaultIncoming === 'reject';
  out.push({
    id: 'firewall', title: 'Firewall (ufw)',
    state: f.ufw.enabled && denyIn ? 'ok' : f.ufw.enabled ? 'warn' : 'off',
    summary: f.ufw.enabled
      ? `On. Incoming: ${f.ufw.defaultIncoming}, outgoing: ${f.ufw.defaultOutgoing}, routed: ${f.ufw.defaultRouted}. ${allowRules} allow rule${allowRules === 1 ? '' : 's'}.`
      : 'Off: nothing is filtering incoming connections.',
    how: 'Anything no rule allows is dropped. The allow rules name the desktop by address, so another device cannot use them.',
    check: 'sudo ufw status verbose',
  });

  const divertsTailnet = (f.model.v4.chains.INPUT ?? []).some(r => r.target === 'ts-input');
  out.push({
    id: 'tailscale-mode', title: 'Tailscale and the firewall',
    state: divertsTailnet ? 'warn' : 'ok',
    summary: divertsTailnet
      ? 'Tailscale accepts every device on your tailnet before ufw is asked, so the ufw rules do not limit them.'
      : 'Tailscale traffic goes through ufw like any other network, so only the desktop gets in.',
    how: "tailscaled's firewall mode is nodivert: it no longer inserts its own accept-everything rule ahead of ufw.",
    check: 'tailscale debug prefs | grep NetfilterMode   (1 is nodivert), and sudo iptables -S INPUT must not start with -j ts-input',
  });

  const published = f.ports.filter(p => p.process === 'docker-proxy' || p.process === 'docker');
  const exposed = published.filter(p => p.exposure === 'open' || p.exposure === 'unknown');
  out.push({
    id: 'docker', title: 'Docker published ports',
    state: exposed.length ? 'warn' : 'ok',
    summary: published.length === 0
      ? 'No Docker ports are published.'
      : exposed.length
        ? `${exposed.length} published port${exposed.length === 1 ? ' is' : 's are'} reachable by more than the desktop: ${exposed.map(p => p.port).join(', ')}.`
        : `${published.length} published port${published.length === 1 ? '' : 's'} (${Array.from(new Set(published.map(p => p.port))).join(', ')}); only the desktop can reach ${published.length === 1 ? 'it' : 'them'}.`,
    how: 'Docker skips ufw, so docker-user-lan-block.service fills the DOCKER-USER chain: Wi-Fi traffic is dropped and tailnet traffic is admitted only from the desktop.',
    check: 'sudo iptables -S DOCKER-USER',
  });

  if (f.sshd) {
    const password = sshdSetting(f.sshd, 'passwordauthentication');
    const root = sshdSetting(f.sshd, 'permitrootlogin');
    const users = sshdSetting(f.sshd, 'allowusers');
    const tries = sshdSetting(f.sshd, 'maxauthtries');
    const keysOnly = password === 'no' && sshdSetting(f.sshd, 'kbdinteractiveauthentication') !== 'yes';
    const rootOff = root === 'no' || root === 'prohibit-password' || root === 'without-password';
    const bits = [
      keysOnly ? 'key login only' : 'passwords are accepted',
      rootOff ? 'root cannot sign in' : 'root may sign in',
      users ? `only ${users} may sign in` : 'any account may sign in',
      tries ? `${tries} tries per connection` : '',
    ].filter(Boolean);
    out.push({
      id: 'ssh', title: 'SSH server',
      state: keysOnly && rootOff ? 'ok' : 'warn',
      summary: `${bits[0][0].toUpperCase()}${bits[0].slice(1)}, ${bits.slice(1).join(', ')}.`,
      how: 'Set in /etc/ssh/sshd_config.d/00-devflow-hardening.conf and 10-devflow-access.conf; the firewall also limits who can even reach port 22.',
      check: 'sudo sshd -T | egrep "^(permitrootlogin|passwordauthentication|allowusers|maxauthtries) "',
    });
  } else {
    out.push({ id: 'ssh', title: 'SSH server', state: 'unknown', summary: 'The SSH settings could not be read.', how: 'Read with sshd -T.', check: 'sudo sshd -T' });
  }

  if (f.fail2ban) {
    const now = number(f.fail2ban, 'Currently banned');
    const total = number(f.fail2ban, 'Total banned');
    out.push({
      id: 'fail2ban', title: 'Brute-force protection',
      state: 'ok',
      summary: `Watching SSH logins: ${now ?? 0} banned now, ${total ?? 0} banned since it started.`,
      how: 'fail2ban bans an address for an hour after 3 failed logins in 10 minutes; the desktop is never banned.',
      check: 'sudo fail2ban-client status sshd',
    });
  } else {
    out.push({ id: 'fail2ban', title: 'Brute-force protection', state: 'unknown', summary: 'fail2ban did not report.', how: 'The sshd jail bans addresses that keep failing to sign in.', check: 'sudo fail2ban-client status sshd' });
  }

  out.push({
    id: 'reboot', title: 'Pending reboot',
    state: f.rebootRequired === null ? 'unknown' : f.rebootRequired ? 'warn' : 'ok',
    summary: f.rebootRequired === null ? 'Could not check.' : f.rebootRequired ? 'Installed updates are waiting for a reboot to take effect.' : 'No reboot is waiting.',
    how: 'Ubuntu creates /var/run/reboot-required when an update needs a restart; unattended upgrades install security updates.',
    check: 'ls /var/run/reboot-required',
  });

  return out;
}
