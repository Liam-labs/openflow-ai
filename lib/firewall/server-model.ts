/** From the raw output of the commands run on a Linux server to a host model and the list of listening ports with their verdicts. */
import { classify, collapseCovered, linkWords, worse, type HostModel, type NamedAddress, type NetIface, type Reach } from './exposure';
import { isLoopback, isWildcard, parseAddress, sameAddress } from './net';
import { MAX_PUBLISHED_RANGE, parseDockerPublished, parseIptables } from './parse-iptables';
import { parseSs, parseUfwStatus, type Listener, type UfwStatus } from './parse-host';
import { lookup, type Intended, type MachineId, type Registry } from './registry';
import type { Exposure, FirewallPort, FirewallRuleRow } from './types';

export interface RawServerFacts {
  ufw: string;
  iptablesV4: string;
  iptablesV6: string;
  natDocker: string;
  ss: string;
  ipAddrJson: string;
  tailscaleJson: string;
}

export interface ServerSnapshot { model: HostModel; listeners: Listener[]; ufw: UfwStatus }

function parseInterfaces(json: string): NetIface[] {
  let list: unknown;
  try { list = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out: NetIface[] = [];
  for (const i of list as Array<{ ifname?: string; operstate?: string; addr_info?: Array<{ family?: string; local?: string; prefixlen?: number }> }>) {
    if (!i?.ifname) continue;
    const iface: NetIface = { name: i.ifname, up: i.operstate !== 'DOWN', v4: [], v6: [] };
    for (const a of i.addr_info ?? []) {
      if (!a.local || typeof a.prefixlen !== 'number') continue;
      (a.family === 'inet6' ? iface.v6 : iface.v4).push({ addr: a.local, bits: a.prefixlen });
    }
    out.push(iface);
  }
  return out;
}

/** The devices on the tailnet, by host name, from `tailscale status --json` (only host names and addresses are read). */
export function tailnetPeers(json: string): NamedAddress[] {
  let status: { Peer?: Record<string, { HostName?: string; TailscaleIPs?: string[] }> };
  try { status = JSON.parse(json); } catch { return []; }
  const out: NamedAddress[] = [];
  for (const peer of Object.values(status.Peer ?? {})) {
    const host = typeof peer.HostName === 'string' && peer.HostName ? peer.HostName : 'a tailnet device';
    for (const address of peer.TailscaleIPs ?? []) if (parseAddress(address)) out.push({ address, name: host });
  }
  return out;
}

/** Devices we can name: the registry's own names first, then the other devices on the tailnet. */
export function namedAddresses(registry: Registry, peers: NamedAddress[]): NamedAddress[] {
  return [...registry.addresses, ...peers.filter(p => !registry.addresses.some(a => sameAddress(a.address, p.address)))];
}

export function buildServerSnapshot(raw: RawServerFacts, registry: Registry): ServerSnapshot {
  const named = namedAddresses(registry, tailnetPeers(raw.tailscaleJson));
  const model: HostModel = {
    interfaces: parseInterfaces(raw.ipAddrJson),
    v4: parseIptables(raw.iptablesV4),
    v6: raw.iptablesV6.trim() ? parseIptables(raw.iptablesV6) : null,
    published: parseDockerPublished(raw.natDocker),
    named,
  };
  return { model, listeners: parseSs(raw.ss), ufw: parseUfwStatus(raw.ufw) };
}

export const INTENT_WORDS: Record<Intended, string> = {
  'this-machine': 'this machine only', 'desktop-only': 'the desktop only', 'server-only': 'the Remote server only', tailnet: 'the tailnet', 'home-network': 'the home network', public: 'anyone', nobody: 'nobody',
};

/** Is what the firewall lets in no wider than what the registry says it should be? Listening but stopped is never wider. */
export function withinIntent(intended: Intended, exposure: Exposure, reach: Reach, names: { desktop: string; server: string }): boolean {
  if (exposure === 'local-only' || exposure === 'blocked' || exposure === 'unknown') return true;
  switch (intended) {
    case 'this-machine': case 'nobody': return false;
    case 'desktop-only': return reach.strangers.length === 0 && reach.named.every(n => n === names.desktop);
    case 'server-only': return reach.strangers.length === 0 && reach.named.every(n => n === names.server);
    case 'tailnet': return !reach.strangers.includes('lan') && !reach.strangers.includes('internet');
    case 'home-network': return !reach.strangers.includes('internet');
    case 'public': return true;
  }
}

function describeBind(l: Listener, model: HostModel): string {
  if (l.bind === '*') return 'all addresses';
  if (isWildcard(l.bind)) return parseAddress(l.bind)?.family === 6 ? 'all IPv6 addresses' : 'all IPv4 addresses';
  const owner = l.zone ?? model.interfaces.find(i => [...i.v4, ...i.v6].some(a => sameAddress(a.addr, l.bind)))?.name;
  return owner && owner !== 'lo' ? `${l.bind} (${linkWords(owner)})` : l.bind;
}

function bindWords(group: Listener[], model: HostModel): string {
  const parts = Array.from(new Set(group.map(l => describeBind(l, model))));
  if (parts.length === 2 && parts.includes('all IPv4 addresses') && parts.includes('all IPv6 addresses')) return 'all addresses';
  return parts.join(', ');
}

/** `ss` cuts program names at 15 characters and shows interpreters with their script path; keep the part a person recognises. */
export function cleanProcess(name: string): string {
  const trimmed = name.replace(/\s*\(v\d+$/, '').trim();
  return trimmed.replace(/^(node|python3?)\s+\/.*$/, '$1') || 'unknown';
}

const SEVERITY: Record<Exposure, number> = { open: 0, unknown: 1, allowed: 2, blocked: 3, 'local-only': 4 };

export function buildPorts(snapshot: ServerSnapshot, registry: Registry, machine: MachineId): FirewallPort[] {
  const { model, listeners } = snapshot;
  // A Docker-published port is reachable even when no proxy process shows up in `ss` (userland-proxy off). It is reachable on the address it was
  // published on (`-p 127.0.0.1:8080:80` is this machine only, `-p 100.x.y.z:8080:80` the tailnet address only), not on every address.
  // Another program already listening on that port on a DIFFERENT address does not hide it.
  const all: Listener[] = [...listeners];
  for (const p of model.published) {
    const bind = p.hostAddr ?? '0.0.0.0';
    const covered = all.some(l => l.proto === p.proto && l.port === p.hostPort && (l.bind === '*' || isWildcard(l.bind) || sameAddress(l.bind, bind)));
    if (!covered) all.push({ proto: p.proto, bind, port: p.hostPort, process: 'docker', processes: ['docker'], pids: [] });
  }

  // One row per program and port: a program's IPv4 and IPv6 sockets are one service, and all its loopback addresses are one "this machine" listener.
  const groups = new Map<string, Listener[]>();
  for (const l of all) {
    const where = l.bind === '*' || isWildcard(l.bind) ? 'any' : isLoopback(l.bind) ? 'loopback' : `${l.bind}%${l.zone ?? ''}`;
    const key = [l.proto, l.port, l.process, where].join('|');
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }

  const ports: FirewallPort[] = [];
  groups.forEach(group => {
    const first = group[0];
    const results = group.map(l => classify(model, l));
    let exposure: Exposure = 'local-only';
    for (const r of results) exposure = worse(exposure, r.exposure);
    const reaching = results.filter(r => r.exposure !== 'local-only');
    const allowedFrom = exposure === 'local-only'
      ? ['This machine only']
      : collapseCovered(Array.from(new Set(reaching.flatMap(r => r.allowedFrom))));
    const reach: Reach = {
      named: Array.from(new Set(results.flatMap(r => r.reach.named))),
      strangers: Array.from(new Set(results.flatMap(r => r.reach.strangers))),
    };
    const how = results.find(r => r.exposure === exposure)?.how ?? '';
    const entry = lookup(registry, machine, first.proto, first.port, undefined, cleanProcess(first.process));
    const drift = !!entry && !withinIntent(entry.intended, exposure, reach, { desktop: registry.desktopName, server: registry.serverName });
    const notes: string[] = [];
    if (entry?.purpose) notes.push(entry.purpose);
    if (drift && entry) notes.push(`It should be reachable from ${INTENT_WORDS[entry.intended]}, and it is wider than that.`);
    if (!entry && exposure !== 'local-only' && exposure !== 'blocked') notes.push('Not in the port registry yet: add what this is to data/firewall/registry.json.');
    // A published range longer than the checker follows: say so rather than imply the rest were looked at.
    if (model.published.some(p => p.truncated && p.proto === first.proto && p.hostPort === first.port)) notes.push(`Part of a published port range; only the first ${MAX_PUBLISHED_RANGE} ports of the range are checked.`);
    ports.push({
      port: first.port, proto: first.proto, bind: bindWords(group, model), service: entry?.name ?? cleanProcess(first.process),
      process: cleanProcess(first.process), exposure, allowedFrom, note: notes.join(' '), how,
      registered: !!entry, ...(entry ? { intended: entry.intended } : {}), ...(drift ? { drift: true } : {}),
    });
  });
  return ports.sort((a, b) => SEVERITY[a.exposure] - SEVERITY[b.exposure] || a.port - b.port || a.proto.localeCompare(b.proto));
}

export function ruleRows(ufw: UfwStatus, named: NamedAddress[]): FirewallRuleRow[] {
  const nameOf = (from: string): string => {
    const match = named.find(n => sameAddress(n.address, from.split('/')[0]));
    return match ? `${from} (${match.name})` : from;
  };
  return ufw.rules.map(r => ({
    action: r.action, direction: r.direction, ports: r.ports, proto: r.proto, from: nameOf(r.from), interface: r.interface, comment: r.comment,
  }));
}
