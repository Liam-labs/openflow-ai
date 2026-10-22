/**
 * The desktop PC's section of the report. The PC has two network stacks: Windows itself (Windows Firewall decides who can connect) and the Linux
 * inside it (WSL, which sits behind Windows on a private NAT network and is reached from outside only where Windows forwards a port to loopback).
 */
import { inCidr, isLoopback, isWildcard, parseAddress, sameAddress } from './net';
import { collapseCovered, worse, type NamedAddress, type Reach } from './exposure';
import { parseSs, type Listener } from './parse-host';
import { lookup, type Registry } from './registry';
import { INTENT_WORDS, cleanProcess, withinIntent } from './server-model';
import { classifyWindows, listenerCtx, windowsInterfaces, windowsLinkWords, windowsScenarios, type ListenerCtx, type WinFacts, type WinListener, type WinRule } from './windows';
import type { Exposure, FirewallControl, FirewallPort, FirewallRuleRow } from './types';
import { PRODUCT_NAME } from '@/lib/brand';

export interface WslFacts { ss: string; ipAddr: string }

const SEVERITY: Record<Exposure, number> = { open: 0, unknown: 1, allowed: 2, blocked: 3, 'local-only': 4 };

const WINDOWS_DIR = /^c:\\windows\\/i;
const isWindowsOwn = (ctx: ListenerCtx): boolean => ctx.pid === 4 || WINDOWS_DIR.test(ctx.path);

const baseName = (p: string): string => p.replace(/\//g, '\\').split('\\').pop() ?? p;
const withoutExe = (name: string): string => name.replace(/\.exe$/i, '');

function programLabel(facts: WinFacts, ctx: ListenerCtx): string {
  // A shared host process (svchost) runs several services; the first is the one a person most likely means.
  const service = facts.services.find(s => s.pid === ctx.pid);
  if (service) return service.display || service.name;
  return withoutExe(ctx.processName) || 'unknown';
}

function bindClass(address: string): 'any' | 'loopback' | 'specific' {
  return isWildcard(address) ? 'any' : isLoopback(address) ? 'loopback' : 'specific';
}

function windowsBindWords(group: WinListener[], facts: WinFacts): string {
  const parts = Array.from(new Set(group.map(l => {
    if (isWildcard(l.address)) return parseAddress(l.address)?.family === 6 ? 'all IPv6 addresses' : 'all IPv4 addresses';
    const clean = l.address.split('%')[0];
    const owner = isLoopback(clean) ? undefined : facts.addresses.find(a => sameAddress(a.address, clean));
    return owner ? `${clean} (${windowsLinkWords(owner.alias)})` : clean;
  })));
  if (parts.length === 2 && parts.includes('all IPv4 addresses') && parts.includes('all IPv6 addresses')) return 'all addresses';
  return parts.join(', ');
}

/** Listening sockets that cannot matter and would drown the ones that do: short-lived UDP sockets on random high ports that nothing can reach. */
const isEphemeralUdp = (proto: string, port: number): boolean => proto === 'udp' && port >= 49152;

export interface DesktopPorts { ports: FirewallPort[]; omitted: number }

export function buildWindowsPorts(facts: WinFacts, registry: Registry, named: NamedAddress[]): DesktopPorts {
  const scenarios = windowsScenarios(facts, named);
  // One row per program and port. Two processes of one program (browser helpers) sharing a port are still one program.
  const programOf = new Map(facts.processes.map(p => [p.pid, p.name.toLowerCase()]));
  const groups = new Map<string, WinListener[]>();
  for (const l of facts.listeners) {
    const key = [l.proto, l.port, programOf.get(l.pid) ?? `pid ${l.pid}`].join('|');
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const ports: FirewallPort[] = [];
  let omitted = 0;
  groups.forEach(group => {
    const first = group[0];
    const ctx = listenerCtx(facts, first);
    const entry = lookup(registry, 'desktop', first.proto, first.port, 'windows', ctx.processName);
    const results = group.map(l => classifyWindows(facts, l, scenarios));
    let exposure: Exposure = 'local-only';
    for (const r of results) exposure = worse(exposure, r.exposure);
    const labels = collapseCovered(Array.from(new Set(results.flatMap(r => r.allowedFrom))));
    const outside = labels.filter(a => a !== 'This PC only');
    const allowedFrom = exposure === 'local-only' ? (outside.length ? outside : ['This PC only']) : outside;
    const reach: Reach = {
      named: Array.from(new Set(results.flatMap(r => r.reach.named))),
      strangers: Array.from(new Set(results.flatMap(r => r.reach.strangers))),
    };
    const worst = results.filter(r => r.exposure === exposure);
    const how = (worst.find(r => r.allowedFrom.length > 0 && r.allowedFrom[0] !== 'This PC only') ?? worst[0])?.how ?? '';
    const part = isWindowsOwn(ctx);

    // A port only this PC can reach is background noise unless someone named it; short-lived UDP sockets stay out unless something can reach them.
    const quiet = exposure === 'local-only' || exposure === 'blocked';
    if (!entry && quiet && (group.every(l => bindClass(l.address) === 'loopback') || isEphemeralUdp(first.proto, first.port))) { omitted += 1; return; }

    const drift = !!entry && !withinIntent(entry.intended, exposure, reach, { desktop: registry.desktopName, server: registry.serverName });
    const notes: string[] = [];
    if (entry?.purpose) notes.push(entry.purpose);
    else if (part) notes.push('Part of Windows.');
    if (drift && entry) notes.push(`It should be reachable from ${INTENT_WORDS[entry.intended]}, and it is wider than that.`);
    if (!entry && !part && exposure !== 'local-only' && exposure !== 'blocked') notes.push('Not in the port registry yet: add what this is to data/firewall/registry.json.');
    ports.push({
      port: first.port, proto: first.proto, bind: windowsBindWords(group, facts), service: entry?.name ?? programLabel(facts, ctx),
      process: withoutExe(ctx.processName) || 'unknown', exposure, allowedFrom, note: notes.join(' '), how,
      registered: !!entry || part, ...(entry ? { intended: entry.intended } : {}), ...(drift ? { drift: true } : {}), runsIn: 'windows',
    });
  });
  return { ports, omitted };
}

// ── WSL ─────────────────────────────────────────────────────────────────────

/** WSL is on its own NAT network when its address sits inside the "WSL" virtual network Windows made for it; mirrored networking shares Windows' addresses. */
export function wslIsBehindNat(facts: WinFacts, wsl: WslFacts): boolean | null {
  let list: unknown;
  try { list = JSON.parse(wsl.ipAddr); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const wslAddresses: string[] = [];
  for (const i of list as Array<{ ifname?: string; addr_info?: Array<{ family?: string; local?: string }> }>) {
    if (!i.ifname || i.ifname === 'lo') continue;
    for (const a of i.addr_info ?? []) if (a.family === 'inet' && a.local) wslAddresses.push(a.local);
  }
  const wslNet = facts.addresses.find(a => a.family === 4 && /^vEthernet.*wsl/i.test(a.alias));
  if (!wslNet) return null;
  const inside = wslAddresses.some(a => inCidr(a, `${wslNet.address}/${wslNet.bits}`));
  const onLan = windowsInterfaces(facts).some(i => i.kind === 'lan' && i.v4.some(a => wslAddresses.some(w => inCidr(w, `${a.addr}/${a.bits}`))));
  return inside && !onLan;
}

export function buildWslPorts(facts: WinFacts, wsl: WslFacts, registry: Registry): DesktopPorts {
  const behindNat = wslIsBehindNat(facts, wsl);
  const groups = new Map<string, Listener[]>();
  for (const l of parseSs(wsl.ss)) {
    const key = [l.proto, l.port, l.process].join('|');
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const ports: FirewallPort[] = [];
  let omitted = 0;
  groups.forEach(group => {
    const first = group[0];
    const entry = lookup(registry, 'desktop', first.proto, first.port, 'wsl', first.process);
    const loopback = group.every(l => l.bind !== '*' && isLoopback(l.bind));
    // Behind WSL's own network nothing outside can reach any of it, so only what someone named is worth a row. If WSL shared the PC's addresses,
    // everything that listens beyond loopback would matter and is listed.
    if (!entry && (behindNat === true || loopback || isEphemeralUdp(first.proto, first.port))) { omitted += 1; return; }
    const exposure: Exposure = behindNat === true ? 'local-only' : 'unknown';
    const how = behindNat === true
      ? 'WSL has its own private network behind Windows. Nothing on your home network or tailnet can connect to it; only this PC can, because Windows passes chosen ports to its own loopback address.'
      : "Could not be worked out: WSL does not look like it is behind its own network, so Windows' firewall rules would decide, and the checker does not apply them to WSL yet.";
    const wildcard = group.some(l => l.bind === '*' || isWildcard(l.bind));
    const binds = Array.from(new Set(group.map(l => (l.bind === '*' ? 'all addresses' : isWildcard(l.bind) ? (parseAddress(l.bind)?.family === 6 ? 'all IPv6 addresses' : 'all IPv4 addresses') : l.bind))));
    const drift = !!entry && !withinIntent(entry.intended, exposure, { named: [], strangers: [] }, { desktop: registry.desktopName, server: registry.serverName });
    ports.push({
      port: first.port, proto: first.proto, bind: binds.length === 2 && binds.includes('all IPv4 addresses') && binds.includes('all IPv6 addresses') ? 'all addresses' : binds.join(', '),
      service: entry?.name ?? cleanProcess(first.process), process: cleanProcess(first.process), exposure,
      allowedFrom: exposure === 'local-only' ? ['This PC only'] : [],
      note: [entry?.purpose, wildcard && exposure === 'local-only' ? 'Listens on every address inside WSL, but WSL is not reachable from outside.' : ''].filter(Boolean).join(' '),
      how, registered: !!entry, ...(entry ? { intended: entry.intended } : {}), ...(drift ? { drift: true } : {}), runsIn: 'wsl',
    });
  });
  return { ports, omitted };
}

// ── The rules table ─────────────────────────────────────────────────────────

const PROFILE_WORDS: Array<[number, string]> = [[1, 'Domain'], [2, 'Private'], [4, 'Public']];
const profileWords = (mask: number): string => {
  const names = PROFILE_WORDS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
  return names.length === 3 || names.length === 0 ? 'any' : names.join(' + ');
};

function friendlyRemote(spec: string, named: NamedAddress[]): string {
  const text = spec.trim();
  if (text === '' || text === '*') return 'Anywhere';
  const tokens = text.split(',').map(t => t.trim()).filter(Boolean);
  const words = tokens.slice(0, 3).map(token => {
    const single = /^([^-/]+)-\1$/.exec(token)?.[1] ?? (token.includes('-') || token.includes('/') ? null : token);
    const who = single ? named.find(n => sameAddress(n.address, single)) : undefined;
    if (who && single) return `${single} (${who.name})`;
    if (/^localsubnet$/i.test(token)) return 'the local network';
    return single ?? token;
  });
  return tokens.length > 3 ? `${words.join(', ')} and ${tokens.length - 3} more ranges` : words.join(', ');
}

/** Rules that explain something: DevFlow's own, every block, and the allow rules written for programs we installed (not Windows' own or Store apps'). */
export function windowsRuleRows(facts: WinFacts, named: NamedAddress[]): FirewallRuleRow[] {
  const interesting = (r: WinRule): boolean => {
    if (r.package) return false;
    if (/^DevFlow/i.test(r.name) || r.action === 0) return true;
    if (r.app && !WINDOWS_DIR.test(r.app) && !/^system$/i.test(r.app)) return true;
    return !r.app && !r.service && !r.localPorts.trim() && r.remoteAddresses.trim() === '*';   // "allow everything" rules such as Tailscale's
  };
  const merged = new Map<string, FirewallRuleRow & { protos: Set<string> }>();
  for (const r of facts.rules.filter(interesting)) {
    const proto = r.protocol === 6 ? 'tcp' : r.protocol === 17 ? 'udp' : 'any';
    const ports = r.localPorts.trim() === '' || r.localPorts.trim() === '*' ? 'any' : r.localPorts.trim();
    const row = {
      action: r.action === 0 ? 'block' : 'allow', direction: 'in', ports, proto, from: friendlyRemote(r.remoteAddresses, named), interface: profileWords(r.profiles),
      comment: r.app && !/^system$/i.test(r.app) ? `${r.name} (${baseName(r.app)})` : r.name, protos: new Set([proto]),
    };
    const key = [row.action, row.ports, row.from, row.interface, row.comment].join('|');
    const existing = merged.get(key);
    if (existing) existing.protos.add(proto); else merged.set(key, row);
  }
  return Array.from(merged.values()).map(({ protos, ...row }) => ({ ...row, proto: protos.size > 1 ? Array.from(protos).sort().join('+') : row.proto }))
    .sort((a, b) => (a.action === b.action ? 0 : a.action === 'block' ? -1 : 1) || a.comment.localeCompare(b.comment));
}

// ── Controls ────────────────────────────────────────────────────────────────

export function desktopControls(facts: WinFacts, ports: FirewallPort[], wslNat: boolean | null): FirewallControl[] {
  const out: FirewallControl[] = [];
  const names = (bit: number): string => PROFILE_WORDS.find(([b]) => b === bit)?.[1] ?? '';
  const off = facts.profiles.filter(p => !p.enabled).map(p => names(p.type));
  const permissive = facts.profiles.filter(p => p.enabled && p.defaultInbound !== 0).map(p => names(p.type));
  const allows = facts.rules.filter(r => r.action === 1).length;
  const blocks = facts.rules.filter(r => r.action === 0).length;
  out.push({
    id: 'windows-firewall', title: 'Windows Firewall',
    state: off.length ? 'off' : permissive.length ? 'warn' : 'ok',
    summary: off.length ? `Off for the ${off.join(' and ')} network profile${off.length > 1 ? 's' : ''}.`
      : permissive.length ? `On, but incoming connections are allowed by default on ${permissive.join(' and ')} networks.`
        : `On for Domain, Private and Public networks. Incoming connections are blocked unless a rule allows them (${allows} allow rules, ${blocks} block rules).`,
    how: 'Each network is in one profile (your home network and the WSL network count as Public, Tailscale as Private) and the rules for that profile decide.',
    check: 'Get-NetFirewallProfile | Format-Table Name,Enabled,DefaultInboundAction',
  });

  const devflowBlocks = facts.rules.filter(r => r.action === 0 && /^DevFlow:/i.test(r.name));
  out.push({
    id: 'devflow-rules', title: "DevFlow's own rules",
    state: devflowBlocks.length >= 3 ? 'ok' : 'warn',
    summary: devflowBlocks.length >= 3
      ? 'The Remote server can reach SSH on this PC and nothing else, and the Computer Use bridge accepts only this PC and WSL.'
      : `Only ${devflowBlocks.length} of the 3 ${PRODUCT_NAME} block rules are in place, so the server or the Computer Use bridge may be less restricted than intended.`,
    how: 'Three block rules named "DevFlow: ..." sit above the allow rules: two stop the server on every port except SSH, one stops everything but this PC and WSL from the bridge.',
    check: 'Get-NetFirewallRule -DisplayName "DevFlow*" | Format-Table DisplayName,Action,Enabled',
  });

  // "Open" through the tailnet alone is the Tailscale control's business; this one is about the home network and beyond.
  const beyondTailnet = (p: FirewallPort): boolean => p.allowedFrom.some(a => /^Any device on the (?!.*tailnet)|^Anyone on the internet/.test(a));
  const exposed = ports.filter(p => p.runsIn === 'windows' && p.exposure === 'open' && beyondTailnet(p));
  const programs = Array.from(new Set(exposed.map(p => p.service)));
  const viaTailscaleOnly = ports.filter(p => p.runsIn === 'windows' && p.exposure === 'open' && !beyondTailnet(p));
  out.push({
    id: 'open-ports', title: 'Programs open to the network',
    state: exposed.length ? 'warn' : 'ok',
    summary: exposed.length
      ? `${exposed.length} listening ports accept connections from other devices on your network or the internet (${programs.slice(0, 6).join(', ')}${programs.length > 6 ? ` and ${programs.length - 6} more` : ''}).`
      : 'No program on this PC accepts connections from other devices on your network or the internet.',
    how: 'Open means a stranger on that network gets through the rules. Most come from a rule written for a program, often when Windows asked "allow this app?" (see the rules list, and the ports marked open for which rule).',
    check: 'Get-NetTCPConnection -State Listen | Where-Object LocalAddress -in "0.0.0.0","::" | Sort-Object LocalPort | Format-Table LocalAddress,LocalPort,OwningProcess',
  });

  const tailnetRule = facts.rules.find(r => r.action === 1 && /^Tailscale-In$/i.test(r.name));
  if (tailnetRule) {
    out.push({
      id: 'tailscale-in', title: 'Tailscale and this PC',
      state: 'warn',
      summary: `Tailscale's own rule lets every device on your tailnet reach everything listening on this PC${viaTailscaleOnly.length ? ` (${viaTailscaleOnly.length} ports are open to the tailnet only because of it)` : ''}.`,
      how: 'The Windows rule "Tailscale-In" allows any connection to this PC\'s Tailscale address. Only Tailscale\'s own access rules (ACL, set in its admin page) can narrow it, such as letting the Remote server reach port 22 and nothing else.',
      check: 'Get-NetFirewallRule -DisplayName "Tailscale-In" | Format-Table DisplayName,Enabled,Action,Profile',
    });
  }

  if (facts.ssh) {
    const cfg = facts.ssh.config;
    const keysOnly = cfg.passwordauthentication === 'no' && cfg.pubkeyauthentication !== 'no';
    out.push({
      id: 'windows-ssh', title: 'Windows SSH server',
      state: !facts.ssh.running ? 'ok' : keysOnly ? 'ok' : 'warn',
      summary: !facts.ssh.running ? 'The Windows SSH server is not running.'
        : `${keysOnly ? 'Key login only' : 'Passwords are accepted'}${cfg.allowusers ? `, only ${cfg.allowusers} may sign in` : ', any account may sign in'}${cfg.maxauthtries ? `, ${cfg.maxauthtries} tries per connection` : ''}${cfg.allowtcpforwarding === 'no' ? ', no tunnelling' : ''}.`,
      how: 'The server runs a gatekeeper script that lets the Remote server run one self-test command and refuses everything else (C:\\ProgramData\\DevFlowRemote\\policy.json has a kill switch).',
      check: 'Get-Content C:\\ProgramData\\ssh\\sshd_config | Select-String "PasswordAuthentication|AllowUsers|MaxAuthTries"',
    });
  }

  out.push({
    id: 'remote-desktop', title: 'Remote Desktop',
    state: facts.remoteDesktopDenied === null ? 'unknown' : facts.remoteDesktopDenied ? 'ok' : 'warn',
    summary: facts.remoteDesktopDenied === null ? 'Could not check.' : facts.remoteDesktopDenied ? 'Off: nobody can sign in to this PC remotely with Remote Desktop.' : 'On: this PC accepts Remote Desktop sign-ins.',
    how: 'Windows setting fDenyTSConnections.',
    check: '(Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server").fDenyTSConnections   (1 is off)',
  });

  if (facts.defender) {
    const d = facts.defender;
    out.push({
      id: 'defender', title: 'Windows Defender',
      state: d.realTime && d.antivirus && d.signatureAgeDays <= 7 ? 'ok' : 'warn',
      summary: `${d.realTime ? 'Real-time protection is on' : 'Real-time protection is OFF'}; its virus definitions are ${d.signatureAgeDays === 0 ? 'up to date' : `${d.signatureAgeDays} days old`}.`,
      how: "Windows' built-in antivirus.",
      check: 'Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled,AntivirusSignatureAge',
    });
  }

  out.push({
    id: 'wsl-network', title: 'WSL network',
    state: wslNat === null ? 'unknown' : wslNat ? 'ok' : 'warn',
    summary: wslNat === null ? 'Could not tell how WSL is networked.' : wslNat ? "WSL sits on its own private network behind Windows, so nothing outside this PC can reach the programs running in it." : 'WSL shares this PC\'s network addresses, so its ports are reachable like Windows ports.',
    how: 'WSL2 runs in NAT mode; Windows forwards chosen ports to its own loopback address only.',
    check: 'wsl hostname -I   (an address starting 172. is the private network)',
  });
  return out;
}
