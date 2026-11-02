import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { clearReplacedContainerLock } from '@/lib/wizards/browser-container-profile';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-lock-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('removes only old container singleton links and preserves profile data', async () => {
  await fs.symlink('old-container-123', path.join(root, 'SingletonLock'));
  await fs.symlink('/tmp/old/socket', path.join(root, 'SingletonSocket'));
  await fs.writeFile(path.join(root, 'Preferences'), 'saved-profile');
  await clearReplacedContainerLock(root, true, 'new-container');
  expect(await fs.readdir(root)).toEqual(['Preferences']);
  expect(await fs.readFile(path.join(root, 'Preferences'), 'utf8')).toBe('saved-profile');
});
it('leaves native and current-container locks intact', async () => {
  await fs.symlink('same-container-123', path.join(root, 'SingletonLock'));
  await clearReplacedContainerLock(root, false, 'new-container');
  await clearReplacedContainerLock(root, true, 'same-container');
  expect(await fs.readlink(path.join(root, 'SingletonLock'))).toBe('same-container-123');
});
it('does not remove an unrecognised lock or its target', async () => {
  await fs.writeFile(path.join(root, 'secret'), 'keep');
  await fs.symlink(path.join(root, 'secret'), path.join(root, 'SingletonLock'));
  await clearReplacedContainerLock(root, true, 'new-container');
  expect(await fs.readFile(path.join(root, 'SingletonLock'), 'utf8')).toBe('keep');
});
