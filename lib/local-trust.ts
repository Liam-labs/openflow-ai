/**
 * Is this request from a person using DevFlow on this machine, or from a web page trying to use their machine?
 *
 * DevFlow lets requests that come from the machine itself skip the access token (the dashboard needs that). A browser
 * is also "this machine", so any web page the owner visits could send requests to http://localhost:3000, and a page on an
 * attacker's domain can be made to point at 127.0.0.1 (DNS rebinding). Two browser facts expose both:
 *   - the Host header names the address the request was sent to. After a rebinding it is still the attacker's name.
 *   - cross-origin browser requests carry an Origin header (and Sec-Fetch-Site) that name the page that sent them.
 * Command-line tools and scripts send neither, so they are unaffected.
 *
 * Settings (environment):
 *   DEVFLOW_ORIGIN_CHECK     enforce (default) | report (log what would be refused, refuse nothing) | off
 *   DEVFLOW_ALLOWED_HOSTS    extra host names that may be used to reach this server, comma separated; "*.example.net" allowed
 *   DEVFLOW_ALLOWED_ORIGINS  extra origins (https://host[:port]) whose pages may call the API as a local user
 * Always fine: localhost, any IP address, this machine's own host name.
 *
 * Pure and import-safe: no Node-only modules, so it can be unit tested and used from anywhere.
 */

export type OriginCheckMode = 'enforce' | 'report' | 'off';

export interface RequestFacts {
  /** The Host header, or the host of the request URL when there is none. */
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  /** Only for the report-mode log: which API route was asked. */
  path?: string | null;
}

export interface Verdict {
  ok: boolean;
  reason?: string;
}

type Env = Record<string, string | undefined>;

export function originCheckMode(env: Env = process.env): OriginCheckMode {
  const value = (env.DEVFLOW_ORIGIN_CHECK || '').trim().toLowerCase();
  return value === 'report' || value === 'off' ? value : 'enforce';
}

/**
 * Is the server set to listen on this machine only? DEVFLOW_BIND_HOST unset, or a loopback address, means yes.
 * Anything else (0.0.0.0, a LAN address) means other computers can reach it, and an "x-forwarded-for: 127.0.0.1" header is
 * something any caller can send, so a server set up like that must not trust a request just because it claims to be local.
 */
export function listensOnLoopbackOnly(env: Env = process.env): boolean {
  const host = (env.DEVFLOW_BIND_HOST || '').trim().toLowerCase();
  return host === '' || host === 'localhost' || host === '::1' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** "Example.COM:3000" -> {name: "example.com", port: "3000"}; "[::1]:3000" -> {name: "::1", port: "3000"}. */
export function splitHost(value: string | null | undefined): { name: string; port: string } | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (!text || /[\s/@\\]/.test(text)) return null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) return { name: bracketed[1], port: bracketed[2] || '' };
  const plain = /^([^:]+)(?::(\d+))?$/.exec(text);
  if (plain) return { name: plain[1], port: plain[2] || '' };
  return /^[0-9a-f:.]+$/.test(text) ? { name: text, port: '' } : null;      // a bare IPv6 address
}

function isIpAddress(name: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || (name.includes(':') && /^[0-9a-f:.]+$/.test(name));
}

function list(value: string | undefined): string[] {
  return (value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function hostnameAllowed(name: string, env: Env, machineName: string): boolean {
  if (name === 'localhost' || name.endsWith('.localhost') || isIpAddress(name)) return true;
  const own = machineName.trim().toLowerCase();
  if (own && (name === own || name === own + '.local')) return true;
  return list(env.DEVFLOW_ALLOWED_HOSTS).some((entry) => (entry.startsWith('*.') ? name.endsWith(entry.slice(1)) : name === entry));
}

export function verdictFor(facts: RequestFacts, env: Env = process.env, machineName = ''): Verdict {
  const host = splitHost(facts.host);
  if (!host) return { ok: false, reason: 'no usable Host header' };
  if (!hostnameAllowed(host.name, env, machineName)) return { ok: false, reason: 'the request was sent to a name this server does not recognise (' + host.name + ')' };
  const site = (facts.secFetchSite || '').toLowerCase();
  if (site === 'cross-site') return { ok: false, reason: 'a browser marked the request cross-site' };
  // A plain <img>/<script> request carries no Origin. From a page on another port of this machine the browser says "same-site"
  // (ports do not count), so only same-origin, a typed address ("none") or no header at all (command-line tools) is the owner.
  if (site === 'same-site' && !facts.origin) return { ok: false, reason: 'a browser marked the request as coming from a page on another port or subdomain' };
  if (facts.origin) {
    if (facts.origin.trim().toLowerCase() === 'null') return { ok: false, reason: 'the page that sent it has no origin (sandboxed or local file)' };
    let origin: URL;
    try {
      origin = new URL(facts.origin);
    } catch {
      return { ok: false, reason: 'unreadable Origin header' };
    }
    const sameOrigin = origin.host.toLowerCase() === (facts.host || '').trim().toLowerCase();
    const allowedOrigin = list(env.DEVFLOW_ALLOWED_ORIGINS).includes(origin.origin.toLowerCase());
    if (!sameOrigin && !allowedOrigin) return { ok: false, reason: 'the page that sent it (' + origin.host + ') is a different origin' };
  }
  return { ok: true };
}

const reported = new Map<string, number>();

/** Header text for a log line: printable ASCII only, cut short. */
function clean(value: string | null | undefined): string {
  return (value || '-').replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
}

/** Report mode logs the first request of each kind and then the 10th, 100th, ... so a flood cannot hide what it is and a repeat is still counted. */
function reportKey(facts: RequestFacts, reason: string): string {
  let origin = '-';
  try {
    origin = facts.origin ? new URL(facts.origin).host : '-';
  } catch {
    origin = 'unreadable';
  }
  return clean(reason) + ' [host=' + clean(facts.host) + ' origin=' + clean(origin) + ' site=' + clean(facts.secFetchSite) + ' path=' + clean(facts.path) + ']';
}

const OTHER_KINDS = 'more kinds of refused request than are tracked individually';

/** Apply the mode: true when this request may count as a local user. In report mode a refusal is logged and still allowed. */
export function allowLocalTrust(facts: RequestFacts, env: Env = process.env, machineName = '', log: (line: string) => void = console.warn): boolean {
  const mode = originCheckMode(env);
  if (mode === 'off') return true;
  const verdict = verdictFor(facts, env, machineName);
  if (verdict.ok) return true;
  if (mode === 'report') {
    let key = reportKey(facts, verdict.reason || '');
    if (!reported.has(key) && reported.size >= 200) key = OTHER_KINDS;     // past the limit new kinds share one counter instead of vanishing
    const seen = (reported.get(key) || 0) + 1;
    reported.set(key, seen);
    if (/^10*$/.test(String(seen))) log('[local-trust] would refuse local trust: ' + key + ' x' + seen + ' (DEVFLOW_ORIGIN_CHECK=report, nothing refused)');
    return true;
  }
  return false;
}

export function resetReportedForTests(): void {
  reported.clear();
}
