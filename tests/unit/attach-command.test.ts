import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { attachCommand } from '@/lib/attach-command';

vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: vi.fn(async () => null) }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_n: string, h: unknown) => h }));

describe('attachCommand', () => {
  it('is the bare tmux command outside a container', () => {
    expect(attachCommand('collab-lead-1', false)).toBe('tmux attach -t collab-lead-1');
  });
  it('goes through docker compose inside a container, where the tmux server lives', () => {
    expect(attachCommand('collab-lead-1', true)).toBe('docker compose exec -it openflow tmux attach -t collab-lead-1');
  });
  it('refuses a name that is not a plain session name, in both places', () => {
    for (const bad of [undefined, null, '', 'a b', 'x; rm -rf ~', '$(id)', 'a'.repeat(121)]) {
      expect(attachCommand(bad as string, false)).toBeUndefined();
      expect(attachCommand(bad as string, true)).toBeUndefined();
    }
  });
});

describe('GET /api/collab/attach-command', () => {
  it('answers a command for a plain session name and 400 for anything else', async () => {
    const { GET } = await import('@/app/api/collab/attach-command/route');
    const ok = await GET(new NextRequest('http://localhost/api/collab/attach-command?session=collab-lead-1'));
    const json = await ok.json();
    expect(ok.status).toBe(200);
    expect(json.command).toMatch(/tmux attach -t collab-lead-1$/);
    const bad = await GET(new NextRequest('http://localhost/api/collab/attach-command?session=' + encodeURIComponent('x; rm -rf ~')));
    expect(bad.status).toBe(400);
    expect((await GET(new NextRequest('http://localhost/api/collab/attach-command'))).status).toBe(400);
  });
});
