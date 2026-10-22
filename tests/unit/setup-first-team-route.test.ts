/**
 * POST / GET /api/setup/first-team — the last step of the first-run wizard.
 * Creates the first channel and starts the example agents from
 * data/examples/agents.json. Collaborators are mocked: no channel or agent is
 * really created.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { root, createChannel, getChannel, provision } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const os = require('node:os') as typeof import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-team-'));
  fs.mkdirSync(path.join(root, 'data', 'examples'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'roles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'examples', 'agents.json'), JSON.stringify({
    agents: [
      { name: 'Scout', roleSlug: 'researcher', personality: 'Scout', summary: 's', firstMessage: 'hi scout' },
      { name: 'Mason', roleSlug: 'backend-dev', personality: 'Mason', summary: 'm', firstMessage: 'hi mason' },
    ],
  }));
  fs.writeFileSync(path.join(root, 'data', 'roles', 'roles.json'), JSON.stringify({
    roles: [{ id: 'r-research', slug: 'researcher' }, { id: 'r-backend', slug: 'backend-dev' }],
  }));
  return { root, createChannel: vi.fn(), getChannel: vi.fn(), provision: vi.fn() };
});

vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: vi.fn(async () => null) }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_n: string, h: unknown) => h }));
vi.mock('@/lib/app-paths', () => ({ appPath: (...s: string[]) => require('node:path').join(root, ...s) }));
vi.mock('@/lib/home-dir', () => ({ getHomeDir: () => root }));
vi.mock('@/app/api/agent/actions/collab', () => ({ createChannel, getChannel }));
vi.mock('@/app/api/agent/actions/roster', () => ({ provision }));

import { GET, POST } from '@/app/api/setup/first-team/route';
import { requireAuthOrLocal } from '@/lib/api-auth';

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/setup/first-team', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  createChannel.mockResolvedValue({ channel: { id: 'chan-1' } });
  getChannel.mockResolvedValue({ channel: { id: 'chan-1', roster: { agents: [] } }, found: true });
  provision.mockResolvedValue({ spawned: true });
});

describe('/api/setup/first-team', () => {
  it('GET lists the example agents and a default project folder', async () => {
    const json = await (await GET(new NextRequest('http://localhost/api/setup/first-team'))).json();
    expect(json.agents.map((a: { name: string }) => a.name)).toEqual(['Scout', 'Mason']);
    expect(json.defaultWorkingDirectory).toContain('first-project');
  });

  it('GET says whether each runtime tool is installed, with the install command', async () => {
    const json = await (await GET(new NextRequest('http://localhost/api/setup/first-team'))).json();
    expect(typeof json.runtimes.claude.installed).toBe('boolean');
    expect(json.runtimes.claude.install).toContain('@anthropic-ai/claude-code');
    expect(json.runtimes.grok.installed).toBeNull();
  });

  it('creates one channel and starts both agents with their role ids', async () => {
    const json = await (await post({ agentType: 'claude' })).json();
    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledTimes(2);
    expect(provision.mock.calls[0][0]).toMatchObject({ channelId: 'chan-1', name: 'Scout', roleId: 'r-research', roleSlug: 'researcher', agentType: 'claude' });
    expect(provision.mock.calls[1][0]).toMatchObject({ name: 'Mason', roleId: 'r-backend' });
    expect(json).toMatchObject({ success: true, channelId: 'chan-1' });
    expect(json.firstMessages).toEqual({ Scout: 'hi scout', Mason: 'hi mason' });
  });

  it('starts only the agents asked for', async () => {
    await post({ agents: ['Scout'] });
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty selection and an unknown runtime falls back to claude', async () => {
    expect((await post({ agents: ['Nobody'] })).status).toBe(400);
    await post({ agents: ['Scout'], agentType: 'rm -rf' });
    expect(provision.mock.calls[0][0].agentType).toBe('claude');
  });

  it('reports a failed agent without losing the other one', async () => {
    provision.mockResolvedValueOnce({ spawned: false, error: 'spawn failed' }).mockResolvedValueOnce({ spawned: true });
    const json = await (await post({})).json();
    expect(json.success).toBe(true);
    expect(json.agents).toEqual([{ name: 'Scout', started: false, error: 'spawn failed' }, { name: 'Mason', started: true }]);
  });

  it('is not successful when every agent fails', async () => {
    provision.mockRejectedValue(new Error('no runtime'));
    const json = await (await post({})).json();
    expect(json.success).toBe(false);
    expect(json.agents[0].error).toBe('no runtime');
  });

  it('retry reuses the channel and skips agents already in the roster', async () => {
    getChannel.mockResolvedValue({ channel: { id: 'chan-1', roster: { agents: [{ name: 'Scout' }] } }, found: true });
    const json = await (await post({ channelId: 'chan-1' })).json();
    expect(createChannel).not.toHaveBeenCalled();
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision.mock.calls[0][0].name).toBe('Mason');
    expect(json.agents[0]).toEqual({ name: 'Scout', started: true });
  });

  it('refuses callers that are not authorised', async () => {
    vi.mocked(requireAuthOrLocal).mockResolvedValueOnce(new Response('no', { status: 401 }) as never);
    expect((await post({})).status).toBe(401);
    expect(createChannel).not.toHaveBeenCalled();
  });
});
