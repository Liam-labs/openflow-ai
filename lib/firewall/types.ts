/** The shape `GET /api/system/firewall` returns. an agent's panel reads it; the contract is in the channel (18 Oct 2026). */

/**
 * local-only: only that machine can reach it. allowed: reachable, but only from the listed sources. blocked: listening, but the firewall stops it.
 * open: anyone who can reach the machine. unknown: could not be worked out (a rule we do not understand); treat as a warning.
 */
export type Exposure = 'local-only' | 'allowed' | 'blocked' | 'open' | 'unknown';

export interface FirewallPort {
  port: number;
  proto: 'tcp' | 'udp';
  /** What it listens on, in words and addresses: "all addresses", "127.0.0.1", "<tailnet-ip> (Tailscale)". */
  bind: string;
  /** The registry name when it has one, otherwise the program's own name. */
  service: string;
  process: string;
  exposure: Exposure;
  /** Plain-English sources that get in: "the desktop over Tailscale", "Any device on your tailnet". Empty when nothing does. */
  allowedFrom: string[];
  /** Registry purpose, plus a warning when reality differs from what the registry says it should be. */
  note: string;
  /** Who decided, in words: "ufw allow rule; everything else hits the default deny". */
  how: string;
  /** True when the port registry names it. An unregistered port that is reachable from outside deserves a look. */
  registered: boolean;
  intended?: string;
  /** True when the registry says how exposed it should be and reality is wider. */
  drift?: boolean;
  /** On the desktop, which network stack the program is on: Windows itself, or the Linux (WSL) inside it. */
  runsIn?: 'windows' | 'wsl';
}

export interface FirewallRuleRow {
  action: string;
  direction: string;
  ports: string;
  proto: string;
  from: string;
  interface: string;
  comment: string;
}

export interface FirewallControl {
  id: string;
  title: string;
  state: 'ok' | 'warn' | 'off' | 'unknown';
  summary: string;
  /** How it is enforced, in words. */
  how: string;
  /** A command a person can run to see it for themselves. */
  check: string;
}

export interface MachineReport {
  id: 'server' | 'desktop';
  label: string;
  reachable: boolean;
  /** Why it could not be checked, when reachable is false. */
  reason?: string;
  firewall: { tool: 'ufw' | 'windows-firewall'; enabled: boolean; defaultIncoming: string; defaultOutgoing: string; error?: string };
  ports: FirewallPort[];
  rules: FirewallRuleRow[];
  controls: FirewallControl[];
  /** Listening sockets left out of `ports` because they cannot matter: a count and a sentence saying which kind. */
  omitted?: { count: number; note: string };
  /** Caveats about how to read this machine's report, in plain words. */
  notes?: string[];
}

export interface PublicHostname {
  hostname: string;
  /** Where the tunnel sends it, e.g. "desktop port 3187". */
  target: string;
  /** access-login: Cloudflare Access in front. app-login: the app's own sign-in. open: answers to anyone. api: a service gateway (404 at the root). down: nothing behind it. unknown. */
  protection: 'access-login' | 'app-login' | 'open' | 'api' | 'down' | 'unknown';
  detail: string;
}

export interface FirewallReport {
  generatedAt: string;
  machines: MachineReport[];
  publicHostnames?: PublicHostname[];
}
