/**
 * Walks a parsed iptables rule set the way the kernel does, for one NEW connection, and says what happens to it.
 *
 * This exists because reading ufw's rule list is not enough: Tailscale puts its own chain in front of ufw and accepts everything from the tailnet,
 * so a ufw rule that "only the desktop may connect" never saw a packet (found 18 Oct 2026). Following the real chains, jumps, marks and policies
 * shows what actually happens. When a rule uses something we do not understand, the answer is UNKNOWN, never a guess.
 */
import { ifaceMatches, inCidr } from './net';
import type { AddrTest, CtField, IfaceTest, Match, PortField, Rule, RuleTable } from './parse-iptables';

export interface Packet {
  family: 4 | 6;
  iface: string;
  outIface?: string;
  src: string;
  dst: string;
  proto: 'tcp' | 'udp';
  sport: number;
  dport: number;
  /** What the destination address is to this host: its own address, a multicast group, a broadcast. */
  dstType: 'LOCAL' | 'UNICAST' | 'MULTICAST' | 'BROADCAST';
  hopLimit?: number;
  /** Where the connection was headed before Docker rewrote it (conntrack's "original" tuple). Left out when nothing was rewritten: then it is `dst`/`dport`. */
  origDst?: string;
  origDport?: number;
  /** The packet belongs to a connection whose destination was rewritten (DNAT): `--ctstate DNAT` matches it. */
  dnat?: boolean;
}

export type Verdict = 'ACCEPT' | 'DROP' | 'UNKNOWN';

export interface Hop { chain: string; rule: string; action: 'ACCEPT' | 'DROP' | 'POLICY' | 'UNKNOWN' }
export interface Result { verdict: Verdict; decidedBy: Hop }

type Tri = boolean | 'unknown';
type Outcome = { kind: 'ACCEPT' | 'DROP'; hop: Hop } | { kind: 'UNKNOWN'; hop: Hop } | { kind: 'RETURN' };

const BUILTIN = new Set(['INPUT', 'FORWARD', 'OUTPUT', 'PREROUTING', 'POSTROUTING']);
/** Targets that do something to the packet but never decide its fate; the walk goes on to the next rule. */
const PASS_THROUGH = new Set(['LOG', 'NFLOG', 'TRACE', 'AUDIT', 'CONNMARK', 'CLASSIFY', 'SECMARK', 'CONNSECMARK', 'NOTRACK', 'TCPMSS', 'TOS', 'DSCP', 'TTL', 'HL', 'ECN']);
const MAX_STEPS = 20_000;

const portInSpec = (spec: string, port: number): boolean => spec.split(',').some(item => {
  const [a, b] = item.split(':');
  return b === undefined ? Number(a) === port : port >= Number(a) && port <= Number(b);
});

function testIface(test: IfaceTest | undefined, actual: string | undefined): Tri {
  if (!test) return true;
  if (actual === undefined) return 'unknown';
  return ifaceMatches(test.name, actual) !== test.neg;
}

function testAddr(test: AddrTest | undefined, addr: string): Tri {
  if (!test) return true;
  return inCidr(addr, test.cidr) !== test.neg;
}

const TCP_FLAGS = ['SYN', 'ACK', 'FIN', 'RST', 'URG', 'PSH'];

/** `--tcp-flags MASK COMP`: of the flags in MASK, exactly those in COMP are set. The packets we ask about open a connection, so only SYN is set. */
function tcpFlagsMatch(mask: string, comp: string): Tri {
  const expand = (spec: string): Set<string> | null => {
    const upper = spec.toUpperCase();
    if (upper === 'ALL') return new Set(TCP_FLAGS);
    if (upper === 'NONE') return new Set();
    const names = upper.split(',').filter(Boolean);
    return names.every(n => TCP_FLAGS.includes(n)) ? new Set(names) : null;
  };
  const m = expand(mask);
  const c = expand(comp);
  if (!m || !c) return 'unknown';
  const set = ['SYN'].filter(flag => m.has(flag));
  return set.length === c.size && set.every(flag => c.has(flag));
}

/** All of a match's options must hold (each one negated or not on its own). A false anywhere is a no; otherwise a doubt anywhere is a doubt. */
function allOf(results: Tri[]): Tri {
  if (results.some(r => r === false)) return false;
  return results.some(r => r === 'unknown') ? 'unknown' : true;
}

function testMatch(match: Match, packet: Packet, mark: number, terminal: boolean): Tri {
  switch (match.kind) {
    case 'ports': {
      if (match.proto !== packet.proto) return false;
      const results: Tri[] = [];
      const add = (field: PortField, held: Tri): void => { results.push(held === 'unknown' ? 'unknown' : held !== (match.negs?.[field] === true)); };
      if (match.dport !== undefined) add('dport', portInSpec(match.dport, packet.dport));
      if (match.sport !== undefined) add('sport', portInSpec(match.sport, packet.sport));
      if (match.dports !== undefined) add('dports', portInSpec(match.dports, packet.dport));
      if (match.sports !== undefined) add('sports', portInSpec(match.sports, packet.sport));
      if (match.ports !== undefined) add('ports', portInSpec(match.ports, packet.dport) || portInSpec(match.ports, packet.sport));
      if (match.flags) add('flags', tcpFlagsMatch(match.flags.mask, match.flags.comp));
      if (match.syn) add('syn', tcpFlagsMatch('SYN,RST,ACK,FIN', 'SYN'));
      return allOf(results);
    }
    case 'conntrack': {
      const results: Tri[] = [];
      const add = (field: CtField, held: boolean): void => { results.push(held !== (match.negs?.[field] === true)); };
      // Every packet we ask about opens a new connection; one that came through Docker's DNAT also has the DNAT state.
      if (match.states.length) add('state', match.states.includes('NEW') || (packet.dnat === true && match.states.includes('DNAT')));
      if (match.origDstPort !== undefined) add('origDstPort', portInSpec(match.origDstPort, packet.origDport ?? packet.dport));
      if (match.origSrcPort !== undefined) add('origSrcPort', portInSpec(match.origSrcPort, packet.sport));
      if (match.origDst !== undefined) add('origDst', inCidr(packet.origDst ?? packet.dst, match.origDst));
      if (match.origSrc !== undefined) add('origSrc', inCidr(packet.src, match.origSrc));
      if (match.dir !== undefined) add('dir', match.dir === 'ORIGINAL');       // the first packet of a connection travels in the original direction
      return allOf(results);
    }
    case 'icmp': return false;                                                  // we only ask about TCP and UDP
    case 'addrtype': {
      const dst = !match.dst || (packet.dstType === match.dst) !== (match.negs?.dst === true);
      const src = !match.src || (match.src === 'UNICAST') !== (match.negs?.src === true);
      return dst && src;
    }
    case 'mark': return ((mark & match.mask) === match.value) !== match.neg;
    case 'hl': {
      const hl = packet.hopLimit ?? 64;
      const ok = (match.eq === undefined || hl === match.eq) && (match.lt === undefined || hl < match.lt) && (match.gt === undefined || hl > match.gt);
      return ok !== match.neg;
    }
    case 'rt': return false;                                                    // an ordinary packet carries no routing header
    case 'comment': return true;
    case 'limit': return terminal ? 'unknown' : true;                           // a rate limit in front of a logging target changes nothing; in front of a verdict it does
    case 'unsupported': return 'unknown';
  }
}

function ruleMatches(rule: Rule, packet: Packet, mark: number): Tri {
  let unknown = false;
  const check = (result: Tri): boolean => {            // true = keep going, false = definitely not a match
    if (result === false) return false;
    if (result === 'unknown') unknown = true;
    return true;
  };
  const terminal = rule.target === 'ACCEPT' || rule.target === 'DROP' || rule.target === 'REJECT';
  if (!check(testIface(rule.inIface, packet.iface))) return false;
  if (!check(testIface(rule.outIface, packet.outIface))) return false;
  if (!check(testAddr(rule.src, packet.src))) return false;
  if (!check(testAddr(rule.dst, packet.dst))) return false;
  if (rule.proto) {
    const name = rule.proto.name;
    const same = name === 'all' || name === packet.proto;
    if (same === rule.proto.neg) return false;
  }
  for (const m of rule.matches) if (!check(testMatch(m, packet, mark, terminal))) return false;
  return unknown ? 'unknown' : true;
}

export function evaluate(table: RuleTable, hook: 'INPUT' | 'FORWARD', packet: Packet): Result {
  let mark = 0;
  let steps = 0;

  const run = (name: string, depth: number): Outcome => {
    const rules = table.chains[name];
    if (!rules) return { kind: 'UNKNOWN', hop: { chain: name, rule: `chain ${name} is not in the rule set`, action: 'UNKNOWN' } };
    for (const rule of rules) {
      if (++steps > MAX_STEPS || depth > 25) return { kind: 'UNKNOWN', hop: { chain: name, rule: 'the rules loop or are too deep to follow', action: 'UNKNOWN' } };
      const hit = ruleMatches(rule, packet, mark);
      if (hit === false) continue;
      const target = rule.target;
      // A rule with no verdict and no jump (a counter, `-m recent --set`, `-j TCPMSS`) cannot change what happens to the packet, so a match
      // we do not understand there is no reason to stop (`ufw limit 22/tcp` starts with such a rule, and used to make SSH "unknown" for ever).
      if (hit === 'unknown' && (target === '' || PASS_THROUGH.has(target))) continue;
      if (hit === 'unknown') return { kind: 'UNKNOWN', hop: { chain: name, rule: rule.raw, action: 'UNKNOWN' } };
      if (target === 'ACCEPT') return { kind: 'ACCEPT', hop: { chain: name, rule: rule.raw, action: 'ACCEPT' } };
      if (target === 'DROP' || target === 'REJECT') return { kind: 'DROP', hop: { chain: name, rule: rule.raw, action: 'DROP' } };
      if (target === 'RETURN') return { kind: 'RETURN' };
      if (target === '' || PASS_THROUGH.has(target)) continue;
      if (target === 'MARK') {
        const x = rule.args['set-xmark'] ?? rule.args['set-mark'];
        if (x !== undefined) {
          const [v, m] = x.split('/');
          const value = Number(v);
          const mask = m === undefined ? 0xffffffff : Number(m);
          mark = ((mark & ~mask) ^ value) >>> 0;
        }
        continue;
      }
      if (target in table.chains && !BUILTIN.has(target)) {
        const inner = run(target, depth + 1);
        if (inner.kind !== 'RETURN') return inner;
        if (rule.goto) return { kind: 'RETURN' };
        continue;
      }
      return { kind: 'UNKNOWN', hop: { chain: name, rule: rule.raw, action: 'UNKNOWN' } };
    }
    return { kind: 'RETURN' };
  };

  const outcome = run(hook, 0);
  if (outcome.kind === 'RETURN') {
    const policy = table.policies[hook] ?? 'ACCEPT';
    return { verdict: policy === 'ACCEPT' ? 'ACCEPT' : 'DROP', decidedBy: { chain: hook, rule: `policy ${policy}`, action: 'POLICY' } };
  }
  return { verdict: outcome.kind, decidedBy: outcome.hop };
}
