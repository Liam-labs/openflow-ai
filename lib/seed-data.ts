import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * Give a fresh install the starting data it needs, without ever touching what is already there.
 *
 * The model list (Systems > Models, the default model of every runtime) lives in .AppData/models.json, which the app edits at run
 * time. A fresh install had no such file, so that page failed with "r.map is not a function" and nothing knew which models exist.
 * The release ships the starting list as data/models.json; this copies it over once. An existing file is never replaced.
 * Returns true when a file was written.
 */
export async function seedFileIfMissing(from: string, to: string): Promise<boolean> {
  try {
    await fs.access(to);
    return false;                                   // already there: the user's own copy wins
  } catch { /* missing: seed it */ }
  let content: Buffer;
  try {
    content = await fs.readFile(from);
  } catch {
    return false;                                   // this edition ships no starting file: nothing to do
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  const tmp = `${to}.tmp.${process.pid}-${randomUUID()}`;
  await fs.writeFile(tmp, content, { flag: 'w' });
  try {
    await fs.link(tmp, to);                         // never overwrites: a racing starter that won keeps its file
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return true;
}
