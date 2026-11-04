import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
// @ts-expect-error plain .mjs script with no type file
import { classify, checkFiles, validateManifest } from '../../scripts/check-ownership.mjs';

const root = path.resolve(__dirname, '../..');
const manifest = { rules: [
  { path: 'lib/**', kind: 'core' },
  { path: 'lib/setup/**', kind: 'openflow-only' },
  { path: 'lib/setup/shared.ts', kind: 'core' },
  { path: 'secrets/**', kind: 'devflow-only' },
  { path: 'README.md', kind: 'openflow-only' },
] };

describe('ownership manifest: matching', () => {
  it('the most specific rule wins', () => {
    expect(classify(manifest, 'lib/a.ts')).toBe('core');
    expect(classify(manifest, 'lib/setup/x.ts')).toBe('openflow-only');
    expect(classify(manifest, 'lib/setup/shared.ts')).toBe('core');
  });
  it('does not match a sibling that only shares a name prefix', () => {
    expect(classify(manifest, 'library/a.ts')).toBeNull();
    expect(classify(manifest, 'README.md.bak')).toBeNull();
  });
});

describe('ownership check on a change', () => {
  it('fails a file with no label', () => {
    expect(checkFiles(manifest, ['newdir/a.ts'])).toHaveLength(1);
  });
  it('lets an ordinary change to a core file through', () => {
    expect(checkFiles(manifest, ['lib/a.ts'], 'siler/thing')).toEqual([]);
  });
  it('fails an export branch that touches an openflow-only path, whether added, changed or removed', () => {
    expect(checkFiles(manifest, ['lib/setup/x.ts', 'README.md'], 'export/20261104-abc')).toHaveLength(2);
  });
  it('lets OpenFlow itself change its own openflow-only paths on an ordinary branch', () => {
    expect(checkFiles(manifest, ['lib/setup/x.ts', 'README.md'], 'mckay/fix')).toEqual([]);
  });
  it('fails anything marked devflow-only, on every branch', () => {
    expect(checkFiles(manifest, ['secrets/key.json'], 'mckay/fix')).toHaveLength(1);
  });
});

describe('ownership manifest: validity', () => {
  it('rejects an unknown kind, a bad pattern and a duplicate', () => {
    expect(validateManifest({ rules: [{ path: 'a', kind: 'both' }] })).toHaveLength(1);
    expect(validateManifest({ rules: [{ path: 'a*b', kind: 'core' }] })).toHaveLength(1);
    expect(validateManifest({ rules: [{ path: 'a', kind: 'core' }, { path: 'a', kind: 'core' }] })).toHaveLength(1);
  });
  it('the real ownership.json protects the README and the check itself from an export', () => {
    const real = JSON.parse(readFileSync(path.join(root, 'ownership.json'), 'utf8'));
    for (const f of ['README.md', 'ownership.json', 'scripts/check-ownership.mjs', 'tests/unit/ownership.test.ts', '.github/workflows/checks.yml']) {
      expect(classify(real, f), f).toBe('openflow-only');
    }
  });
  it('the real ownership.json is valid and labels every tracked file', () => {
    const real = JSON.parse(readFileSync(path.join(root, 'ownership.json'), 'utf8'));
    expect(validateManifest(real)).toEqual([]);
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
    expect(files.filter((f) => classify(real, f) === null)).toEqual([]);
    expect(files.filter((f) => classify(real, f) === 'devflow-only')).toEqual([]);
  });
});
