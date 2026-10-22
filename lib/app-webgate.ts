import type { AppRegistryEntry, GatewayService } from './types';

function normalizeUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}${url.search}`;
  } catch {
    return null;
  }
}

function explicitUrlPort(value?: string): number | null {
  if (!value) return null;
  try {
    const port = new URL(value).port;
    if (!port) return null;
    const parsed = Number(port);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null;
  } catch {
    return null;
  }
}

export function findWebGateService(
  app: AppRegistryEntry,
  services: GatewayService[],
): GatewayService | undefined {
  const appUrl = normalizeUrl(app.url);
  if (appUrl) {
    const exactUrlMatch = services.find(service => normalizeUrl(service.url) === appUrl);
    if (exactUrlMatch) return exactUrlMatch;
  }

  const candidatePorts = new Set<number>();
  const appPort = explicitUrlPort(app.url);
  if (appPort) candidatePorts.add(appPort);

  if (app.healthCheck?.type === 'port') {
    const port = Number(app.healthCheck.target);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) candidatePorts.add(port);
  } else if (app.healthCheck?.type === 'http') {
    const healthPort = explicitUrlPort(app.healthCheck.target);
    if (healthPort) candidatePorts.add(healthPort);
  }

  return services.find(service => candidatePorts.has(service.port));
}
