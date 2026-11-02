import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
const spawn = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn }));
import { managedDatabase } from '@/lib/wizards/memory-runtime';
let root: string;
let child: EventEmitter & { exitCode: number | null; kill: ReturnType<typeof vi.fn> };
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-memory-'));
  child = Object.assign(new EventEmitter(), { exitCode: null, kill: vi.fn(() => { child.exitCode = 0; child.emit('exit', 0); return true; }) });
  spawn.mockReset().mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child; });
});
afterEach(async () => { await managedDatabase(root).stop(); await fs.rm(root, { recursive: true, force: true }); });
it('starts once for concurrent actions, with private storage and loopback listeners', async () => {
  const database = managedDatabase(root);
  await Promise.all([database.start(), database.start()]);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0][0]).toBe('/usr/local/bin/openflow-qdrant');
  expect(spawn.mock.calls[0][2]).toMatchObject({ cwd: root, env: {
    QDRANT__SERVICE__HOST: '127.0.0.1', QDRANT__SERVICE__HTTP_PORT: '6333',
    QDRANT__STORAGE__STORAGE_PATH: path.join(root, 'qdrant-storage'),
  } });
  await database.stop();
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect((await fs.stat(path.join(root, 'qdrant-storage'))).isDirectory()).toBe(true);
});
it('clears failed spawn state so retry can start', async () => {
  spawn.mockImplementationOnce(() => { queueMicrotask(() => child.emit('error', new Error('missing binary'))); return child; });
  await expect(managedDatabase(root).start()).rejects.toThrow('missing binary');
  await managedDatabase(root).start();
  expect(spawn).toHaveBeenCalledTimes(2);
});
