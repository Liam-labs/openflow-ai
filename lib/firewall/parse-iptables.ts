/**
 * Reads `iptables -S` / `ip6tables -S` output into rules the evaluator can walk.
 *
 * Only the vocabulary that appears on the servers we run (ufw, Docker, Tailscale) is understood. Anything else becomes an `unsupported`
 * match, and the evaluator answers UNKNOWN when a packet reaches one, so the panel never claims a port is closed because a rule was not understood.
 * That includes an OPTION this parser does not know on a module it otherwise knows (`-m tcp --tcp-flags ...`, `-m conntrack --ctstatus ...`): the
 * match used to be silently widened, and a rule meant for a few packets read as a rule for all of them (19 Oct 2026 review).
 */

export interface IfaceTest { name: string; neg: boolean }
export interface AddrTest { cidr: string; neg: boolean }

/** Which options of a match were written with a `!` in front of them. Present only when at least one was. Each option is negated on its own. */
type Negs<K extends string> = { negs?: Partial<Record<K, true>> };
export type PortField = 'dport' | 'sport' | 'dports' | 'sports' | 'ports' | 'flags' | 'syn';
export type CtField = 'state' | 'origDstPort' | 'origSrcPort' | 'origDst' | 'origSrc' | 'dir';

export type Match =
  | ({ kind: 'ports'; proto: 'tcp' | 'udp'; neg: boolean; dport?: string; sport?: string; dports?: string; sports?: string; ports?: string;
       flags?: { mask: string; comp: string }; syn?: boolean } & Negs<PortField>)
  | ({ kind: 'conntrack'; neg: boolean; states: string[]; origDstPort?: string; origSrcPort?: string; origDst?: string; origSrc?: string; dir?: string } & Negs<CtField>)
  | { kind: 'icmp'; neg: boolean; type: string }
  | ({ kind: 'addrtype'; neg: boolean; dst?: string; src?: string } & Negs<'dst' | 'src'>)
  | { kind: 'mark'; neg: boolean; value: number; mask: number }
  | { kind: 'hl'; neg: boolean; eq?: number; lt?: number; gt?: number }
  | { kind: 'rt' }
  | { kind: 'limit' }
  | { kind: 'comment' }
  | { kind: 'unsupported'; module: string };

export interface Rule {
  chain: string;
  raw: string;
  inIface?: IfaceTest;
  outIface?: IfaceTest;
  src?: AddrTest;
  dst?: AddrTest;
  proto?: { name: string; neg: boolean };
  matches: Match[];
  target: string;
  goto: boolean;
  args: Record<string, string>;
}

export interface RuleTable {
  policies: Record<string, string>;
  chains: Record<string, Rule[]>;
}

export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) tokens.push(m[1] !== undefined ? m[1] : m[2]);
  return tokens;
}

/** The kinds of match whose options decide whether a packet matches. An option of one of these that is not handled above makes the match unsupported. */
const EVALUATED = new Set<Match['kind']>(['ports', 'conntrack', 'icmp', 'addrtype', 'mark', 'hl']);

const toMask = (text: string): { value: number; mask: number } => {
  const [v, m] = text.split('/');
  return { value: Number(v), mask: m === undefined ? 0xffffffff : Number(m) };
};

export function parseRule(line: string): Rule | null {
  const t = tokenize(line.trim());
  if (t[0] !== '-A' || t.length < 2) return null;
  const rule: Rule = { chain: t[1], raw: line.trim(), matches: [], target: '', goto: false, args: {} };
  let neg = false;
  let module: string | null = null;
  let current: Match | null = null;
  const own = <T extends Match>(m: T): T => { rule.matches.push(m); current = m; return m; };
  /** Writes `!` onto one option of the current match, so `! --dport 22 --sport 1024:` negates only the first. */
  const negate = (m: { neg: boolean; negs?: Partial<Record<string, true>> }, field: string, flag: boolean): void => {
    if (!flag) return;
    m.neg = true;
    (m.negs ??= {})[field] = true;
  };
  /** The current match used an option this parser cannot evaluate: it becomes an unsupported match, so a packet that reaches it is UNKNOWN. */
  const cannotEvaluate = (): void => {
    const at = current ? rule.matches.indexOf(current) : -1;
    if (at >= 0 && module) { const replacement: Match = { kind: 'unsupported', module }; rule.matches[at] = replacement; current = replacement; }
  };

  for (let i = 2; i < t.length; i++) {
    const tok = t[i];
    const next = () => t[++i];
    if (tok === '!') { neg = true; continue; }
    const flag = neg;
    neg = false;
    const cur = current as Match | null; // assigned inside own(), which flow analysis cannot see
    switch (tok) {
      case '-i': case '--in-interface': rule.inIface = { name: next(), neg: flag }; break;
      case '-o': case '--out-interface': rule.outIface = { name: next(), neg: flag }; break;
      case '-s': case '--source': rule.src = { cidr: next(), neg: flag }; break;
      case '-d': case '--destination': rule.dst = { cidr: next(), neg: flag }; break;
      case '-p': case '--protocol': rule.proto = { name: next().toLowerCase(), neg: flag }; break;
      case '-m': case '--match': {
        module = next();
        current = null;
        if (module === 'tcp' || module === 'udp') own({ kind: 'ports', proto: module, neg: false });
        else if (module === 'multiport') own({ kind: 'ports', proto: (rule.proto?.name === 'udp' ? 'udp' : 'tcp'), neg: false });
        else if (module === 'conntrack' || module === 'state') own({ kind: 'conntrack', neg: false, states: [] });
        else if (module === 'icmp' || module === 'icmp6') own({ kind: 'icmp', neg: false, type: '' });
        else if (module === 'addrtype') own({ kind: 'addrtype', neg: false });
        else if (module === 'mark') own({ kind: 'mark', neg: false, value: 0, mask: 0xffffffff });
        else if (module === 'limit') own({ kind: 'limit' });
        else if (module === 'hl') own({ kind: 'hl', neg: false });
        else if (module === 'rt') own({ kind: 'rt' });
        else if (module === 'comment') own({ kind: 'comment' });
        else own({ kind: 'unsupported', module });
        break;
      }
      case '--dport': case '--destination-port': if (cur?.kind === 'ports') { cur.dport = next(); negate(cur, 'dport', flag); } break;
      case '--sport': case '--source-port': if (cur?.kind === 'ports') { cur.sport = next(); negate(cur, 'sport', flag); } break;
      case '--dports': case '--destination-ports': if (cur?.kind === 'ports') { cur.dports = next(); negate(cur, 'dports', flag); } break;
      case '--sports': case '--source-ports': if (cur?.kind === 'ports') { cur.sports = next(); negate(cur, 'sports', flag); } break;
      case '--ports': if (cur?.kind === 'ports') { cur.ports = next(); negate(cur, 'ports', flag); } break;
      case '--tcp-flags': if (cur?.kind === 'ports') { cur.flags = { mask: next(), comp: next() }; negate(cur, 'flags', flag); } break;
      case '--syn': if (cur?.kind === 'ports') { cur.syn = true; negate(cur, 'syn', flag); } break;
      case '--ctstate': case '--state': if (cur?.kind === 'conntrack') { cur.states = next().split(','); negate(cur, 'state', flag); } break;
      case '--ctorigdstport': if (cur?.kind === 'conntrack') { cur.origDstPort = next(); negate(cur, 'origDstPort', flag); } break;
      case '--ctorigsrcport': if (cur?.kind === 'conntrack') { cur.origSrcPort = next(); negate(cur, 'origSrcPort', flag); } break;
      case '--ctorigdst': if (cur?.kind === 'conntrack') { cur.origDst = next(); negate(cur, 'origDst', flag); } break;
      case '--ctorigsrc': if (cur?.kind === 'conntrack') { cur.origSrc = next(); negate(cur, 'origSrc', flag); } break;
      case '--ctdir': if (cur?.kind === 'conntrack') { cur.dir = next().toUpperCase(); negate(cur, 'dir', flag); } break;
      case '--icmp-type': case '--icmpv6-type': if (cur?.kind === 'icmp') { cur.type = next(); cur.neg = flag; } break;
      case '--dst-type': if (cur?.kind === 'addrtype') { cur.dst = next(); negate(cur, 'dst', flag); } break;
      case '--src-type': if (cur?.kind === 'addrtype') { cur.src = next(); negate(cur, 'src', flag); } break;
      case '--hl-eq': if (cur?.kind === 'hl') { cur.eq = Number(next()); cur.neg = flag; } break;
      case '--hl-lt': if (cur?.kind === 'hl') { cur.lt = Number(next()); cur.neg = flag; } break;
      case '--hl-gt': if (cur?.kind === 'hl') { cur.gt = Number(next()); cur.neg = flag; } break;
      case '--mark': if (cur?.kind === 'mark') { const m = toMask(next()); cur.value = m.value; cur.mask = m.mask; cur.neg = flag; } break;
      case '-j': case '-g': rule.target = next(); rule.goto = tok === '-g'; module = null; current = null; break;
      default:
        if (tok.startsWith('--')) {
          // arguments of a module we keep as "unsupported", or of a target (--reject-with, --log-prefix, --set-xmark, --to-destination ...)
          const value = t[i + 1] !== undefined && !t[i + 1].startsWith('-') ? next() : '';
          if (!module) rule.args[tok.slice(2)] = value;
          else if (cur && EVALUATED.has(cur.kind)) cannotEvaluate();
        }
    }
  }
  return rule;
}

/** The whole table. The input is the full output of `iptables -S` (or ip6tables), one rule per line. */
export function parseIptables(text: string): RuleTable {
  const table: RuleTable = { policies: {}, chains: {} };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('-P ')) { const [, chain, policy] = t.split(/\s+/); table.policies[chain] = policy; table.chains[chain] ??= []; continue; }
    if (t.startsWith('-N ')) { table.chains[t.slice(3).trim()] ??= []; continue; }
    const rule = parseRule(t);
    if (rule) (table.chains[rule.chain] ??= []).push(rule);
  }
  return table;
}

/**
 * The ports a Docker NAT rule publishes: `-A DOCKER ! -i br-x -p tcp -m tcp --dport 6333 -j DNAT --to-destination 172.18.0.2:6333`.
 * `hostAddr` is the address it was published on (`-p 127.0.0.1:8080:80` makes the rule carry `-d 127.0.0.1/32`); without it, every address of the host.
 * A published range (`--dport 8000:8010 ... --to-destination 172.18.0.2:8000-8010`) becomes one entry per port, up to MAX_PUBLISHED_RANGE; `truncated`
 * marks the entries of a longer range, which stops at that many.
 */
export interface Published {
  proto: 'tcp' | 'udp'; hostPort: number; containerIp: string; containerPort: number;
  hostAddr?: string; truncated?: boolean;
}

export const MAX_PUBLISHED_RANGE = 64;

export function parseDockerPublished(text: string): Published[] {
  const out: Published[] = [];
  for (const line of text.split('\n')) {
    const rule = parseRule(line);
    if (!rule || rule.target !== 'DNAT') continue;
    const ports = rule.matches.find((m): m is Extract<Match, { kind: 'ports' }> => m.kind === 'ports');
    const dest = /^(\[[0-9a-f:]+\]|[0-9.]+):(\d+)(?:-(\d+))?$/i.exec(rule.args['to-destination'] ?? '');
    const spec = /^(\d+)(?::(\d+))?$/.exec(ports?.dport ?? '');
    if (!ports || !dest || !spec) continue;
    const first = Number(spec[1]);
    const last = spec[2] ? Number(spec[2]) : first;
    const containerFirst = Number(dest[2]);
    if (last < first || first < 1 || last > 65535) continue;
    // A rule that does not apply to every destination address: `-d 127.0.0.1/32` is a publish on that one address. A negated `-d` is not a publish
    // on one address; it cannot be read, and is kept as "every address", which is the wider (safer to report) reading.
    const hostAddr = rule.dst && !rule.dst.neg ? rule.dst.cidr.replace(/\/(32|128)$/, '') : undefined;
    const count = Math.min(last - first + 1, MAX_PUBLISHED_RANGE);
    for (let i = 0; i < count; i++) {
      out.push({
        proto: ports.proto, hostPort: first + i, containerIp: dest[1].replace(/^\[|\]$/g, ''), containerPort: containerFirst + i,
        ...(hostAddr && !hostAddr.includes('/') ? { hostAddr } : {}),
        ...(last - first + 1 > MAX_PUBLISHED_RANGE ? { truncated: true } : {}),
      });
    }
  }
  return out;
}
