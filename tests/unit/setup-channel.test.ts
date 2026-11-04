import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ensureSetupChannel, markerFile, readMarkerFile, writeMarkerFile, type SetupChannelDeps, type GuideDefinition } from '@/lib/setup/setup-channel';
import { buildSetupSummary } from '@/lib/setup/setup-summary';

const guide: GuideDefinition = { name: 'Guide', channelName: 'Setup', channelDescription: 'd', roleSlug: 'researcher', personality: 'Guide', firstMessage: 'hi' };

function deps(over: Partial<SetupChannelDeps> = {}, marker: { channelId: string } | null = null): SetupChannelDeps & { writes: unknown[] } {
  const writes: unknown[] = [];
  return {
    writes,
    readMarker: async () => marker,
    writeMarker: async (m) => { writes.push(m); },
    loadGuide: async () => guide,
    createChannel: vi.fn(async () => 'chan-1'),
    startGuide: vi.fn(async () => ({ started: true })),
    now: () => '2026-11-04T10:00:00Z',
    ...over,
  };
}

describe('ensureSetupChannel', () => {
  it('creates the channel and starts the Guide once, then records it', async () => {
    const d = deps();
    const r = await ensureSetupChannel(d);
    expect(r).toMatchObject({ status: 'created', channelId: 'chan-1', guideStarted: true, firstMessage: 'hi' });
    expect(d.writes).toEqual([{ channelId: 'chan-1', at: '2026-11-04T10:00:00Z' }]);
  });

  it('does nothing when the marker exists, so a deleted channel does not come back and a retry makes no second one', async () => {
    const d = deps({}, { channelId: 'old' });
    expect(await ensureSetupChannel(d)).toEqual({ status: 'exists' });
    expect(d.createChannel).not.toHaveBeenCalled();
    expect(d.startGuide).not.toHaveBeenCalled();
  });

  it('never throws into the wizard: a failure is reported and nothing is recorded', async () => {
    const d = deps({ createChannel: async () => { throw new Error('boom'); } });
    expect(await ensureSetupChannel(d)).toEqual({ status: 'failed', error: 'boom' });
    expect(d.writes).toEqual([]);
  });

  it('reports a Guide that did not start but keeps the channel', async () => {
    const d = deps({ startGuide: async () => ({ started: false, error: 'no runtime' }) });
    expect(await ensureSetupChannel(d)).toMatchObject({ status: 'created', guideStarted: false, error: 'no runtime' });
  });
});

describe('marker file', () => {
  it('round-trips and reads a missing or broken file as not yet created', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-ch-'));
    const file = markerFile(dir);
    expect(await readMarkerFile(file)).toBeNull();
    await writeMarkerFile(file, { channelId: 'c9', at: 'x' });
    expect(await readMarkerFile(file)).toEqual({ channelId: 'c9' });
    await fs.writeFile(file, 'not json');
    expect(await readMarkerFile(file)).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('buildSetupSummary', () => {
  const none = async () => ({});
  it('maps each wizard record to on, off or skipped, with no secrets in it', async () => {
    const items = await buildSetupSummary({ passwordSet: async () => true, remoteAccess: async () => ({ enabled: true }), cloudflare: none, browser: none, memory: async () => ({ skipped: true }) });
    expect(Object.fromEntries(items.map((i) => [i.id, i.state]))).toEqual({ password: 'on', 'phone-access': 'on', 'own-domain': 'off', browser: 'off', memory: 'skipped' });
    expect(Object.keys(items[0]).sort()).toEqual(['id', 'label', 'state', 'where']);
  });
  it('reads an unreadable record as not set up instead of failing', async () => {
    const bad = async () => { throw new Error('x'); };
    const items = await buildSetupSummary({ passwordSet: bad, remoteAccess: bad, cloudflare: bad, browser: bad, memory: bad });
    expect(items.every((i) => i.state === 'off')).toBe(true);
  });
});
