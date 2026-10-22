/**
 * Asks the desktop PC's helper (agent-hostd, which dials out to DevFlow) for the facts about its firewall and listening ports. DevFlow has no route
 * into the PC; the helper answers an allow-listed, read-only "firewall-facts" request and nothing else is run (platform/granting-access.md).
 */
import { defaultHost, hostCall, hostState } from '../host-executor';
import type { WslFacts } from './desktop-model';

export interface DesktopCollection { windows: unknown; wsl: WslFacts }

type Call = <T>(host: string, op: string, args: Record<string, unknown>, waitMs?: number) => Promise<T>;

export async function collectDesktop(
  host: string | null = defaultHost(),
  call: Call = hostCall,
  state: (host: string | null) => 'online' | 'offline' | 'local' = hostState,
): Promise<DesktopCollection> {
  if (!host) throw new Error('No desktop helper is set up on this server (DEVFLOW_AGENT_HOST is empty), so the PC cannot be checked.');
  if (state(host) === 'offline') throw new Error('The desktop helper is not connected right now, so the PC cannot be checked.');
  let result: { windows?: unknown; wsl?: { ss?: unknown; ipAddr?: unknown } };
  try {
    result = await call(host, 'firewall-facts', {}, 25000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/did not answer/.test(message)) throw new Error('The desktop helper did not answer in time.');
    if (/unknown op|not allowed|unsupported/i.test(message)) throw new Error('The desktop helper is an older version that cannot do this check yet; restart devflow-hostd on the PC.');
    throw new Error(`The desktop helper could not read the firewall: ${message}`.slice(0, 300));
  }
  if (!result || typeof result !== 'object' || !result.windows) throw new Error('The desktop helper sent an empty answer.');
  return { windows: result.windows, wsl: { ss: typeof result.wsl?.ss === 'string' ? result.wsl.ss : '', ipAddr: typeof result.wsl?.ipAddr === 'string' ? result.wsl.ipAddr : '' } };
}
