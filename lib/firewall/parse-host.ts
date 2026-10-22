/** Parsers for the two plain-text views of a Linux host: `ufw status verbose` and `ss -H -ltnup`. */
import { parseAddress } from './net';

// ── ufw ──────────────────────────────────────────────────────────────────────

export interface UfwRule {
  action: 'allow' | 'deny' | 'reject' | 'limit';
  direction: 'in' | 'out' | 'fwd';
  /** "22,3000/tcp" is {ports: '22,3000', proto: 'tcp'}; "Anywhere" is {ports: 'any', proto: 'any'}. An app profile name stays as written. */
  ports: string;
  proto: 'tcp' | 'udp' | 'any';
  from: string;
  interface: string;
  comment: string;
  v6: boolean;
}

export interface UfwStatus {
  enabled: boolean;
  logging: string;
  defaultIncoming: string;
  defaultOutgoing: string;
  defaultRouted: string;
  rules: UfwRule[];
}

// Groups: 1 to, 2 action, 3 direction, 4 from, 5 comment (numbered, not named: the project compiles for ES2017).
const UFW_ROW = /^(.+?)\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT|FWD))?\s+(\S.*?)(?:\s+#\s*(.*))?$/;

export function parseUfwStatus(text: string): UfwStatus {
  const out: UfwStatus = { enabled: false, logging: '', defaultIncoming: 'unknown', defaultOutgoing: 'unknown', defaultRouted: 'unknown', rules: [] };
  let inRules = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const status = /^Status:\s*(\w+)/.exec(line);
    if (status) { out.enabled = status[1].toLowerCase() === 'active'; continue; }
    const logging = /^Logging:\s*(.*)$/.exec(line);
    if (logging) { out.logging = logging[1]; continue; }
    const defaults = /^Default:\s*(.*)$/.exec(line);
    if (defaults) {
      for (const part of defaults[1].split(',')) {
        const m = /(allow|deny|reject)\s*\((incoming|outgoing|routed)\)/i.exec(part);
        if (!m) continue;
        const key = m[2].toLowerCase() === 'incoming' ? 'defaultIncoming' : m[2].toLowerCase() === 'outgoing' ? 'defaultOutgoing' : 'defaultRouted';
        out[key] = m[1].toLowerCase();
      }
      continue;
    }
    if (/^--\s+------/.test(line)) { inRules = true; continue; }
    if (!inRules) continue;
    const m = UFW_ROW.exec(line);
    if (!m) continue;
    let to = m[1].trim();
    const v6 = / \(v6\)$/.test(to) || / \(v6\)$/.test(m[4]);
    to = to.replace(/ \(v6\)$/, '');
    const on = / on (\S+)$/.exec(to);
    const iface = on ? on[1] : 'any';
    if (on) to = to.slice(0, on.index);
    const portSpec = /^([\d,:]+)(?:\/(tcp|udp))?$/.exec(to);
    const rule: UfwRule = {
      action: m[2].toLowerCase() as UfwRule['action'],
      direction: (m[3] ?? 'IN').toLowerCase() as UfwRule['direction'],
      ports: portSpec ? portSpec[1] : /^Anywhere$/i.test(to) ? 'any' : to,
      proto: portSpec?.[2] ? (portSpec[2] as 'tcp' | 'udp') : 'any',
      from: m[4].replace(/ \(v6\)$/, '').trim(),
      interface: iface,
      comment: (m[5] ?? '').trim(),
      v6,
    };
    out.rules.push(rule);
  }
  return out;
}

// ── ss ───────────────────────────────────────────────────────────────────────

export interface Listener {
  proto: 'tcp' | 'udp';
  /** The address as written, without brackets or interface zone: "0.0.0.0", "::", "127.0.0.1", "*" (both families), "<tailnet-ip>". */
  bind: string;
  zone?: string;
  port: number;
  /** Name of the first process listed, and every name listed. */
  process: string;
  processes: string[];
  pids: number[];
}

const PROC = /\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g;

/** Splits `addr:port` where addr may be `[v6]`, `*`, or carry a `%zone`. */
export function splitAddressPort(text: string): { bind: string; zone?: string; port: number } | null {
  const i = text.lastIndexOf(':');
  if (i < 0) return null;
  const port = Number(text.slice(i + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  let host = text.slice(0, i);
  let zone: string | undefined;
  const bracketed = /^\[(.+)\](?:%(.+))?$/.exec(host);        // [fe80::1]%wlan0 (zone outside the brackets) or [::]
  if (bracketed) { host = bracketed[1]; zone = bracketed[2]; }
  const pct = host.indexOf('%');                                  // 127.0.0.53%lo
  if (pct >= 0) { zone = host.slice(pct + 1); host = host.slice(0, pct); }
  if (host !== '*' && !parseAddress(host)) return null;
  return { bind: host, ...(zone ? { zone } : {}), port };
}

export function parseSs(text: string): Listener[] {
  const out: Listener[] = [];
  for (const raw of text.split('\n')) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0] === 'tcp' ? 'tcp' : cols[0] === 'udp' ? 'udp' : null;
    if (!proto) continue;
    const listening = (proto === 'tcp' && cols[1] === 'LISTEN') || (proto === 'udp' && cols[1] === 'UNCONN');
    if (!listening) continue;
    const at = splitAddressPort(cols[4]);
    if (!at) continue;
    const processes: string[] = [];
    const pids: number[] = [];
    for (const m of raw.matchAll(PROC)) { processes.push(m[1]); pids.push(Number(m[2])); }
    out.push({ proto, ...at, process: processes[0] ?? '', processes, pids });
  }
  return out;
}
