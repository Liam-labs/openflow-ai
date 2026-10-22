/** Address maths for the firewall evaluator: IPv4 and IPv6 as BigInt, CIDR membership, interface-name patterns. No dependencies. */

export type Family = 4 | 6;

export interface ParsedAddress { family: Family; value: bigint }

// BigInt() calls, not literals: the project compiles for ES2017, which rejects `0n`.
const ZERO = BigInt(0), ONE = BigInt(1), EIGHT = BigInt(8), SIXTEEN = BigInt(16), MASK16 = BigInt(0xffff);

function parseV4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let out = ZERO;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << EIGHT) | BigInt(n);
  }
  return out;
}

function parseV6(text: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;
  const doubles = text.split('::');
  if (doubles.length > 2) return null;
  const groups = (part: string): string[] | null => (part === '' ? [] : part.split(':'));
  const head = groups(doubles[0]);
  const tail = doubles.length === 2 ? groups(doubles[1]) : [];
  if (!head || !tail) return null;
  const expand = (list: string[]): number[] | null => {
    const out: number[] = [];
    for (const g of list) {
      if (g.includes('.')) {
        const v4 = parseV4(g);
        if (v4 === null) return null;
        out.push(Number(v4 >> SIXTEEN), Number(v4 & MASK16));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const h = expand(head);
  const t = expand(tail);
  if (!h || !t) return null;
  const missing = 8 - h.length - t.length;
  if (doubles.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...h, ...Array(doubles.length === 2 ? missing : 0).fill(0), ...t];
  if (all.length !== 8) return null;
  return all.reduce<bigint>((acc, g) => (acc << SIXTEEN) | BigInt(g), ZERO);
}

/** Parses an address; a trailing `%interface` zone (as `ss` prints) is ignored. */
export function parseAddress(raw: string): ParsedAddress | null {
  const text = raw.split('%')[0].trim();
  if (text.includes(':')) {
    const v = parseV6(text);
    return v === null ? null : { family: 6, value: v };
  }
  const v = parseV4(text);
  return v === null ? null : { family: 4, value: v };
}

export interface Cidr { family: Family; value: bigint; bits: number }

/** "10.0.0.0/8", "fd7a::/48" or a bare address (a host). */
export function parseCidr(raw: string): Cidr | null {
  const [addr, len] = raw.split('/');
  const a = parseAddress(addr);
  if (!a) return null;
  const max = a.family === 4 ? 32 : 128;
  const bits = len === undefined ? max : /^\d+$/.test(len) ? Number(len) : -1;
  if (bits < 0 || bits > max) return null;
  return { family: a.family, value: a.value, bits };
}

export function inCidr(address: string, cidr: string): boolean {
  const a = parseAddress(address);
  const c = parseCidr(cidr);
  if (!a || !c || a.family !== c.family) return false;
  const max = a.family === 4 ? 32 : 128;
  const shift = BigInt(max - c.bits);
  return (a.value >> shift) === (c.value >> shift);
}

/** The family an address literal belongs to, or null when it is not an address. */
export function familyOf(address: string): Family | null {
  return parseAddress(address)?.family ?? null;
}

export function isLoopback(address: string): boolean {
  const a = parseAddress(address);
  if (!a) return false;
  return a.family === 4 ? inCidr(address, '127.0.0.0/8') : a.value === ONE;
}

export function isWildcard(address: string): boolean {
  const a = parseAddress(address);
  return !!a && a.value === ZERO;
}

/** True when two address literals are the same address (so "fe80::1" and "fe80:0:0:0:0:0:0:1" match). */
export function sameAddress(a: string, b: string): boolean {
  const x = parseAddress(a);
  const y = parseAddress(b);
  return !!x && !!y && x.family === y.family && x.value === y.value;
}

/** The text form of an address value; IPv6 is written in full, without "::" compression, which is still a valid literal. */
export function formatAddress(family: Family, value: bigint): string {
  if (family === 4) return [24, 16, 8, 0].map(shift => String(Number((value >> BigInt(shift)) & BigInt(255)))).join('.');
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & MASK16).toString(16));
  return groups.join(':');
}

/** iptables interface patterns: an exact name, or a prefix ending in "+". */
export function ifaceMatches(pattern: string, name: string): boolean {
  return pattern.endsWith('+') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}
