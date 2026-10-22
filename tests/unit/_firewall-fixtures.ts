// Shared by the firewall tests: the captured laptop state (before and after the 18 Oct 2026 fix) and the checked-in port registry.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { WslFacts } from '@/lib/firewall/desktop-model';
import { parseRegistry, type Registry } from '@/lib/firewall/registry';
import type { RawServerFacts } from '@/lib/firewall/server-model';
import { parseWinFacts, type WinFacts } from '@/lib/firewall/windows';

export const FIXTURES = path.join(__dirname, '..', 'fixtures', 'firewall');
export const REGISTRY_FILE = path.join(__dirname, '..', '..', 'data', 'firewall', 'registry.json');

export const read = (set: string, file: string): string => readFileSync(path.join(FIXTURES, set, file), 'utf8');

export function factsFor(set: 'server-before' | 'server-after'): RawServerFacts {
  return {
    ufw: read(set, 'ufw-status-verbose.txt'), iptablesV4: read(set, 'iptables-S.txt'), iptablesV6: read(set, 'ip6tables-S.txt'),
    natDocker: read(set, 'iptables-nat-DOCKER.txt'), ss: read(set, 'ss.txt'), ipAddrJson: read(set, 'ip-addr.json'),
    tailscaleJson: read(set, 'tailscale-status.json'),
  };
}

export const checkedInRegistry = (): Registry => parseRegistry(JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')));

// The desktop, as the PC's helper reported it on 18 Oct 2026 (trimmed, and with the account name and home IPv6 prefix replaced).
const DESKTOP_DIR = path.join(FIXTURES, 'desktop');
export const desktopJson = (): unknown => JSON.parse(readFileSync(path.join(DESKTOP_DIR, 'windows-facts.json'), 'utf8'));
export const desktopFacts = (): WinFacts => parseWinFacts(desktopJson())!;
export const wslFacts = (): WslFacts => ({
  ss: readFileSync(path.join(DESKTOP_DIR, 'wsl-ss.txt'), 'utf8'),
  ipAddr: readFileSync(path.join(DESKTOP_DIR, 'wsl-ip-addr.json'), 'utf8'),
});
