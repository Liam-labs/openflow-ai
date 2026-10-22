/**
 * Unit tests for resolveRelativePath — Sprint 69 T1.2.
 *
 * Verifies the channel→project resolver:
 *   - Absolute pass-through
 *   - Relative + projectPath joining
 *   - Traversal-escape rejection
 *   - Whitespace / encoding / backslash normalisation
 */

import { describe, it, expect } from 'vitest';
import { resolveRelativePath, isAbsolutePath } from '@/lib/path-chip-resolver';

describe('isAbsolutePath', () => {
  it('returns true for paths starting with /', () => {
    expect(isAbsolutePath('/home/user/x.ts')).toBe(true);
    expect(isAbsolutePath('/')).toBe(true);
  });

  it('returns false for relative paths', () => {
    expect(isAbsolutePath('scripts/foo.sh')).toBe(false);
    expect(isAbsolutePath('foo.ts')).toBe(false);
    expect(isAbsolutePath('')).toBe(false);
  });

  it('returns false for non-strings', () => {
    // @ts-expect-error testing runtime guard
    expect(isAbsolutePath(null)).toBe(false);
    // @ts-expect-error testing runtime guard
    expect(isAbsolutePath(undefined)).toBe(false);
    // @ts-expect-error testing runtime guard
    expect(isAbsolutePath(42)).toBe(false);
  });
});

describe('resolveRelativePath — happy path', () => {
  const project = '/home/user/SG-1';

  it('joins a simple relative path under projectPath', () => {
    expect(resolveRelativePath('scripts/foo.sh', project)).toBe(
      '/home/user/SG-1/scripts/foo.sh',
    );
  });

  it('joins a multi-segment relative path', () => {
    expect(resolveRelativePath('app/api/route.ts', project)).toBe(
      '/home/user/SG-1/app/api/route.ts',
    );
  });

  it('joins a bare filename', () => {
    expect(resolveRelativePath('package.json', project)).toBe(
      '/home/user/SG-1/package.json',
    );
  });

  it('returns absolute paths unchanged (input was already absolute)', () => {
    expect(resolveRelativePath('/home/user/SG-1/lib/foo.ts', project)).toBe(
      '/home/user/SG-1/lib/foo.ts',
    );
  });

  it('returns absolute path even when projectPath is missing', () => {
    expect(resolveRelativePath('/etc/hosts', undefined)).toBe('/etc/hosts');
  });

  it('joins a path that contains in-bounds .. (resolves cleanly inside root)', () => {
    expect(resolveRelativePath('app/../lib/foo.ts', project)).toBe(
      '/home/user/SG-1/lib/foo.ts',
    );
  });
});

describe('resolveRelativePath — input normalisation', () => {
  const project = '/home/user/SG-1';

  it('strips leading ./ from relative input', () => {
    expect(resolveRelativePath('./scripts/foo.sh', project)).toBe(
      '/home/user/SG-1/scripts/foo.sh',
    );
  });

  it('decodes percent-encoded spaces', () => {
    expect(resolveRelativePath('Start%20SEO%20Engine.bat', project)).toBe(
      '/home/user/SG-1/Start SEO Engine.bat',
    );
  });

  it('decodes percent-encoded slashes', () => {
    expect(resolveRelativePath('lib%2Ffoo.ts', project)).toBe(
      '/home/user/SG-1/lib/foo.ts',
    );
  });

  it('converts Windows-style backslashes to forward slashes', () => {
    expect(resolveRelativePath('lib\\foo.ts', project)).toBe(
      '/home/user/SG-1/lib/foo.ts',
    );
  });

  it('handles paths with literal spaces', () => {
    expect(resolveRelativePath('Start SEO Engine.bat', project)).toBe(
      '/home/user/SG-1/Start SEO Engine.bat',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(resolveRelativePath('  scripts/foo.sh  ', project)).toBe(
      '/home/user/SG-1/scripts/foo.sh',
    );
  });

  it('returns null for malformed percent-encoding', () => {
    // `%ZZ` is not a valid percent escape
    expect(resolveRelativePath('foo%ZZ.ts', project)).toBeNull();
  });
});

describe('resolveRelativePath — traversal escape rejection', () => {
  const project = '/home/user/SG-1';

  it('rejects classic ../etc/passwd attempt', () => {
    expect(resolveRelativePath('../../etc/passwd', project)).toBeNull();
  });

  it('rejects deep traversal', () => {
    expect(resolveRelativePath('../../../../../../../etc/passwd', project)).toBeNull();
  });

  it('rejects traversal that would land in a sibling project', () => {
    // /home/user/SG-1 → up one → /home/user → into other-project
    expect(resolveRelativePath('../other-project/foo.ts', project)).toBeNull();
  });

  it('rejects traversal disguised by encoded dots', () => {
    expect(resolveRelativePath('%2E%2E/etc/passwd', project)).toBeNull();
  });

  it('rejects traversal disguised by backslash sequences', () => {
    expect(resolveRelativePath('..\\..\\etc\\passwd', project)).toBeNull();
  });

  it('does NOT confuse projectPath with a sibling that shares its prefix', () => {
    // /home/user/SG-1 vs /home/user/SG-1-old — escape into the second must fail
    expect(resolveRelativePath('../SG-1-old/foo.ts', project)).toBeNull();
  });

  it('rejects relative input that decodes to an absolute path', () => {
    // %2F is a forward slash; a leading %2F would smuggle absoluteness in
    expect(resolveRelativePath('%2Fetc/passwd', project)).toBeNull();
  });
});

describe('resolveRelativePath — invalid inputs', () => {
  const project = '/home/user/SG-1';

  it('returns null for empty relative path', () => {
    expect(resolveRelativePath('', project)).toBeNull();
  });

  it('returns null for whitespace-only relative path', () => {
    expect(resolveRelativePath('   ', project)).toBeNull();
  });

  it('returns null when projectPath is missing for a relative input', () => {
    expect(resolveRelativePath('scripts/foo.sh', undefined)).toBeNull();
    expect(resolveRelativePath('scripts/foo.sh', null)).toBeNull();
    expect(resolveRelativePath('scripts/foo.sh', '')).toBeNull();
  });

  it('returns null when projectPath is itself relative', () => {
    expect(resolveRelativePath('foo.ts', 'relative/project')).toBeNull();
  });

  it('returns null for non-string relative input', () => {
    // @ts-expect-error testing runtime guard
    expect(resolveRelativePath(null, project)).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(resolveRelativePath(undefined, project)).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(resolveRelativePath(42, project)).toBeNull();
  });
});

describe('resolveRelativePath — edge of root', () => {
  it('matches root exactly when input is "."', () => {
    expect(resolveRelativePath('.', '/home/user/SG-1')).toBe('/home/user/SG-1');
  });

  it('handles projectPath with trailing slash', () => {
    expect(resolveRelativePath('lib/foo.ts', '/home/user/SG-1/')).toBe(
      '/home/user/SG-1/lib/foo.ts',
    );
  });

  it('handles deeply nested projectPath', () => {
    expect(resolveRelativePath('a.ts', '/a/b/c/d/e/f')).toBe('/a/b/c/d/e/f/a.ts');
  });
});
