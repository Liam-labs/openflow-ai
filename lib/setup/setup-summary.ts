/**
 * "What is set up" for the Setup channel's status strip and for the Guide agent.
 *
 * Read-only and secret-free: each line is a yes/no/not-now and a short plain label. It reads the same records the wizards write, so the
 * strip, the Guide and the wizard cards cannot disagree. Nothing here names a host, an account, a key or an address.
 */

export type SetupState = 'on' | 'off' | 'skipped';

export interface SetupItem {
  id: 'password' | 'phone-access' | 'own-domain' | 'browser' | 'memory';
  label: string;
  state: SetupState;
  /** Where the user turns it on: the card inside Systems > Connections. */
  where: string;
}

export interface SummarySources {
  passwordSet: () => Promise<boolean>;
  remoteAccess: () => Promise<{ enabled?: boolean }>;
  cloudflare: () => Promise<{ enabled?: boolean }>;
  browser: () => Promise<{ enabled?: boolean }>;
  memory: () => Promise<{ enabled?: boolean; skipped?: boolean }>;
}

const WHERE = 'Systems > Connections > Set up more';

async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try { return await read(); } catch { return fallback; }
}

export async function buildSetupSummary(src: SummarySources): Promise<SetupItem[]> {
  const [password, remote, cloudflare, browser, memory] = await Promise.all([
    safe(src.passwordSet, false),
    safe(src.remoteAccess, {}),
    safe(src.cloudflare, {}),
    safe(src.browser, {}),
    safe(src.memory, {} as { enabled?: boolean; skipped?: boolean }),
  ]);
  return [
    { id: 'password', label: 'Owner password', state: password ? 'on' : 'off', where: WHERE },
    { id: 'phone-access', label: 'Open it from your phone', state: remote.enabled ? 'on' : 'off', where: WHERE },
    { id: 'own-domain', label: 'Your own domain', state: cloudflare.enabled ? 'on' : 'off', where: WHERE },
    { id: 'browser', label: 'A browser for your agents', state: browser.enabled ? 'on' : 'off', where: WHERE },
    { id: 'memory', label: 'Shared memory', state: memory.enabled ? 'on' : memory.skipped ? 'skipped' : 'off', where: WHERE },
  ];
}
