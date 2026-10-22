/**
 * For each listening port, who can reach it? Tried by asking the real rule set (lib/firewall/evaluate.ts) about a set of imagined senders:
 * the machines we know by name (the desktop, other Tailscale devices) and, on every network card, a stranger on that network. A port is `open`
 * when a stranger gets in, `allowed` when only named senders do, `blocked` when nobody does, `unknown` when a rule could not be understood.
 */
import { evaluate, type Hop, type Packet, type Result } from './evaluate';
import { formatAddress, inCidr, isLoopback, isWildcard, parseAddress, sameAddress } from './net';
import type { Published, RuleTable } from './parse-iptables';
import type { Listener } from './parse-host';
import type { Exposure } from './types';

export interface NetIface { name: string; up: boolean; v4: Array<{ addr: string; bits: number }>; v6: Array<{ addr: string; bits: number }> }
export interface NamedAddress { address: string; name: string }

export interface HostModel {
  interfaces: NetIface[];
  v4: RuleTable;
  v6: RuleTable | null;
  published: Published[];
  named: NamedAddress[];
}

/** Where a sender sits: on the tailnet, on the local network of a network card, out on the internet, or on this machine's own virtual side (WSL, VMs). */
export type Scope = 'tailnet' | 'lan' | 'internet' | 'internal';
export type StrangerScope = Exclude<Scope, 'internal'>;

/** Who gets in, kept as data so the registry's intended exposure can be compared with it. */
export interface Reach { named: string[]; strangers: StrangerScope[] }

export interface Classification { exposure: Exposure; allowedFrom: string[]; how: string; reach: Reach }

export interface Scenario {
  family: 4 | 6;
  iface: string;
  src: string;
  dst: string;
  /** named: a device we know by name. stranger: any other device on that network. internal: this machine's own virtual side. */
  kind: 'named' | 'stranger' | 'internal';
  scope: Scope;
  /** The sender in plain words: "the desktop over Tailscale", "Any device on the Wi-Fi network". */
  label: string;
  /** Where that sender sits, finishing "anyone on ...": "your tailnet", "the Wi-Fi network", "the internet". */
  where: string;
}

const TAILNET_V4 = '100.64.0.0/10';
const TAILNET_V6 = 'fd7a:115c:a1e0::/48';
const INTERNAL_IFACE = /^(lo|docker\d*|br-.*|veth.*|virbr.*)$/;
const NO_REACH: Reach = { named: [], strangers: [] };

/** Client-only ports that still take a reply from a fixed server port (DHCP). A packet from that source port is tried when nothing else gets in. */
export const REPLY_SOURCE_PORT: Record<string, number> = { 'udp/68': 67, 'udp/546': 547 };

export const isTailnetIface = (name: string): boolean => name.startsWith('tailscale') || name.startsWith('utun');

/** A network card in words a person uses. */
export function linkWords(iface: string): string {
  if (isTailnetIface(iface)) return 'Tailscale';
  if (/^wl/.test(iface)) return 'Wi-Fi';
  if (/^(en|eth)/.test(iface)) return 'Ethernet';
  return iface;
}

/** Interfaces traffic from outside can arrive on. */
export function externalInterfaces(model: HostModel): NetIface[] {
  return model.interfaces.filter(i => i.up && !INTERNAL_IFACE.test(i.name));
}

// An address in the same subnet as `own` with a host part that is not `own` and not in `taken`; null when the subnet has no room.
export function sameSubnetHost(own: string, bits: number, taken: string[]): string | null {
  const a = parseAddress(own);
  if (!a) return null;
  const max = a.family === 4 ? 32 : 128;
  if (a.family === 4 && bits >= 31) return null;
  const hostBits = BigInt(max - bits);
  const network = (a.value >> hostBits) << hostBits;
  const top = (BigInt(1) << hostBits) - BigInt(1);
  const hosts = a.family === 4 ? [top - BigInt(1), top - BigInt(2), top - BigInt(3)] : [BigInt(0x77), BigInt(0x78), BigInt(0x79)];
  for (const h of hosts) {
    const addr = formatAddress(a.family, network | h);
    if (!sameAddress(addr, own) && !taken.some(t => sameAddress(t, addr))) return addr;
  }
  return null;
}

export const isLinkLocal = (addr: string): boolean => addr.toLowerCase().startsWith('fe80');

export function scenariosFor(model: HostModel): Scenario[] {
  const out: Scenario[] = [];
  const taken = model.named.map(n => n.address);
  for (const iface of externalInterfaces(model)) {
    const tailnet = isTailnetIface(iface.name);
    const link = linkWords(iface.name);
    const lanWhere = `the ${link} network`;
    for (const family of [4, 6] as const) {
      for (const own of family === 4 ? iface.v4 : iface.v6) {
        const linkLocal = family === 6 && isLinkLocal(own.addr);
        if (tailnet && linkLocal) continue;
        const inside = (address: string): boolean => {
          if (parseAddress(address)?.family !== family) return false;
          if (tailnet) return inCidr(address, family === 4 ? TAILNET_V4 : TAILNET_V6);
          return inCidr(address, `${own.addr}/${own.bits}`);
        };
        for (const n of model.named) {
          if (inside(n.address) && !sameAddress(n.address, own.addr)) out.push({ family, iface: iface.name, src: n.address, dst: own.addr, kind: 'named', scope: tailnet ? 'tailnet' : 'lan', label: `${n.name} over ${link}`, where: tailnet ? 'your tailnet' : lanWhere });
        }
        const neighbour = tailnet ? (family === 4 ? '100.64.0.77' : 'fd7a:115c:a1e0:ab12::77') : sameSubnetHost(own.addr, own.bits, taken);
        if (neighbour && !taken.some(t => sameAddress(t, neighbour))) {
          out.push(tailnet
            ? { family, iface: iface.name, src: neighbour, dst: own.addr, kind: 'stranger', scope: 'tailnet', label: 'Any device on your tailnet', where: 'your tailnet' }
            : { family, iface: iface.name, src: neighbour, dst: own.addr, kind: 'stranger', scope: 'lan', label: `Any device on ${lanWhere}`, where: lanWhere });
        }
        if (!tailnet && !linkLocal) {
          const far = family === 4 ? '203.0.113.77' : '2001:db8:77::1';
          out.push({ family, iface: iface.name, src: far, dst: own.addr, kind: 'stranger', scope: 'internet', label: 'Anyone on the internet', where: 'the internet' });
        }
      }
    }
  }
  return out;
}

const WORSE: Record<Exposure, number> = { open: 4, unknown: 3, allowed: 2, blocked: 1, 'local-only': 0 };
export const worse = (a: Exposure, b: Exposure): Exposure => (WORSE[a] >= WORSE[b] ? a : b);

export function describeHop(hop: Hop, iface = ''): string {
  const chain = hop.chain.replace(/^ufw6-/, 'ufw-');
  switch (chain) {
    case 'ts-input':
      if (hop.action === 'DROP') return 'Tailscale\'s own rule that drops tailnet addresses arriving from outside';
      return isTailnetIface(iface) ? "Tailscale's own rule that accepts everything from the tailnet before ufw is asked" : "Tailscale's own rule that opens its direct-connection port before ufw is asked";
    case 'ts-forward': return "Tailscale's own rule that accepts everything from the tailnet before the Docker filter is asked";
    case 'ufw-user-input': return 'a ufw allow rule';
    case 'ufw-before-input': return "one of ufw's built-in rules (loopback, replies, DHCP, multicast)";
    case 'ufw-skip-to-policy-input': return "ufw's built-in drop for noisy ports";
    case 'DOCKER': return "Docker's publish rule (behind the DOCKER-USER filter)";
    case 'DOCKER-USER': return 'the DOCKER-USER filter';
    default: return hop.action === 'POLICY' ? 'the default deny' : `a rule in ${hop.chain}`;
  }
}

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

/** A named device on a network where "any device" is already listed adds nothing: "the desktop over Tailscale" goes when "Any device on your tailnet" is there. */
export function collapseCovered(labels: string[]): string[] {
  return labels.filter(label => {
    const over = / over (.+)$/.exec(label);
    if (!over) return true;
    const stranger = over[1] === 'Tailscale' ? 'Any device on your tailnet' : `Any device on the ${over[1]} network`;
    return !labels.includes(stranger);
  });
}
const sentence = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

export interface Trial { scenario: Scenario; result: Result }

/** Says in words which rule decided a packet's fate; each kind of host has its own rules and its own phrases. */
export type Describe = (hop: Hop, scenario: Scenario) => string;

type ListenerKey = Pick<Listener, 'proto' | 'port' | 'bind' | 'zone'>;

/**
 * Which Docker publish a listener belongs to. A publish on one address (`-p 127.0.0.1:8080:80`) belongs to a listener on that address; a publish on
 * every address belongs to a listener on any address (a wildcard, or the host's own). Two publishes of one port on different addresses go to
 * different containers, so the port number alone does not say which.
 */
export function publishedFor(model: HostModel, listener: ListenerKey): Published | undefined {
  const candidates = model.published.filter(p => p.proto === listener.proto && p.hostPort === listener.port);
  if (candidates.length <= 1) return candidates[0];
  const wildcard = listener.bind === '*' || isWildcard(listener.bind);
  return (wildcard ? undefined : candidates.find(p => p.hostAddr && sameAddress(p.hostAddr, listener.bind)))
    ?? candidates.find(p => !p.hostAddr)
    ?? candidates[0];
}

/** The evaluator names the rule it could not read; say what that means. */
const explainUnknown = (r: Result): Result => (r.verdict === 'UNKNOWN'
  ? { ...r, decidedBy: { ...r.decidedBy, rule: `a rule the checker does not understand sits in the way (${r.decidedBy.rule})` } }
  : r);

function runScenarios(model: HostModel, listener: ListenerKey, sport: number): Trial[] {
  const wildcard = listener.bind === '*' || isWildcard(listener.bind);
  const bindFamily = listener.bind === '*' ? null : parseAddress(listener.bind)?.family ?? null;
  const published = publishedFor(model, listener);

  const chosen = scenariosFor(model).filter(s => {
    if (wildcard) return bindFamily === null || s.family === bindFamily;
    if (listener.zone && s.iface !== listener.zone) return false;
    return sameAddress(s.dst, listener.bind);
  });

  return chosen.map(scenario => {
    const table = scenario.family === 6 ? model.v6 : model.v4;
    if (!table) return { scenario, result: { verdict: 'UNKNOWN', decidedBy: { chain: 'INPUT', rule: 'the IPv6 rules could not be read', action: 'UNKNOWN' } } as Result };
    if (published && scenario.family === 4) {
      const bridge = model.interfaces.find(i => i.v4.some(a => inCidr(published.containerIp, `${a.addr}/${a.bits}`)));
      const packet: Packet = {
        family: 4, iface: scenario.iface, outIface: bridge?.name, src: scenario.src, dst: published.containerIp,
        proto: listener.proto, sport, dport: published.containerPort, dstType: 'UNICAST',
        origDst: scenario.dst, origDport: listener.port, dnat: true,
      };
      return { scenario, result: explainUnknown(evaluate(table, 'FORWARD', packet)) };
    }
    const packet: Packet = { family: scenario.family, iface: scenario.iface, src: scenario.src, dst: scenario.dst, proto: listener.proto, sport, dport: listener.port, dstType: 'LOCAL' };
    return { scenario, result: explainUnknown(evaluate(table, 'INPUT', packet)) };
  });
}

export function classify(model: HostModel, listener: ListenerKey): Classification {
  const published = publishedFor(model, listener) !== undefined;
  if (!published && listener.bind !== '*' && isLoopback(listener.bind)) {
    return { exposure: 'local-only', allowedFrom: ['This machine only'], how: 'It listens on the loopback address, so nothing outside this machine can connect.', reach: NO_REACH };
  }
  const trials = runScenarios(model, listener, 40000);
  if (trials.length === 0) {
    return { exposure: 'local-only', allowedFrom: ['This machine only'], how: 'It listens on an address that no outside network card owns, so only this machine (or its containers) can connect.', reach: NO_REACH };
  }
  const replyPort = REPLY_SOURCE_PORT[`${listener.proto}/${listener.port}`];
  return summarizeTrials(trials, (hop, scenario) => describeHop(hop, scenario.iface), replyPort ? { port: replyPort, run: () => runScenarios(model, listener, replyPort) } : undefined);
}

/**
 * Turns the verdicts for each imagined sender into the one answer shown for a port. Worst first: a stranger let in is `open`, a rule that could not be
 * read is `unknown`, only named devices let in is `allowed`, only this machine's own virtual side is `local-only`, nobody is `blocked`.
 */
export function summarizeTrials(trials: Trial[], describe: Describe, replies?: { port: number; run: () => Trial[] }): Classification {
  const accepted = trials.filter(t => t.result.verdict === 'ACCEPT');
  const unknown = trials.filter(t => t.result.verdict === 'UNKNOWN');
  const strangers = accepted.filter(t => t.scenario.kind === 'stranger');
  // A named device on a network where any stranger is let in adds nothing to the list.
  const covered = new Set(strangers.map(t => `${t.scenario.scope}|${t.scenario.iface}`));
  const namedIn = accepted.filter(t => t.scenario.kind === 'named' && !covered.has(`${t.scenario.scope}|${t.scenario.iface}`));
  const internalIn = accepted.filter(t => t.scenario.kind === 'internal');
  const allowedFrom = unique([...strangers, ...namedIn, ...(namedIn.length || strangers.length ? internalIn : [])].map(t => t.scenario.label));
  const reach: Reach = {
    named: unique(namedIn.map(t => t.scenario.label.replace(/ over .*$/, ''))),
    strangers: unique(strangers.map(t => t.scenario.scope as StrangerScope)),
  };

  if (strangers.length) {
    const byRule = new Map<string, string[]>();
    for (const t of strangers) {
      const rule = describe(t.result.decidedBy, t.scenario);
      byRule.set(rule, [...(byRule.get(rule) ?? []), t.scenario.where]);
    }
    const parts = Array.from(byRule, ([rule, wheres]) => `anyone on ${sentence(unique(wheres))} is let in by ${rule}`);
    return { exposure: 'open', allowedFrom, reach, how: `${parts.join('; ').replace(/^./, c => c.toUpperCase())}.` };
  }
  if (unknown.length) {
    return { exposure: 'unknown', allowedFrom, reach, how: `Could not be worked out: ${unknown[0].result.decidedBy.rule}.` };
  }
  const refused = unique(trials.filter(t => t.result.verdict === 'DROP' && t.scenario.kind === 'stranger').map(t => describe(t.result.decidedBy, t.scenario)));
  if (namedIn.length) {
    return { exposure: 'allowed', allowedFrom: unique([...namedIn, ...internalIn].map(t => t.scenario.label)), reach, how: `Only these are let in, by ${sentence(unique(namedIn.map(t => describe(t.result.decidedBy, t.scenario))))}. Everyone else is stopped by ${sentence(refused.length ? refused : ['the default deny'])}.` };
  }
  if (internalIn.length) {
    return {
      exposure: 'local-only', reach: NO_REACH, allowedFrom: unique(internalIn.map(t => t.scenario.label)),
      how: `Only this machine's own virtual side can connect, by ${sentence(unique(internalIn.map(t => describe(t.result.decidedBy, t.scenario))))}. Everyone else is stopped by ${sentence(refused.length ? refused : ['the default deny'])}.`,
    };
  }

  if (replies) {
    // A server's reply can only come from the local network, so the far-away "internet" sender is not part of this answer.
    const answered = replies.run().filter(t => t.result.verdict === 'ACCEPT' && t.scenario.scope === 'lan');
    if (answered.length) {
      return {
        exposure: 'allowed', reach: NO_REACH,
        allowedFrom: unique(answered.map(t => `Server replies (from port ${replies.port}) on ${t.scenario.where}`)),
        how: `Only replies that come from the server's own port (${replies.port}) are let in, by ${sentence(unique(answered.map(t => describe(t.result.decidedBy, t.scenario))))}. Anything else is stopped by the default deny.`,
      };
    }
  }
  const stoppers = unique(trials.map(t => describe(t.result.decidedBy, t.scenario)));
  return { exposure: 'blocked', allowedFrom: [], reach: NO_REACH, how: `It is listening, but ${sentence(stoppers)} ${stoppers.length === 1 ? 'stops' : 'stop'} every connection.` };
}
