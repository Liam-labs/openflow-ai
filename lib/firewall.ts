// Firewall overview: shapes returned by GET /api/system/firewall and the small helpers the panel uses.

export type Exposure = 'open' | 'unknown' | 'allowed' | 'local-only' | 'blocked';
export type Intended = 'desktop-only' | 'server-only' | 'this-machine' | 'nobody' | 'home-network' | 'tailnet' | 'public';
export type ControlState = 'ok' | 'warn' | 'off' | 'unknown';

export interface FirewallPort {
  port: number;
  proto: string;
  bind: string;
  service: string;
  process?: string;
  exposure: Exposure;
  allowedFrom?: string[];
  note?: string;
  /** The firewall's decision in words. */
  how?: string;
  /** False when nobody has named this port in the registry yet. */
  registered?: boolean;
  /** Who the port should be reachable by. */
  intended?: Intended | string;
  /** True when the firewall lets in more than `intended`. */
  drift?: boolean;
  /** Desktop only: which side of the PC the program runs on. */
  runsIn?: 'windows' | 'wsl' | string;
}

export interface FirewallControl {
  id: string;
  title: string;
  state: ControlState;
  summary?: string;
  how?: string;
  /** A command a person can run to see it themselves. */
  check?: string;
}

export interface FirewallRule {
  action: string;
  direction: string;
  ports?: string | number[] | string[];
  proto?: string;
  from?: string;
  interface?: string;
  comment?: string;
}

export interface FirewallMachine {
  id: string;
  label: string;
  reachable: boolean;
  reason?: string;
  firewall?: {
    tool?: string;
    enabled?: boolean;
    defaultIncoming?: string;
    defaultOutgoing?: string;
    error?: string;
  };
  ports: FirewallPort[];
  rules: FirewallRule[];
  controls: FirewallControl[];
  /** Sockets left out because they can't matter. */
  omitted?: { count: number; note?: string };
  /** Reading caveats for this machine's report. */
  notes?: string[];
}

export interface FirewallResponse {
  generatedAt?: string;
  machines: FirewallMachine[];
}

export const EXPOSURE_ORDER: Exposure[] = ['open', 'unknown', 'allowed', 'blocked', 'local-only'];

export const INTENDED_LABEL: Record<string, string> = {
  'desktop-only': 'Desktop only',
  'server-only': 'Remote server only',
  'this-machine': 'This machine only',
  nobody: 'Nobody',
  'home-network': 'Home network',
  tailnet: 'Any device on the tailnet',
  public: 'Anyone',
};

export const EXPOSURE_LABEL: Record<Exposure, string> = {
  open: 'Open to anyone',
  unknown: "Can't tell",
  allowed: 'Limited',
  blocked: 'Blocked',
  'local-only': 'This machine only',
};

export const EXPOSURE_HELP: Record<Exposure, string> = {
  open: 'Anyone who can reach this machine can connect.',
  unknown: "The checker met a firewall rule it can't read. Treat this port as exposed until it is checked.",
  allowed: 'Reachable, but only from the sources listed.',
  blocked: 'The service is running, but the firewall stops outside connections.',
  'local-only': 'Only programs on this machine can connect.',
};

export function parseFirewall(data: unknown): FirewallResponse | null {
  if (!data || typeof data !== 'object') return null;
  const machines = (data as { machines?: unknown }).machines;
  if (!Array.isArray(machines)) return null;
  const clean: FirewallMachine[] = [];
  for (const m of machines) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Partial<FirewallMachine>;
    if (typeof r.id !== 'string') continue;
    clean.push({
      id: r.id,
      label: typeof r.label === 'string' ? r.label : r.id,
      reachable: r.reachable !== false,
      reason: typeof r.reason === 'string' ? r.reason : undefined,
      firewall: r.firewall && typeof r.firewall === 'object' ? r.firewall : undefined,
      ports: Array.isArray(r.ports) ? r.ports.filter(p => p && typeof p.port === 'number' && p.exposure in EXPOSURE_LABEL) : [],
      rules: Array.isArray(r.rules) ? r.rules : [],
      omitted: r.omitted && typeof r.omitted === 'object' && typeof r.omitted.count === 'number' ? r.omitted : undefined,
      notes: Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === 'string' && !!n.trim()) : undefined,
      controls: Array.isArray(r.controls) ? r.controls.filter(c => c && typeof c.id === 'string' && typeof c.title === 'string') : [],
    });
  }
  const generatedAt = (data as { generatedAt?: unknown }).generatedAt;
  return { generatedAt: typeof generatedAt === 'string' ? generatedAt : undefined, machines: clean };
}

/** Open only because Tailscale lets every device on the tailnet in: reachable by your own devices, not by the internet. */
export function isTailnetOnly(p: FirewallPort): boolean {
  return p.exposure === 'open' && !p.drift && p.allowedFrom?.length === 1 && /tailnet/i.test(p.allowedFrom[0]);
}

export function countByExposure(ports: FirewallPort[]): Record<Exposure | 'tailnet', number> {
  const out: Record<Exposure | 'tailnet', number> = { open: 0, tailnet: 0, unknown: 0, allowed: 0, blocked: 0, 'local-only': 0 };
  for (const p of ports) {
    if (isTailnetOnly(p)) out.tailnet += 1; else out[p.exposure] += 1;
  }
  return out;
}

/** How worrying a port is: lower is worse. Open to the network, then drift, can't tell, tailnet-wide, limited, blocked, local. */
function rank(p: FirewallPort): number {
  if (p.drift) return 0;
  if (isTailnetOnly(p)) return 3;
  return { open: 1, unknown: 2, allowed: 4, blocked: 5, 'local-only': 6 }[p.exposure];
}

/** Most exposed first, then by port, so anything open is at the top. */
export function sortPorts(ports: FirewallPort[]): FirewallPort[] {
  return [...ports].sort((a, b) => rank(a) - rank(b) || a.port - b.port || a.proto.localeCompare(b.proto));
}

/** A listening address in plain words. The server may already send words ("all addresses"); those are only capitalised. */
export function describeBind(bind: string): string {
  if (bind === '0.0.0.0' || bind === '::' || bind === '*') return 'All addresses';
  if (bind === '127.0.0.1' || bind === '::1' || bind.startsWith('127.')) return 'This machine only';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(bind)) return `Tailscale (${bind})`;
  // Only a plain leading word is capitalised ('all addresses'); an address such as fe80::1 is left exactly as it is.
  return /^[a-z]{3,}( |$)/.test(bind) ? bind.charAt(0).toUpperCase() + bind.slice(1) : bind;
}

/** Open, can't-tell, or allowing more than intended: the ports a person should look at. */
export function needsAttention(p: FirewallPort): boolean {
  return (p.exposure === 'open' && !isTailnetOnly(p)) || p.exposure === 'unknown' || p.drift === true;
}

/** Which list to show first: a long list (the desktop) starts on what needs attention, then on what is reachable. */
export function defaultFilter(ports: FirewallPort[]): 'all' | 'attention' | 'allowed' {
  if (ports.length <= 60) return 'all';
  return ports.some(needsAttention) ? 'attention' : 'allowed';
}

export function ruleSummary(r: FirewallRule): string {
  const ports = Array.isArray(r.ports) ? r.ports.join(', ') : r.ports ?? 'any port';
  const proto = r.proto ? `/${r.proto}` : '';
  const via = r.interface ? ` on ${r.interface}` : '';
  const from = r.from ? ` from ${r.from}` : ' from anywhere';
  return `${r.action.toUpperCase()} ${r.direction} ${ports}${proto}${via}${from}`;
}

export function firewallHeadline(m: FirewallMachine): { text: string; ok: boolean } {
  if (!m.reachable) return { text: m.reason || 'Not checked yet', ok: false };
  const fw = m.firewall;
  if (!fw) return { text: 'No firewall details', ok: false };
  if (fw.error) return { text: fw.error, ok: false };
  if (fw.enabled === false) return { text: 'Firewall is off', ok: false };
  const incoming = fw.defaultIncoming ? `new incoming connections: ${fw.defaultIncoming}` : '';
  const tool = fw.tool === 'windows-firewall' ? 'Windows Firewall' : fw.tool;
  return { text: [tool ? `${tool} on` : 'Firewall on', incoming].filter(Boolean).join(' · '), ok: fw.defaultIncoming !== 'allow' };
}
