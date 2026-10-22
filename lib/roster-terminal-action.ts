import { PRODUCT_NAME } from '@/lib/brand';
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

function responseError(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim()) return error;
  }
  return null;
}

/** Request a roster terminal and surface a server or transport failure via toast. */
export async function requestRosterTerminal(
  fetcher: Fetcher,
  channelId: string,
  agentId: string,
  showError: (message: string) => void,
): Promise<boolean> {
  try {
    const response = await fetcher('/api/collab/pty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'roster_open_terminal', channelId, agentId }),
    });
    const payload = await response.json().catch(() => null);
    const success = payload && typeof payload === 'object' && 'success' in payload && payload.success === true;
    if (!response.ok || !success) {
      showError(responseError(payload) || 'Unable to open this agent terminal');
      return false;
    }
    return true;
  } catch {
    showError(`Unable to reach ${PRODUCT_NAME} to open this agent terminal`);
    return false;
  }
}
