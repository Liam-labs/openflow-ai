/**
 * Windows Firewall, applied to what is listening on the PC. The facts come from scripts/windows/firewall-facts.ps1 (run by the PC's helper).
 * This file reads them, imagines senders on each network the PC is on, and applies the rules the way Windows does: a matching block rule wins,
 * otherwise a matching allow rule admits the connection, otherwise the network profile's default for incoming connections applies.
 * Whatever it cannot match with certainty (a program whose path Windows hides) comes out as UNKNOWN, never as closed.
 */
import type { Hop, Result } from './evaluate';
import { REPLY_SOURCE_PORT, isLinkLocal, sameSubnetHost, summarizeTrials, type Classification, type NamedAddress, type Scenario, type Trial } from './exposure';
import { inCidr, isLoopback, isWildcard, parseAddress, sameAddress, type Family } from './net';

// ── The facts ───────────────────────────────────────────────────────────────

export interface WinRule {
  name: string; group: string; app: string; service: string; protocol: number; localPorts: string; remotePorts: string; localAddresses: string; remoteAddresses: string;
  action: number; profiles: number; interfaceTypes: string;
  /** Names of the network cards the rule is limited to; empty for all. */
  interfaces: string[];
  /** The package family of a rule with no program that belongs to one Store app ("MSTeams_8wekyb3d8bbwe"); empty for other rules. Such a rule admits only that app. */
  package: string;
  /** Non-zero when the rule only admits IPsec-authenticated connections. */
  secure: number;
}
export interface WinListener { proto: 'tcp' | 'udp'; address: string; port: number; pid: number }
export interface WinProcess { pid: number; name: string; path: string }
export interface WinService { pid: number; name: string; display: string; exe: string }
export interface WinAddress { alias: string; address: string; bits: number; family: 4 | 6 }
/** `blockAllInbound`: "Block all incoming connections, including those in the list of allowed apps" (Shields Up) is on for this profile. */
export interface WinProfile { type: number; enabled: boolean; defaultInbound: number; defaultOutbound: number; blockAllInbound?: boolean }

export interface WinFacts {
  profiles: WinProfile[];
  rules: WinRule[];
  listeners: WinListener[];
  processes: WinProcess[];
  services: WinService[];
  addresses: WinAddress[];
  categories: Array<{ alias: string; category: string }>;
  adapters: Array<{ alias: string; status: string }>;
  defaultRoutes: Array<{ alias: string; nextHop: string }>;
  portProxy: string[];
  tailnet: Array<{ hostName: string; ips: string[] }>;
  remoteDesktopDenied: boolean | null;
  defender: { realTime: boolean; antivirus: boolean; signatureAgeDays: number } | null;
  ssh: { running: boolean; startType: string; config: Record<string, string> } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// PowerShell writes a one-element list as the bare element when it was not wrapped; take either.
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const int = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback);

/** Reads what the PowerShell script printed. Returns null when it is not the expected shape, so a broken helper never produces a confident-looking report. */
export function parseWinFacts(input: unknown): WinFacts | null {
  if (!isObj(input) || !Array.isArray(input.rules) || !input.profiles) return null;
  const objects = (v: unknown): Array<Record<string, unknown>> => list(v).filter(isObj);
  const facts: WinFacts = {
    profiles: objects(input.profiles).map(p => ({ type: int(p.type), enabled: p.enabled === true, defaultInbound: int(p.defaultInbound), defaultOutbound: int(p.defaultOutbound, 1), ...(p.blockAllInbound === true ? { blockAllInbound: true } : {}) })),
    rules: objects(input.rules).map(r => ({
      name: text(r.name), group: text(r.group), app: text(r.app), service: text(r.service), protocol: int(r.protocol, 256), localPorts: text(r.localPorts), remotePorts: text(r.remotePorts),
      localAddresses: text(r.localAddresses), remoteAddresses: text(r.remoteAddresses), action: int(r.action, 1), profiles: int(r.profiles),
      interfaceTypes: text(r.interfaceTypes), interfaces: list(r.interfaces).map(text).filter(Boolean), package: text(r.package), secure: int(r.secure),
    })),
    listeners: objects(input.listeners).flatMap(l => (l.proto === 'tcp' || l.proto === 'udp') && int(l.port) > 0
      ? [{ proto: l.proto as 'tcp' | 'udp', address: text(l.address), port: int(l.port), pid: int(l.pid) }] : []),
    processes: objects(input.processes).map(p => ({ pid: int(p.pid), name: text(p.name), path: text(p.path) })),
    services: objects(input.services).map(s => ({ pid: int(s.pid), name: text(s.name), display: text(s.display), exe: text(s.exe) })),
    addresses: objects(input.addresses).flatMap(a => (parseAddress(text(a.address)) ? [{ alias: text(a.alias), address: text(a.address), bits: int(a.bits), family: (text(a.family) === 'IPv6' ? 6 : 4) as 4 | 6 }] : [])),
    categories: objects(input.categories).map(c => ({ alias: text(c.alias), category: text(c.category) })),
    adapters: objects(input.adapters).map(a => ({ alias: text(a.alias), status: text(a.status) })),
    defaultRoutes: objects(input.defaultRoutes).map(r => ({ alias: text(r.alias), nextHop: text(r.nextHop) })),
    portProxy: list(input.portProxy).map(text).filter(Boolean),
    tailnet: objects(input.tailnet).map(t => ({ hostName: text(t.hostName), ips: list(t.ips).map(text).filter(ip => !!parseAddress(ip)) })),
    remoteDesktopDenied: typeof input.remoteDesktopDenied === 'boolean' ? input.remoteDesktopDenied : null,
    defender: isObj(input.defender) ? { realTime: input.defender.realTime === true, antivirus: input.defender.antivirus === true, signatureAgeDays: int(input.defender.signatureAgeDays) } : null,
    ssh: isObj(input.ssh) ? { running: input.ssh.running === true, startType: text(input.ssh.startType), config: isObj(input.ssh.config) ? Object.fromEntries(Object.entries(input.ssh.config).map(([k, v]) => [k.toLowerCase(), text(v)])) : {} } : null,
  };
  return facts.profiles.length ? facts : null;
}

// ── Matching one rule condition at a time: y (yes), n (no), m (cannot tell) ──

type Tri = 'y' | 'n' | 'm';

interface Range { family: Family; lo: bigint; hi: bigint }

function maskBits(mask: bigint): number | null {
  let bits = 0;
  let seenZero = false;
  for (let i = 31; i >= 0; i--) {
    const set = ((mask >> BigInt(i)) & BigInt(1)) === BigInt(1);
    if (set && seenZero) return null;
    if (set) bits++; else seenZero = true;
  }
  return bits;
}

/** One entry of a rule's address list: "a-b", "a/24", "a/255.255.255.0" or a single address. */
function tokenRange(token: string): Range | null {
  const dash = token.indexOf('-');
  if (dash > 0) {
    const a = parseAddress(token.slice(0, dash));
    const b = parseAddress(token.slice(dash + 1));
    return a && b && a.family === b.family ? { family: a.family, lo: a.value, hi: b.value } : null;
  }
  const slash = token.indexOf('/');
  if (slash > 0) {
    const a = parseAddress(token.slice(0, slash));
    if (!a) return null;
    const rest = token.slice(slash + 1);
    const max = a.family === 4 ? 32 : 128;
    let bits: number | null = null;
    if (/^\d+$/.test(rest)) bits = Number(rest);
    else {
      const m = parseAddress(rest);
      if (m && m.family === 4 && a.family === 4) bits = maskBits(m.value);
    }
    if (bits === null || bits > max) return null;
    const host = BigInt(max - bits);
    const lo = (a.value >> host) << host;
    return { family: a.family, lo, hi: lo | ((BigInt(1) << host) - BigInt(1)) };
  }
  const a = parseAddress(token);
  return a ? { family: a.family, lo: a.value, hi: a.value } : null;
}

const isIntranet = (ip: string): boolean =>
  ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'].some(cidr => inCidr(ip, cidr));

export interface AddrCtx { subnet: { addr: string; bits: number } | null; gateway: string | null }

export function addressState(spec: string, ip: string, ctx: AddrCtx): Tri {
  const list = spec.trim();
  if (list === '' || list === '*') return 'y';
  const target = parseAddress(ip);
  if (!target) return 'm';
  let maybe = false;
  for (const raw of list.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    if (token === '*') return 'y';
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(token)) {   // a macro such as LocalSubnet; an IPv6 address has colons
      switch (token.toLowerCase()) {
        case 'localsubnet': if (ctx.subnet && inCidr(ip, `${ctx.subnet.addr}/${ctx.subnet.bits}`)) return 'y'; break;
        case 'intranet': if (isIntranet(ip)) return 'y'; break;
        case 'internet': if (!isIntranet(ip)) return 'y'; break;
        case 'defaultgateway': if (ctx.gateway && sameAddress(ip, ctx.gateway)) return 'y'; break;
        case 'dns': case 'dhcp': case 'wins': break;   // a service's own server; no imagined sender is one
        default: maybe = true;
      }
      continue;
    }
    const range = tokenRange(token);
    if (!range) { maybe = true; continue; }
    if (range.family === target.family && target.value >= range.lo && target.value <= range.hi) return 'y';
  }
  return maybe ? 'm' : 'n';
}

// Port names Windows uses in place of numbers. Teredo uses whatever port its client picked.
const NAMED_PORTS: Record<string, Array<[number, number]>> = {
  rpc: [[49152, 65535]], 'rpc-epmap': [[135, 135]], iphttpsin: [[443, 443]], iphttps: [[443, 443]],
  playtodiscovery: [[2177, 2177]], ply2disc: [[1900, 1900], [2177, 2177]], teredo: [[1024, 65535]],
};

export function portState(spec: string, port: number): Tri {
  const list = spec.trim();
  if (list === '' || list === '*') return 'y';
  let maybe = false;
  for (const raw of list.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    const numeric = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (numeric) {
      const lo = Number(numeric[1]);
      const hi = numeric[2] ? Number(numeric[2]) : lo;
      if (port >= lo && port <= hi) return 'y';
      continue;
    }
    const named = NAMED_PORTS[token.toLowerCase()];
    if (named) { if (named.some(([lo, hi]) => port >= lo && port <= hi)) return 'y'; continue; }
    maybe = true;
  }
  return maybe ? 'm' : 'n';
}

const ENV_VARS: Record<string, string> = {
  '%systemroot%': 'c:\\windows', '%windir%': 'c:\\windows', '%programfiles%': 'c:\\program files', '%programfiles(x86)%': 'c:\\program files (x86)',
  '%systemdrive%': 'c:', '%programdata%': 'c:\\programdata',
};
const normalPath = (p: string): string => p.replace(/\//g, '\\').replace(/%[^%]+%/g, m => ENV_VARS[m.toLowerCase()] ?? m).toLowerCase().replace(/\\+$/, '');

// ── Who is listening ────────────────────────────────────────────────────────

export interface ListenerCtx { proto: 'tcp' | 'udp'; port: number; pid: number; path: string; processName: string; services: string[] }

export function listenerCtx(facts: WinFacts, l: WinListener): ListenerCtx {
  const process = facts.processes.find(p => p.pid === l.pid);
  const services = facts.services.filter(s => s.pid === l.pid);
  // WMI hides the path of a few protected programs; a service's own program path fills most of the gaps.
  const path = process?.path || services.find(s => s.exe)?.exe || '';
  return { proto: l.proto, port: l.port, pid: l.pid, path, processName: process?.name ?? '', services: services.map(s => s.name) };
}

const baseName = (p: string): string => normalPath(p).split('\\').pop() ?? '';

/** A path written in a form that cannot be compared exactly: an environment variable we do not expand (%LOCALAPPDATA%), an 8.3 short name (PROGRA~1), a device path. */
const unresolvedPath = (p: string): boolean => /%|~\d|^\\device\\/i.test(normalPath(p));

function appState(ruleApp: string, l: ListenerCtx): Tri {
  const app = ruleApp.trim();
  if (!app) return 'y';
  if (l.pid === 4) return app.toLowerCase() === 'system' ? 'y' : 'n';
  if (l.path) {
    if (normalPath(app) === normalPath(l.path)) return 'y';
    // Different after expanding what we can. When either side is in a form we cannot expand, only a different file name proves another program;
    // calling it "no" would skip a block rule (a wrong "open") or an allow rule (a wrong "closed").
    if (unresolvedPath(app) || unresolvedPath(l.path)) return baseName(app) === baseName(l.path) ? 'm' : 'n';
    return 'n';
  }
  // Windows hides the path of programs running as another user or as SYSTEM. A different file name is still proof of a different program;
  // the same name is taken to be the program the rule was written for (this errs towards reporting a port as reachable).
  if (!l.processName) return 'm';
  return baseName(app) === l.processName.toLowerCase() ? 'y' : 'n';
}

function serviceState(ruleService: string, l: ListenerCtx): Tri {
  const wanted = ruleService.trim().toLowerCase();
  if (!wanted) return 'y';
  if (wanted === '*') return l.services.length ? 'y' : 'n';
  return l.services.some(s => s.toLowerCase() === wanted) ? 'y' : 'n';
}

// ── Imagined senders ────────────────────────────────────────────────────────

const PROFILE_BIT: Record<string, number> = { domainauthenticated: 1, private: 2, public: 4 };
const PROFILE_NAME: Record<number, string> = { 1: 'Domain', 2: 'Private', 4: 'Public' };

export interface WinScenario extends Scenario { bit: number; ctx: AddrCtx; cardType: CardType }

type CardType = 'Lan' | 'Wireless' | 'RemoteAccess';

interface WinIface {
  alias: string;
  cardType: CardType;
  kind: 'tailnet' | 'lan' | 'internal';
  bit: number;
  link: string;
  gateway: string | null;
  hasDefaultRoute: boolean;
  v4: Array<{ addr: string; bits: number }>;
  v6: Array<{ addr: string; bits: number }>;
}

/** A network card in words a person uses. */
export function windowsLinkWords(alias: string): string {
  if (/tailscale/i.test(alias)) return 'Tailscale';
  if (/^wi-?fi/i.test(alias)) return 'Wi-Fi';
  if (/^ethernet/i.test(alias)) return 'Ethernet';
  if (/surfshark/i.test(alias)) return 'Surfshark VPN';
  return alias;
}

const TAILNET_V4 = '100.64.0.0/10';
const TAILNET_V6 = 'fd7a:115c:a1e0::/48';

export function windowsInterfaces(facts: WinFacts): WinIface[] {
  const byAlias = new Map<string, WinAddress[]>();
  for (const a of facts.addresses) {
    if (isLoopback(a.address) || /loopback/i.test(a.alias)) continue;
    if (a.family === 4 && inCidr(a.address, '169.254.0.0/16')) continue;   // an unconnected card gives itself one of these
    byAlias.set(a.alias, [...(byAlias.get(a.alias) ?? []), a]);
  }
  const out: WinIface[] = [];
  byAlias.forEach((addrs, alias) => {
    // A card that is switched off or unplugged is on no network, whatever address it remembers.
    const adapter = facts.adapters.find(a => a.alias.toLowerCase() === alias.toLowerCase());
    if (adapter && adapter.status.toLowerCase() !== 'up') return;
    // A card with only a link-local address is not on any network yet.
    if (!addrs.some(a => !(a.family === 6 && isLinkLocal(a.address)))) return;
    const category = facts.categories.find(c => c.alias.toLowerCase() === alias.toLowerCase())?.category.toLowerCase() ?? '';
    const route = facts.defaultRoutes.find(r => r.alias.toLowerCase() === alias.toLowerCase());
    const tailnet = /tailscale/i.test(alias) || addrs.some(a => (a.family === 4 ? inCidr(a.address, TAILNET_V4) : inCidr(a.address, TAILNET_V6)));
    out.push({
      alias, kind: /^vEthernet/i.test(alias) ? 'internal' : tailnet ? 'tailnet' : 'lan',
      // Windows decides this from the adapter driver; the name is the best guide we have. VPN and tunnel adapters count as remote access.
      cardType: /^wi-?fi/i.test(alias) ? 'Wireless' : /^(ethernet|vethernet)/i.test(alias) ? 'Lan' : 'RemoteAccess',
      bit: PROFILE_BIT[category] ?? 4,   // a network Windows has not classified is treated as Public
      link: windowsLinkWords(alias), gateway: route?.nextHop && parseAddress(route.nextHop) ? route.nextHop : null, hasDefaultRoute: !!route,
      v4: addrs.filter(a => a.family === 4).map(a => ({ addr: a.address, bits: a.bits })),
      v6: addrs.filter(a => a.family === 6).map(a => ({ addr: a.address, bits: a.bits })),
    });
  });
  return out;
}

function internalLabel(alias: string): string {
  if (/wsl/i.test(alias)) return "This PC's Linux side (WSL)";
  if (/default switch/i.test(alias)) return 'Virtual machines on this PC';
  return 'Virtual adapters on this PC';
}

export function windowsScenarios(facts: WinFacts, named: NamedAddress[]): WinScenario[] {
  const out: WinScenario[] = [];
  const taken = named.map(n => n.address);
  for (const iface of windowsInterfaces(facts)) {
    for (const family of [4, 6] as const) {
      for (const own of family === 4 ? iface.v4 : iface.v6) {
        const linkLocal = family === 6 && isLinkLocal(own.addr);
        const ctx: AddrCtx = { subnet: { addr: own.addr, bits: own.bits }, gateway: iface.gateway };
        const base = { family, iface: iface.alias, dst: own.addr, bit: iface.bit, ctx, cardType: iface.cardType } as const;
        if (iface.kind === 'internal') {
          if (linkLocal) continue;
          const src = sameSubnetHost(own.addr, own.bits, taken);
          if (src) out.push({ ...base, src, kind: 'internal', scope: 'internal', label: internalLabel(iface.alias), where: "this PC's virtual side" });
          continue;
        }
        const tailnet = iface.kind === 'tailnet';
        if (tailnet && linkLocal) continue;
        const inside = (address: string): boolean => {
          if (parseAddress(address)?.family !== family) return false;
          return tailnet ? inCidr(address, family === 4 ? TAILNET_V4 : TAILNET_V6) : inCidr(address, `${own.addr}/${own.bits}`);
        };
        for (const n of linkLocal ? [] : named) {
          if (inside(n.address) && !sameAddress(n.address, own.addr)) {
            out.push({ ...base, src: n.address, kind: 'named', scope: tailnet ? 'tailnet' : 'lan', label: `${n.name} over ${iface.link}`, where: tailnet ? 'your tailnet' : `the ${iface.link} network` });
          }
        }
        const neighbour = tailnet ? (family === 4 ? '100.64.0.77' : 'fd7a:115c:a1e0:ab12::77') : sameSubnetHost(own.addr, own.bits, taken);
        if (neighbour && !taken.some(t => sameAddress(t, neighbour))) {
          out.push(tailnet
            ? { ...base, src: neighbour, kind: 'stranger', scope: 'tailnet', label: 'Any device on your tailnet', where: 'your tailnet' }
            : { ...base, src: neighbour, kind: 'stranger', scope: 'lan', label: `Any device on the ${iface.link} network`, where: `the ${iface.link} network` });
        }
        if (!tailnet && !linkLocal && iface.hasDefaultRoute) {
          out.push({ ...base, src: family === 4 ? '203.0.113.77' : '2001:db8:77::1', kind: 'stranger', scope: 'internet', label: 'Anyone on the internet', where: 'the internet' });
        }
      }
    }
  }
  return out;
}

// ── The verdict ─────────────────────────────────────────────────────────────

function protocolMatches(rule: number, proto: 'tcp' | 'udp'): boolean {
  return rule === 256 || (rule === 6 && proto === 'tcp') || (rule === 17 && proto === 'udp');
}

// Wi-Fi Direct rules (Windows ships them enabled, for the Wi-Fi Direct adapter only). A live test from WSL on 18 Oct 2026 showed they do not admit
// connections to System, Connected Devices or Spooler listeners over an ordinary network.
const isWifiDirect = (rule: WinRule): boolean => /wlansvc/i.test(rule.group) || /\bWFD\b|wi-?fi direct/i.test(rule.name);

function interfaceTypeState(ruleTypes: string, card: CardType): Tri {
  const wanted = ruleTypes.trim();
  if (wanted === '' || /^all$/i.test(wanted)) return 'y';
  if (wanted.toLowerCase().split(',').map(t => t.trim()).includes(card.toLowerCase())) return 'y';
  return card === 'RemoteAccess' ? 'm' : 'n';   // how Windows classifies a given VPN adapter is not visible from here
}

/** "C:\\Program Files\\WindowsApps\\MSTeams_26260.1717.5229.7049_x64__8wekyb3d8bbwe\\ms-teams.exe" belongs to the package family "MSTeams_8wekyb3d8bbwe". */
export function packageFamilyOf(path: string): string {
  const dir = /\\windowsapps\\([^\\]+)\\/i.exec(path)?.[1];
  if (!dir) return '';
  const parts = dir.split('_');
  return parts.length >= 2 ? `${parts[0]}_${parts[parts.length - 1]}` : '';
}

// A Store app's rule names its package instead of a program path; only that app's programs can match it.
function packageState(rule: WinRule, l: ListenerCtx): Tri {
  if (!rule.package) return 'y';
  // Store apps run from a folder anyone can read; a program whose location Windows hides (System, services) is not one.
  const family = packageFamilyOf(l.path);
  return family !== '' && family.toLowerCase() === rule.package.toLowerCase() ? 'y' : 'n';
}

function cardState(rule: WinRule, alias: string): Tri {
  if (rule.interfaces.length === 0) return 'y';
  return rule.interfaces.some(i => i.toLowerCase() === alias.toLowerCase()) ? 'y' : 'n';
}

function ruleState(rule: WinRule, l: ListenerCtx, s: WinScenario, sport: number): Tri {
  // A rule that needs IPsec authentication does not admit the plain connections imagined here, and a Wi-Fi Direct rule is for another adapter.
  if (rule.secure !== 0 || isWifiDirect(rule)) return 'n';
  const parts: Tri[] = [
    (rule.profiles & s.bit) !== 0 ? 'y' : 'n',
    protocolMatches(rule.protocol, l.proto) ? 'y' : 'n',
    portState(rule.localPorts, l.port),
    portState(rule.remotePorts, sport),
    addressState(rule.localAddresses, s.dst, s.ctx),
    addressState(rule.remoteAddresses, s.src, s.ctx),
    appState(rule.app, l),
    serviceState(rule.service, l),
    interfaceTypeState(rule.interfaceTypes, s.cardType),
    packageState(rule, l),
    cardState(rule, s.iface),
  ];
  if (parts.includes('n')) return 'n';
  return parts.includes('m') ? 'm' : 'y';
}

// The more a rule says about program, port and sender, the better it explains why a connection was let in.
const specificity = (r: WinRule): number => (r.app ? 4 : 0) + (r.service ? 2 : 0) + (r.localPorts && r.localPorts !== '*' ? 2 : 0) + (r.remoteAddresses && r.remoteAddresses !== '*' ? 1 : 0);

const hit = (action: 'ACCEPT' | 'DROP', rule: WinRule): Result => ({ verdict: action, decidedBy: { chain: 'windows-rule', rule: rule.name, action } });

export function windowsVerdict(facts: WinFacts, l: ListenerCtx, s: WinScenario, sport: number): Result {
  const profile = facts.profiles.find(p => p.type === s.bit);
  if (profile && !profile.enabled) return { verdict: 'ACCEPT', decidedBy: { chain: 'windows-off', rule: PROFILE_NAME[s.bit] ?? 'this', action: 'POLICY' } };
  // "Block all incoming connections, including those in the list of allowed apps": no allow rule is honoured.
  if (profile?.blockAllInbound) return { verdict: 'DROP', decidedBy: { chain: 'windows-blockall', rule: PROFILE_NAME[s.bit] ?? 'this', action: 'POLICY' } };
  const blocks: WinRule[] = [];
  const allows: WinRule[] = [];
  let maybeBlock = false;
  let maybeAllow = false;
  for (const rule of facts.rules) {
    const state = ruleState(rule, l, s, sport);
    if (state === 'n') continue;
    if (rule.action === 0) { if (state === 'y') blocks.push(rule); else maybeBlock = true; } else if (state === 'y') allows.push(rule); else maybeAllow = true;
  }
  if (blocks.length) return hit('DROP', blocks[0]);
  const cannotTell = (): Result => ({
    verdict: 'UNKNOWN',
    decidedBy: { chain: 'windows-unknown', rule: `Windows has rules that may apply, but they could not be matched to ${l.processName || 'this program'}${l.path ? '' : ' (Windows hides where it runs from)'}`, action: 'UNKNOWN' },
  });
  if (maybeBlock) return cannotTell();
  if (allows.length) return hit('ACCEPT', allows.reduce((best, r) => (specificity(r) > specificity(best) ? r : best)));
  if (maybeAllow) return cannotTell();
  const allowByDefault = profile?.defaultInbound === 1;
  return { verdict: allowByDefault ? 'ACCEPT' : 'DROP', decidedBy: { chain: 'windows-default', rule: allowByDefault ? 'allow' : 'block', action: 'POLICY' } };
}

const ruleLabel = (name: string): string => (name.startsWith('@') ? 'a built-in Windows rule' : `"${name}"`);

export function describeWindowsHop(hop: Hop): string {
  switch (hop.chain) {
    case 'windows-rule': return hop.action === 'DROP' ? `the block rule ${ruleLabel(hop.rule)}` : `the Windows rule ${ruleLabel(hop.rule)}`;
    case 'windows-off': return `Windows Firewall being switched off for ${hop.rule} networks`;
    case 'windows-blockall': return `Windows being set to block all incoming connections on ${hop.rule} networks`;
    case 'windows-default': return hop.rule === 'allow' ? 'the default allow' : 'the default block';
    default: return 'a Windows rule';
  }
}

/** Who can reach one listening socket. `scenarios` come from windowsScenarios and are built once per report. */
export function classifyWindows(facts: WinFacts, l: WinListener, scenarios: WinScenario[]): Classification {
  const no = { named: [], strangers: [] };
  if (isLoopback(l.address)) {
    return { exposure: 'local-only', allowedFrom: ['This PC only'], how: 'It listens on the loopback address, so only this PC can connect.', reach: no };
  }
  const wildcard = isWildcard(l.address);
  const family = parseAddress(l.address)?.family;
  // Windows lists a socket that takes IPv4 and IPv6 connections together (dual-mode, the default for Java and .NET servers) as `::` alone and does
  // not say which kind it is, so a `::` listener is tried over IPv4 as well. Calling it IPv6-only when it is not reported open ports as "this PC only".
  const chosen = scenarios.filter(s => (wildcard ? family === 6 || s.family === family : sameAddress(s.dst, l.address)));
  if (chosen.length === 0) {
    return { exposure: 'local-only', allowedFrom: ['This PC only'], how: 'It listens on an address that no connected network can reach, so only this PC can connect.', reach: no };
  }
  const ctx = listenerCtx(facts, l);
  const run = (sport: number): Trial[] => chosen.map(scenario => ({ scenario, result: windowsVerdict(facts, ctx, scenario, sport) }));
  const replyPort = REPLY_SOURCE_PORT[`${l.proto}/${l.port}`];
  return summarizeTrials(run(40000), describeWindowsHop, replyPort ? { port: replyPort, run: () => run(replyPort) } : undefined);
}
