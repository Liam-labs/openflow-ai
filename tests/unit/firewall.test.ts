import { describe, it, expect } from 'vitest';
import { isTailnetOnly, parseFirewall, countByExposure, sortPorts, describeBind, ruleSummary, firewallHeadline, needsAttention, defaultFilter } from '@/lib/firewall';

const port = (p: number, exposure: string) => ({ port: p, proto: 'tcp', bind: '0.0.0.0', service: 's', exposure });

describe('firewall helpers', () => {
  it('rejects data without machines', () => {
    expect(parseFirewall(null)).toBeNull();
    expect(parseFirewall({})).toBeNull();
  });

  it('drops ports with an unknown exposure value', () => {
    const r = parseFirewall({ machines: [{ id: 'server', ports: [port(22, 'allowed'), port(1, 'weird')] }] });
    expect(r?.machines[0].ports.map(p => p.port)).toEqual([22]);
    expect(r?.machines[0].reachable).toBe(true);
  });

  it('counts and sorts the most exposed first', () => {
    const r = parseFirewall({ machines: [{ id: 'server', ports: [port(5, 'local-only'), port(9, 'open'), port(3, 'allowed')] }] })!;
    expect(sortPorts(r.machines[0].ports).map(p => p.port)).toEqual([9, 3, 5]);
    expect(countByExposure(r.machines[0].ports)).toEqual({ open: 1, tailnet: 0, unknown: 0, allowed: 1, blocked: 0, 'local-only': 1 });
  });

  it('describes listening addresses in plain words', () => {
    expect(describeBind('0.0.0.0')).toBe('All addresses');
    expect(describeBind('127.0.0.53')).toBe('This machine only');
    expect(describeBind('100.64.20.21')).toBe('Tailscale (100.64.20.21)');
    expect(describeBind('192.168.1.5')).toBe('192.168.1.5');
    expect(describeBind('all addresses')).toBe('All addresses');
    expect(describeBind('fe80::3ee9:f7ff (Wi-Fi)')).toBe('fe80::3ee9:f7ff (Wi-Fi)');
    expect(describeBind('192.168.1.60 (Wi-Fi)')).toBe('192.168.1.60 (Wi-Fi)');
  });

  it('summarises a rule', () => {
    expect(ruleSummary({ action: 'allow', direction: 'in', ports: [22, 3000], proto: 'tcp', interface: 'tailscale0', from: '100.64.20.20' }))
      .toBe('ALLOW in 22, 3000/tcp on tailscale0 from 100.64.20.20');
  });

  it('flags an unreachable machine, a disabled firewall and default-allow', () => {
    expect(firewallHeadline({ id: 'd', label: 'D', reachable: false, reason: 'Offline', ports: [], rules: [] })).toEqual({ text: 'Offline', ok: false });
    expect(firewallHeadline({ id: 's', label: 'S', reachable: true, firewall: { enabled: false }, ports: [], rules: [] }).ok).toBe(false);
    expect(firewallHeadline({ id: 's', label: 'S', reachable: true, firewall: { tool: 'ufw', enabled: true, defaultIncoming: 'deny' }, ports: [], rules: [] }))
      .toEqual({ text: 'ufw on · new incoming connections: deny', ok: true });
    expect(firewallHeadline({ id: 's', label: 'S', reachable: true, firewall: { enabled: true, defaultIncoming: 'allow' }, ports: [], rules: [] }).ok).toBe(false);
  });

  it('treats unknown exposure and drift as needing attention', () => {
    expect(needsAttention({ port: 1, proto: 'tcp', bind: 'x', service: 's', exposure: 'unknown' })).toBe(true);
    expect(needsAttention({ port: 1, proto: 'tcp', bind: 'x', service: 's', exposure: 'allowed', drift: true })).toBe(true);
    expect(needsAttention({ port: 1, proto: 'tcp', bind: 'x', service: 's', exposure: 'allowed' })).toBe(false);
  });

  it('keeps controls and picks a default filter for long lists', () => {
    const r = parseFirewall({ machines: [{ id: 'server', controls: [{ id: 'a', title: 'A', state: 'ok' }, { nope: 1 }], ports: [] }] })!;
    expect(r.machines[0].controls).toHaveLength(1);
    const many = Array.from({ length: 70 }, (_, i) => ({ port: i + 1, proto: 'tcp', bind: 'x', service: 's', exposure: 'local-only' as const }));
    expect(defaultFilter(many.slice(0, 10))).toBe('all');
    expect(defaultFilter(many)).toBe('allowed');
    expect(defaultFilter([...many, { port: 999, proto: 'tcp', bind: 'x', service: 's', exposure: 'open' as const }])).toBe('attention');
  });

  it('separates ports open only because of Tailscale from ports open to the network', () => {
    const tail = { port: 1, proto: 'tcp', bind: 'x', service: 's', exposure: 'open' as const, allowedFrom: ['Any device on your tailnet'] };
    const wide = { port: 2, proto: 'tcp', bind: 'x', service: 's', exposure: 'open' as const, allowedFrom: ['Any device on your tailnet', 'Anyone on the internet'] };
    const drift = { ...tail, port: 3, drift: true };
    expect(isTailnetOnly(tail)).toBe(true);
    expect(isTailnetOnly(wide)).toBe(false);
    expect(isTailnetOnly(drift)).toBe(false);
    expect(needsAttention(tail)).toBe(false);
    expect(needsAttention(wide)).toBe(true);
    expect(countByExposure([tail, wide, drift])).toMatchObject({ open: 2, tailnet: 1 });
    expect(sortPorts([tail, wide, drift]).map(p => p.port)).toEqual([3, 2, 1]);
  });

  it('keeps the omitted note and reading notes, and names the Windows firewall', () => {
    const r = parseFirewall({ machines: [{ id: 'desktop', omitted: { count: 251, note: 'Left out' }, notes: ['a', '', 5], ports: [] }] })!;
    expect(r.machines[0].omitted).toEqual({ count: 251, note: 'Left out' });
    expect(r.machines[0].notes).toEqual(['a']);
    expect(firewallHeadline({ id: 'd', label: 'D', reachable: true, firewall: { tool: 'windows-firewall', enabled: true, defaultIncoming: 'deny' }, ports: [], rules: [], controls: [] }).text)
      .toBe('Windows Firewall on · new incoming connections: deny');
  });
});
