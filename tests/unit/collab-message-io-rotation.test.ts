import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import type { CollabMessage, ChannelMessagesArchive, ChannelMessagesData } from '@/lib/types';

// Set DEVFLOW_DATA_DIR BEFORE importing the module so DataPaths picks it up.
// path.join(APP_CWD, DEVFLOW_DATA_DIR) strips leading slashes, so we must pass a relative dir.
const TEST_DIR_REL = vi.hoisted(() => {
  const name = `.AppData-test-rotation-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  process.env.DEVFLOW_DATA_DIR = name;
  return name;
});
const TEST_MESSAGES_DIR = path.join(process.cwd(), TEST_DIR_REL, 'collab-messages');

import { rotateMessageArchives, writeChannelMessages } from '@/lib/collab-message-io';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMsg(id: string, daysAgo: number, channelId = 'test'): CollabMessage {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    id,
    channelId,
    from: {
      id: 'test-participant',
      name: 'Test',
      type: 'claude',
      source: 'WSL',
      joinedAt: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
    },
    content: `msg ${id}`,
    timestamp: ts,
  };
}

async function readJson<T>(p: string): Promise<T> {
  const buf = await fs.readFile(p, 'utf8');
  return JSON.parse(buf) as T;
}

async function rmrf(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(async () => {
  await rmrf(path.join(process.cwd(), TEST_DIR_REL));
  await fs.mkdir(TEST_MESSAGES_DIR, { recursive: true });
});

afterAll(async () => {
  await rmrf(path.join(process.cwd(), TEST_DIR_REL));
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('rotateMessageArchives — MIN_ACTIVE_MESSAGES preservation', () => {
  it('preserves the last 50 messages when ALL are older than 7 days', async () => {
    // Channel with 100 messages, all 10 days old (all stale)
    const channelId = 'test-stale-all';
    const msgs: CollabMessage[] = Array.from({ length: 100 }, (_, i) =>
      makeMsg(`m${i.toString().padStart(3, '0')}`, 10)
    );

    await writeChannelMessages(channelId, {
      channelId,
      messages: msgs,
      lastUpdated: new Date().toISOString(),
    });

    await rotateMessageArchives();

    const mainPath = path.join(TEST_MESSAGES_DIR, `${channelId}.json`);
    const main = await readJson<ChannelMessagesData>(mainPath);

    // BUG (before fix): main file is drained to 0 messages
    // AFTER FIX: main file retains last 50 messages
    expect(main.messages.length).toBe(50);

    // The retained messages should be the NEWEST 50 (m050..m099)
    expect(main.messages[0].id).toBe('m050');
    expect(main.messages[49].id).toBe('m099');

    // The other 50 should be in an archive file
    const files = await fs.readdir(TEST_MESSAGES_DIR);
    const archives = files.filter(f => f.startsWith(`${channelId}-archive-`));
    expect(archives.length).toBe(1);

    const archive = await readJson<ChannelMessagesArchive>(path.join(TEST_MESSAGES_DIR, archives[0]));
    expect(archive.messages.length).toBe(50);
    expect(archive.messages[0].id).toBe('m000');
    expect(archive.messages[49].id).toBe('m049');
  });

  it('keeps ALL messages when channel has fewer than 50 total, even if all stale', async () => {
    const channelId = 'test-small-stale';
    const msgs: CollabMessage[] = Array.from({ length: 30 }, (_, i) =>
      makeMsg(`s${i.toString().padStart(3, '0')}`, 15)
    );

    await writeChannelMessages(channelId, {
      channelId,
      messages: msgs,
      lastUpdated: new Date().toISOString(),
    });

    await rotateMessageArchives();

    const mainPath = path.join(TEST_MESSAGES_DIR, `${channelId}.json`);
    const main = await readJson<ChannelMessagesData>(mainPath);

    // All 30 messages retained in main — no archive created
    expect(main.messages.length).toBe(30);

    const files = await fs.readdir(TEST_MESSAGES_DIR);
    const archives = files.filter(f => f.startsWith(`${channelId}-archive-`));
    expect(archives.length).toBe(0);
  });

  it('keeps fresh messages + last 50 (union) on mixed channels', async () => {
    const channelId = 'test-mixed';
    // 80 stale (10d old) + 20 fresh (1d old) — total 100
    const stale: CollabMessage[] = Array.from({ length: 80 }, (_, i) =>
      makeMsg(`old${i.toString().padStart(3, '0')}`, 10)
    );
    const fresh: CollabMessage[] = Array.from({ length: 20 }, (_, i) =>
      makeMsg(`new${i.toString().padStart(3, '0')}`, 1)
    );
    const all = [...stale, ...fresh];

    await writeChannelMessages(channelId, {
      channelId,
      messages: all,
      lastUpdated: new Date().toISOString(),
    });

    await rotateMessageArchives();

    const mainPath = path.join(TEST_MESSAGES_DIR, `${channelId}.json`);
    const main = await readJson<ChannelMessagesData>(mainPath);

    // Union: last 50 by order (old050..old079 + new000..new019) ∪ fresh (new000..new019) = last 50 msgs
    // Expected: main retains 50 (the tail), archive gets the oldest 50 (old000..old049)
    expect(main.messages.length).toBe(50);
    expect(main.messages[0].id).toBe('old050');
    expect(main.messages[49].id).toBe('new019');

    // Archive should contain old000..old049
    const files = await fs.readdir(TEST_MESSAGES_DIR);
    const archives = files.filter(f => f.startsWith(`${channelId}-archive-`));
    expect(archives.length).toBe(1);
    const archive = await readJson<ChannelMessagesArchive>(path.join(TEST_MESSAGES_DIR, archives[0]));
    expect(archive.messages.length).toBe(50);
    expect(archive.messages[0].id).toBe('old000');
    expect(archive.messages[49].id).toBe('old049');
  });

  it('no archive created if all messages are fresh (<7d)', async () => {
    const channelId = 'test-all-fresh';
    const msgs: CollabMessage[] = Array.from({ length: 100 }, (_, i) =>
      makeMsg(`f${i.toString().padStart(3, '0')}`, 1)
    );

    await writeChannelMessages(channelId, {
      channelId,
      messages: msgs,
      lastUpdated: new Date().toISOString(),
    });

    await rotateMessageArchives();

    const mainPath = path.join(TEST_MESSAGES_DIR, `${channelId}.json`);
    const main = await readJson<ChannelMessagesData>(mainPath);

    // All fresh, all retained
    expect(main.messages.length).toBe(100);

    const files = await fs.readdir(TEST_MESSAGES_DIR);
    const archives = files.filter(f => f.startsWith(`${channelId}-archive-`));
    expect(archives.length).toBe(0);
  });
});
