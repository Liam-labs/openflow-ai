/** The container installer gives one app instance exclusive ownership of its data volume. */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export async function clearReplacedContainerLock(profile: string, container: boolean, hostname = os.hostname()): Promise<void> {
  if (!container) return;
  let target: string;
  try { target = await fs.readlink(path.join(profile, 'SingletonLock')); }
  catch (error) {
    if (['ENOENT', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
  const match = /^([a-zA-Z0-9_.-]+)-(\d+)$/.exec(target);
  // A lock from this container is Chromium's to check. Never touch profile data.
  if (!match || match[1] === hostname) return;
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { await fs.unlink(path.join(profile, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
