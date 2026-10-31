import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/api-auth';
import { installPeerStamp, resetPeerStampForTests, PEER_HEADER } from '@/lib/peer-stamp';

function req(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/', { headers });
}

describe('getClientIp with the server-stamped peer address', () => {
  afterEach(() => { resetPeerStampForTests(); delete process.env.WEBGATE_TUNNEL_SECRET; });

  it('ignores a forged X-Forwarded-For from a tailnet caller', () => {
    installPeerStamp();
    expect(getClientIp(req({ [PEER_HEADER]: '100.64.9.9', 'x-forwarded-for': '127.0.0.1' }))).toBe('100.64.9.9');
  });

  it('ignores a forged X-Real-IP from a LAN caller', () => {
    installPeerStamp();
    expect(getClientIp(req({ [PEER_HEADER]: '192.168.1.50', 'x-real-ip': '10.0.0.1' }))).toBe('192.168.1.50');
  });

  it('does not let one address name another as the attacker', () => {
    installPeerStamp();
    expect(getClientIp(req({ [PEER_HEADER]: '100.64.9.9', 'x-forwarded-for': '100.64.1.1' }))).not.toBe('100.64.1.1');
  });

  it('believes the forwarded address from the local tunnel proxy that proves itself with the tunnel secret', () => {
    installPeerStamp();
    process.env.WEBGATE_TUNNEL_SECRET = 'sekrit';
    expect(getClientIp(req({ [PEER_HEADER]: '127.0.0.1', 'x-tunnel-auth': 'sekrit', 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('does not believe a loopback caller that lacks the tunnel secret', () => {
    installPeerStamp();
    process.env.WEBGATE_TUNNEL_SECRET = 'sekrit';
    expect(getClientIp(req({ [PEER_HEADER]: '127.0.0.1', 'x-tunnel-auth': 'wrong', 'x-forwarded-for': '203.0.113.7' }))).toBe('127.0.0.1');
  });
});
