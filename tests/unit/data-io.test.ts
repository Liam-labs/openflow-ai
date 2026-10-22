import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { jsonCache, readJsonFile, withFileLock, writeJsonFile } from '@/lib/data-io';

describe('withFileLock', () => {
  it('executes the callback and returns its result', async () => {
    const result = await withFileLock('/test/basic.json', async () => 42);
    expect(result).toBe(42);
  });

  it('propagates callback return value including objects', async () => {
    const result = await withFileLock('/test/object.json', async () => ({ a: 1, b: 'x' }));
    expect(result).toEqual({ a: 1, b: 'x' });
  });

  it('serializes concurrent calls to the same file path', async () => {
    const order: number[] = [];
    let resolveFirst!: () => void;
    const firstCanProceed = new Promise<void>((res) => { resolveFirst = res; });

    const first = withFileLock('/test/serial-A.json', async () => {
      order.push(1); // first acquires lock
      await firstCanProceed;
      order.push(2); // first finishes
    });

    // Yield so the event loop runs and first actually acquires the lock
    await new Promise((r) => setTimeout(r, 5));

    const second = withFileLock('/test/serial-A.json', async () => {
      order.push(3); // second must wait for first
    });

    resolveFirst();
    await Promise.all([first, second]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('does NOT block calls to different file paths', async () => {
    const order: number[] = [];
    let resolveA!: () => void;
    const aDone = new Promise<void>((r) => { resolveA = r; });

    const fileA = withFileLock('/test/diffA.json', async () => {
      order.push(1); // A starts
      await aDone;
      order.push(3); // A finishes last
    });

    await new Promise((r) => setTimeout(r, 5));

    // B targets a different file — should not wait for A
    const fileB = withFileLock('/test/diffB.json', async () => {
      order.push(2); // B runs while A holds its own lock
    });

    await fileB;
    resolveA();
    await fileA;

    expect(order[0]).toBe(1); // A started first
    expect(order[1]).toBe(2); // B ran before A finished (different lock)
    expect(order[2]).toBe(3); // A finished last
  });

  it('releases the lock after the callback throws', async () => {
    await expect(
      withFileLock('/test/throws.json', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Lock must be released — a second call should succeed immediately
    const result = await withFileLock('/test/throws.json', async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('re-throws the original error type', async () => {
    await expect(
      withFileLock('/test/typeerror.json', async () => {
        throw new TypeError('wrong type');
      })
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('queues multiple waiters and runs them in order', async () => {
    const order: number[] = [];
    const releases: Array<() => void> = [];

    // Queue 3 concurrent calls
    const tasks = [1, 2, 3].map((n) =>
      withFileLock('/test/queue.json', async () => {
        order.push(n);
        await new Promise<void>((res) => releases.push(res));
      })
    );

    await new Promise((r) => setTimeout(r, 10));

    // Release each one in sequence
    for (const release of releases) {
      release();
      await new Promise((r) => setTimeout(r, 5));
    }

    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  it('invalidates a stale cached snapshot before a locked read-modify-write', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devflow-data-io-'));
    const file = path.join(dir, 'state.json');
    try {
      await fs.writeFile(file, JSON.stringify({ revision: 1 }));
      expect(await readJsonFile(file, { revision: 0 })).toEqual({ revision: 1 });

      // Simulate a write from another compiled bundle/process whose cache is
      // independent from this module instance.
      await fs.writeFile(file, JSON.stringify({ revision: 2 }));
      const observed = await withFileLock(file, () => readJsonFile(file, { revision: 0 }));
      expect(observed).toEqual({ revision: 2 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('writeJsonFile file mode', () => {
  it('writes a new file as 0600 and turns an old world-readable one into 0600, leaving no temp file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataio-'));
    try {
      const file = path.join(dir, 'tokens.json');
      await writeJsonFile(file, { a: 1 });
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      await fs.chmod(file, 0o644);
      await writeJsonFile(file, { a: 2 });
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ a: 2 });
      expect((await fs.readdir(dir)).filter((n) => n.includes('.tmp.'))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('readJsonFile on a corrupt file', () => {
  it('returns the default but first keeps a private copy of the bad file, once per version', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataio-'));
    try {
      const file = path.join(dir, 'api-tokens.json');
      await fs.writeFile(file, '{"tokens": [ {"id": "keep-me"', { mode: 0o644 });
      expect(await readJsonFile(file, { tokens: [] })).toEqual({ tokens: [] });
      jsonCache.invalidate(file);
      await readJsonFile(file, { tokens: [] });
      const copies = (await fs.readdir(dir)).filter((n) => n.startsWith('api-tokens.json.corrupt-'));
      expect(copies).toHaveLength(1);
      expect(await fs.readFile(path.join(dir, copies[0]), 'utf8')).toContain('keep-me');
      expect((await fs.stat(path.join(dir, copies[0]))).mode & 0o777).toBe(0o600);
      await writeJsonFile(file, { tokens: [] });                                  // the overwrite that used to destroy it
      expect(await fs.readFile(path.join(dir, copies[0]), 'utf8')).toContain('keep-me');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it('a missing file makes no copy and no noise', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataio-'));
    try {
      expect(await readJsonFile(path.join(dir, 'none.json'), 7)).toBe(7);
      expect(await fs.readdir(dir)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
