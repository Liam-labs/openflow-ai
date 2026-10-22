import { describe, expect, it } from 'vitest';
import { findWebGateService } from '../../lib/app-webgate';
import type { AppRegistryEntry, GatewayService } from '../../lib/types';

function app(overrides: Partial<AppRegistryEntry> = {}): AppRegistryEntry {
  return {
    id: 'app-1',
    name: 'Portal',
    description: '',
    icon: 'globe',
    iconType: 'lucide',
    color: '#3B82F6',
    category: 'development',
    tags: [],
    sortOrder: 0,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

function service(overrides: Partial<GatewayService> = {}): GatewayService {
  return {
    name: 'portal',
    port: 3187,
    subdomain: 'portal',
    url: 'https://portal.acmemedia.co.uk',
    locked: true,
    createdAt: '2026-07-27T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

describe('findWebGateService', () => {
  it('matches an app whose public URL is the WebGate URL', () => {
    expect(findWebGateService(
      app({ url: 'https://portal.acmemedia.co.uk/' }),
      [service()],
    )?.name).toBe('portal');
  });

  it('matches the app local URL port', () => {
    expect(findWebGateService(
      app({ url: 'http://localhost:3187' }),
      [service()],
    )?.url).toBe('https://portal.acmemedia.co.uk');
  });

  it('matches a port or HTTP health check when the launch URL is different', () => {
    expect(findWebGateService(
      app({ url: 'https://example.com', healthCheck: { type: 'port', target: '3187' } }),
      [service()],
    )?.name).toBe('portal');

    expect(findWebGateService(
      app({ url: 'https://example.com', healthCheck: { type: 'http', target: 'http://localhost:3187/health' } }),
      [service()],
    )?.name).toBe('portal');
  });

  it('does not confuse default public ports with a WebGate service', () => {
    expect(findWebGateService(
      app({ url: 'https://example.com' }),
      [service({ port: 443 })],
    )).toBeUndefined();
  });
});
