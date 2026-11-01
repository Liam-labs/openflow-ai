/** Public installer output only. Claim keys and setup codes never belong here. */
export interface InstalledAddress {
  url: string | null;
  state: 'claiming' | 'certificate' | 'ready' | 'failed';
  source: 'managed' | 'fallback';
  reason?: string;
}

export interface InstallAddressResult {
  serverMode: boolean;
  address: InstalledAddress | null;
}

/** Show only a browser origin supplied by the installer, never executable links. */
export function installedAddressUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}

export function parseInstallAddressResult(value: unknown): InstallAddressResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid installer result');
  const result = value as Record<string, unknown>;
  if (typeof result.serverMode !== 'boolean') throw new Error('Missing server mode');
  if (!result.serverMode || result.address === null) return { serverMode: result.serverMode, address: null };
  if (!result.address || typeof result.address !== 'object') throw new Error('Missing address');
  const address = result.address as Record<string, unknown>;
  if (!['claiming', 'certificate', 'ready', 'failed'].includes(String(address.state)) || !['managed', 'fallback'].includes(String(address.source))) throw new Error('Invalid address state');
  const url = address.url === null ? null : installedAddressUrl(address.url);
  if (address.url !== null && url === null) throw new Error('Invalid address URL');
  if (address.state === 'ready' && !url) throw new Error('Missing ready address');
  if (address.state === 'ready' && address.source === 'managed' && !url?.startsWith('https://')) throw new Error('Managed address is not secure');
  return { serverMode: true, address: { url, state: address.state as InstalledAddress['state'], source: address.source as InstalledAddress['source'], reason: typeof address.reason === 'string' ? address.reason : undefined } };
}
