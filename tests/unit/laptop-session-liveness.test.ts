/**
 * An agent that runs on the Remote server lives in that machine's own tmux, while every other agent lives in the desktop's tmux (reached through
 * agent-hostd). Crash detection and the roster list ask "is this session alive?"; asking only the desktop made a healthy laptop agent look crashed within
 * seconds, so it was restarted over and over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  desktopSessions: '' as string,                 // what the desktop's tmux answers to `list-sessions`
  info: {} as Record<string, { sessions: string[]; fresh: boolean; memMB: Record<string, number> }>,
}));
const local = vi.hoisted(() => ({ sessions: '' as string }));

vi.mock('@/lib/host-registry', () => ({
  enqueue: vi.fn(async () => ({ ok: true, result: { rc: 0, stdout: registry.desktopSessions, stderr: '' } })),
  getHostInfo: (id: string) => registry.info[id] ?? null,
  hostIds: () => Object.keys(registry.info),
}));
vi.mock('child_process', async importOriginal => ({ ...(await importOriginal<typeof import('child_process')>()), execFileSync: () => local.sessions }));
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<typeof import('node:child_process')>()), execFileSync: () => local.sessions }));

import { rememberLocalSession, rememberSessionHost } from '@/lib/host-executor';
import { tmuxSessionExists } from '@/lib/collab-pty';

const LAPTOP = 'collab-agent-laptop01';
const DESKTOP_SESSION = 'collab-agent-desk0001';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
  process.env.DEVFLOW_AGENT_HOST = 'desktop';
  registry.desktopSessions = `${DESKTOP_SESSION}\n`;
  registry.info = { desktop: { sessions: [DESKTOP_SESSION], fresh: true, memMB: {} } };
  local.sessions = '';
  vi.advanceTimersByTime(11_000);                          // let the 10-second cache of the desktop's sessions expire
  rememberLocalSession('reset'); rememberSessionHost('reset', null);
});
afterEach(() => { vi.useRealTimers(); delete process.env.DEVFLOW_AGENT_HOST; rememberSessionHost(LAPTOP, null); });

describe('tmuxSessionExists with an agent host and an agent on this machine', () => {
  it('finds a session that runs on this machine, which the desktop knows nothing about', async () => {
    rememberLocalSession(LAPTOP);
    local.sessions = `${LAPTOP}\n`;
    expect(await tmuxSessionExists(LAPTOP)).toBe(true);
  });
  it('still finds it after DevFlow restarted and forgot where it started', async () => {
    local.sessions = `${LAPTOP}\n`;
    expect(await tmuxSessionExists(LAPTOP)).toBe(true);
  });
  it('says it is gone once this machine\'s tmux no longer has it', async () => {
    rememberLocalSession(LAPTOP);
    local.sessions = '';
    expect(await tmuxSessionExists(LAPTOP)).toBe(false);
  });
  it('keeps answering for the desktop\'s own sessions from the desktop\'s list', async () => {
    expect(await tmuxSessionExists(DESKTOP_SESSION)).toBe(true);
    vi.advanceTimersByTime(11_000);
    registry.desktopSessions = '';
    registry.info.desktop.sessions = [];
    expect(await tmuxSessionExists(DESKTOP_SESSION)).toBe(false);
  });
  it('does not take a desktop session for a local one just because a local session has the same name', async () => {
    rememberSessionHost(DESKTOP_SESSION, 'desktop');
    local.sessions = `${DESKTOP_SESSION}\n`;
    registry.desktopSessions = '';
    registry.info.desktop.sessions = [];
    expect(await tmuxSessionExists(DESKTOP_SESSION)).toBe(false);
    rememberSessionHost(DESKTOP_SESSION, null);
  });
  it('counts a session as alive while the desktop link is down, so a dropped link is not a crash', async () => {
    registry.info.desktop.fresh = false;
    registry.desktopSessions = '';
    expect(await tmuxSessionExists('collab-agent-unknown1')).toBe(true);
  });
});
