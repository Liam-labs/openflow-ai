import { expect, it, vi } from 'vitest';
const hostCall = vi.hoisted(() => vi.fn(async () => ({ alive: true })));
vi.mock('@/lib/host-executor', () => ({ hostCall }));
import { spawnOnHost } from '@/lib/remote-spawn';
const request = { session: 'collab-agent-test', cwd: '/tmp', spec: { launcher: 'collab-codex', args: ['--name', 'Jack', '--channel', 'test'], env: {} } };
it('ordinary starts cannot replace a live wrapper', async () => {
  await spawnOnHost('desktop', request);
  expect(hostCall).toHaveBeenLastCalledWith('desktop', 'spawn', expect.objectContaining({ replace: false }), 90000);
});
it('explicit restart forwards replacement to the agent host', async () => {
  await spawnOnHost('desktop', { ...request, replace: true });
  expect(hostCall).toHaveBeenLastCalledWith('desktop', 'spawn', expect.objectContaining({ replace: true }), 90000);
});
