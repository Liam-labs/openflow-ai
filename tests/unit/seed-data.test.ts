import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedFileIfMissing } from '@/lib/seed-data';

describe('seedFileIfMissing', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seed-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('copies the starting file into a missing place, creating the folder', async () => {
    writeFileSync(join(dir, 'models.json'), '{"models":[1,2]}');
    const target = join(dir, 'AppData', 'sub', 'models.json');
    expect(await seedFileIfMissing(join(dir, 'models.json'), target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"models":[1,2]}');
    expect(readdirSync(join(dir, 'AppData', 'sub'))).toEqual(['models.json']);   // no temporary file left behind
  });

  it('never replaces a file that is already there', async () => {
    writeFileSync(join(dir, 'models.json'), 'shipped');
    writeFileSync(join(dir, 'mine.json'), 'my own edits');
    expect(await seedFileIfMissing(join(dir, 'models.json'), join(dir, 'mine.json'))).toBe(false);
    expect(readFileSync(join(dir, 'mine.json'), 'utf8')).toBe('my own edits');
  });

  it('does nothing when the edition ships no starting file', async () => {
    expect(await seedFileIfMissing(join(dir, 'absent.json'), join(dir, 'AppData', 'x.json'))).toBe(false);
    expect(existsSync(join(dir, 'AppData'))).toBe(false);
  });

  it('two starters at once leave one intact copy and report one write', async () => {
    writeFileSync(join(dir, 'models.json'), 'x'.repeat(100000));
    const target = join(dir, 'AppData', 'models.json');
    const results = await Promise.all([1, 2, 3, 4].map(() => seedFileIfMissing(join(dir, 'models.json'), target)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(readFileSync(target, 'utf8')).toHaveLength(100000);
    expect(readdirSync(join(dir, 'AppData'))).toEqual(['models.json']);
  });
});
