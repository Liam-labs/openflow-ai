import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/host-registry', () => ({ enqueue: vi.fn(), getHostInfo: () => null, hostIds: () => [] }));

import { openTerminalRoute } from '@/lib/open-terminal-route';

const DESKTOP = 'desktop';
const setHost = (value: string | undefined) => { if (value === undefined) delete process.env.DEVFLOW_AGENT_HOST; else process.env.DEVFLOW_AGENT_HOST = value; };

beforeEach(() => setHost(DESKTOP));
afterEach(() => setHost(undefined));

describe('openTerminalRoute', () => {
  it('opens the window on the desktop and attaches there for an agent that runs on the desktop', () => {
    expect(openTerminalRoute({})).toEqual({ kind: 'agent-host', host: DESKTOP });
    expect(openTerminalRoute({ runLocation: 'desktop' })).toEqual({ kind: 'agent-host', host: DESKTOP });
    expect(openTerminalRoute({ host: ' other ' })).toEqual({ kind: 'agent-host', host: 'other' });
  });

  it('opens the window on the desktop and connects to the server for an agent that runs on the server', () => {
    expect(openTerminalRoute({ runLocation: 'server' })).toEqual({ kind: 'desktop-to-server', host: DESKTOP });
  });

  it('uses the agent\'s own desktop host for an agent on the server whose folders live on another host', () => {
    expect(openTerminalRoute({ runLocation: 'server', host: 'second-pc' })).toEqual({ kind: 'desktop-to-server', host: 'second-pc' });
  });

  it('says plainly that there is no window to open when an agent on the server has no desktop', () => {
    setHost(undefined);
    const route = openTerminalRoute({ runLocation: 'server' });
    expect(route.kind).toBe('unavailable');
    expect(route.kind === 'unavailable' && route.reason).toMatch(/no desktop is connected/u);
  });

  it('is this machine for any agent when no agent host is set up at all', () => {
    setHost(undefined);
    expect(openTerminalRoute({})).toEqual({ kind: 'this-machine' });
    expect(openTerminalRoute({ runLocation: 'desktop' })).toEqual({ kind: 'this-machine' });
  });
});
