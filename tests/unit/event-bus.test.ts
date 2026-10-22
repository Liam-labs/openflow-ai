import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';

// Mock fs so we can intercept disk I/O in flushToDisk tests.
// Call-through by default so loadFromDisk() in the constructor still works normally.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    existsSync: vi.fn().mockImplementation(real.existsSync.bind(real)),
    mkdirSync: vi.fn().mockImplementation(real.mkdirSync.bind(real)),
    writeFileSync: vi.fn().mockImplementation(real.writeFileSync.bind(real)),
    renameSync: vi.fn().mockImplementation(real.renameSync.bind(real)),
    readFileSync: vi.fn().mockImplementation(real.readFileSync.bind(real)),
  };
});

import { eventBus, type SSEEvent } from '@/lib/event-bus';

// ─── emitEvent ────────────────────────────────────────────────────────────────

describe('eventBus.emitEvent', () => {
  it('returns an SSEEvent with the correct shape', () => {
    const event = eventBus.emitEvent('heartbeat', { ping: true });
    expect(event.id).toMatch(/^\d+$/);
    expect(event.type).toBe('heartbeat');
    expect(event.data).toEqual({ ping: true });
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('IDs strictly increase on rapid successive emits', () => {
    const e1 = eventBus.emitEvent('heartbeat', 1);
    const e2 = eventBus.emitEvent('heartbeat', 2);
    const e3 = eventBus.emitEvent('heartbeat', 3);
    expect(parseInt(e2.id)).toBeGreaterThan(parseInt(e1.id));
    expect(parseInt(e3.id)).toBeGreaterThan(parseInt(e2.id));
  });

  it('emits sse-event to registered listeners', () => {
    const received: SSEEvent[] = [];
    const handler = (e: SSEEvent) => received.push(e);
    eventBus.on('sse-event', handler);

    const emitted = eventBus.emitEvent('pm2:status', { procs: 3 });
    eventBus.off('sse-event', handler);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(emitted);
  });

  it('buffers each emitted event (size increases up to cap)', () => {
    const before = eventBus.getBufferSize();
    const max = eventBus.getMaxBufferSize();
    eventBus.emitEvent('health:status', { ok: true });
    // If buffer was at cap, eviction keeps it at max; otherwise it grows by 1
    expect(eventBus.getBufferSize()).toBe(Math.min(before + 1, max));
  });

  it('caps buffer at maxRecentEvents (100) by evicting oldest', () => {
    for (let i = 0; i < 200; i++) {
      eventBus.emitEvent('heartbeat', i);
    }
    expect(eventBus.getBufferSize()).toBe(eventBus.getMaxBufferSize());
  });

  it('calls flushToDisk when type is system:restarting', () => {
    const spy = vi.spyOn(eventBus, 'flushToDisk').mockImplementation(() => {});
    eventBus.emitEvent('system:restarting', {});
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

// ─── getEventsSince ───────────────────────────────────────────────────────────

describe('eventBus.getEventsSince', () => {
  it('returns [] for a non-numeric lastEventId', () => {
    expect(eventBus.getEventsSince('not-a-number')).toEqual([]);
  });

  it('returns [] for an empty string lastEventId', () => {
    expect(eventBus.getEventsSince('')).toEqual([]);
  });

  it('returns events with id strictly greater than the given id', () => {
    const e1 = eventBus.emitEvent('health:status', 'a');
    const e2 = eventBus.emitEvent('health:status', 'b');
    const e3 = eventBus.emitEvent('health:status', 'c');

    const since = eventBus.getEventsSince(e1.id);
    const ids = since.map(e => e.id);

    expect(ids).toContain(e2.id);
    expect(ids).toContain(e3.id);
    expect(ids).not.toContain(e1.id);
  });

  it('returns [] when called with the latest event id', () => {
    const latest = eventBus.emitEvent('heartbeat', 'latest');
    expect(eventBus.getEventsSince(latest.id)).toEqual([]);
  });
});

// ─── client count ─────────────────────────────────────────────────────────────

describe('eventBus client count', () => {
  it('addClient / removeClient track the connected count', () => {
    const before = eventBus.getClientCount();
    eventBus.addClient();
    eventBus.addClient();
    expect(eventBus.getClientCount()).toBe(before + 2);
    eventBus.removeClient();
    expect(eventBus.getClientCount()).toBe(before + 1);
    eventBus.removeClient();
    expect(eventBus.getClientCount()).toBe(before);
  });

  it('removeClient never drops the count below zero', () => {
    const before = eventBus.getClientCount();
    for (let i = 0; i <= before + 5; i++) {
      eventBus.removeClient();
    }
    expect(eventBus.getClientCount()).toBe(0);
    // Restore pre-test value
    for (let i = 0; i < before; i++) {
      eventBus.addClient();
    }
  });
});

// ─── flushToDisk ─────────────────────────────────────────────────────────────

describe('eventBus.flushToDisk', () => {
  afterEach(() => {
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();
    vi.mocked(fs.existsSync).mockReset();
  });

  it('writes a valid JSON array via writeFileSync then renames atomically', () => {
    let capturedData: string | undefined;

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockImplementation((_p, data) => {
      capturedData = String(data);
    });
    vi.mocked(fs.renameSync).mockImplementation(() => {});

    eventBus.emitEvent('health:status', { sentinel: 'flush-verify' });
    eventBus.flushToDisk();

    expect(capturedData).toBeDefined();
    const parsed = JSON.parse(capturedData!);
    expect(Array.isArray(parsed)).toBe(true);
    const found = parsed.some(
      (e: SSEEvent) =>
        e.type === 'health:status' &&
        typeof e.data === 'object' &&
        (e.data as Record<string, unknown>)['sentinel'] === 'flush-verify'
    );
    expect(found).toBe(true);
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
  });

  it('does not throw when fs operations fail (non-fatal error handling)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => eventBus.flushToDisk()).not.toThrow();
  });
});
