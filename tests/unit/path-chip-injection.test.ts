/**
 * Unit tests for path chip injection into message renderer text segments.
 * Sprint 37 P1-T3. TDD — RED first.
 */

import { describe, it, expect } from 'vitest';
import { splitTextByPaths, type PathSegment } from '@/lib/path-chip-injection';

// ─── splitTextByPaths ───────────────────────────────────────────────────────

describe('splitTextByPaths', () => {
  it('returns single text segment for text with no paths', () => {
    expect(splitTextByPaths('Hello world')).toEqual([
      { type: 'text', value: 'Hello world' },
    ]);
  });

  it('splits text with one path', () => {
    const result = splitTextByPaths('Check /home/user/DevFlow/lib/foo.ts for details');
    expect(result).toEqual([
      { type: 'text', value: 'Check ' },
      { type: 'path', path: '/home/user/DevFlow/lib/foo.ts' },
      { type: 'text', value: ' for details' },
    ]);
  });

  it('splits text with path at start', () => {
    const result = splitTextByPaths('/home/user/DevFlow/package.json has the version');
    expect(result).toEqual([
      { type: 'path', path: '/home/user/DevFlow/package.json' },
      { type: 'text', value: ' has the version' },
    ]);
  });

  it('splits text with path at end', () => {
    const result = splitTextByPaths('See /home/user/SG-1/README.md');
    expect(result).toEqual([
      { type: 'text', value: 'See ' },
      { type: 'path', path: '/home/user/SG-1/README.md' },
    ]);
  });

  it('splits text with multiple paths', () => {
    const result = splitTextByPaths(
      'Copy /home/user/SG-1/plan.md to /mnt/c/Users/winuser/Desktop/plan.md'
    );
    expect(result).toEqual([
      { type: 'text', value: 'Copy ' },
      { type: 'path', path: '/home/user/SG-1/plan.md' },
      { type: 'text', value: ' to ' },
      { type: 'path', path: '/mnt/c/Users/winuser/Desktop/plan.md' },
    ]);
  });

  it('returns empty array for empty string', () => {
    expect(splitTextByPaths('')).toEqual([]);
  });

  it('returns just a path segment when text is only a path', () => {
    const result = splitTextByPaths('/home/user/DevFlow/lib/config.ts');
    expect(result).toEqual([
      { type: 'path', path: '/home/user/DevFlow/lib/config.ts' },
    ]);
  });

  it('does not detect paths inside inline code (already removed by parent renderer)', () => {
    // When splitTextByPaths is called on a text gap, inline code tokens have
    // already been consumed. This test confirms that if raw backtick text
    // somehow leaks through, parsePathsInText excludes it.
    expect(splitTextByPaths('Run `cat /home/user/test.ts` to see')).toEqual([
      { type: 'text', value: 'Run `cat /home/user/test.ts` to see' },
    ]);
  });
});

// ─── Sprint 69 T1.3 — relative path resolution into segments ────────────────

describe('splitTextByPaths — relative paths with channelProjectPath (T1.3)', () => {
  const project = '/home/user/SG-1';

  it('resolves a relative path and emits resolved field', () => {
    const result = splitTextByPaths('Edit lib/foo.ts please', project);
    expect(result).toEqual<PathSegment[]>([
      { type: 'text', value: 'Edit ' },
      { type: 'path', path: 'lib/foo.ts', resolved: '/home/user/SG-1/lib/foo.ts' },
      { type: 'text', value: ' please' },
    ]);
  });

  it('resolves a Title Case Windows-style filename', () => {
    const result = splitTextByPaths('open Start SEO Engine.bat now', project);
    expect(result).toEqual<PathSegment[]>([
      { type: 'text', value: 'open ' },
      {
        type: 'path',
        path: 'Start SEO Engine.bat',
        resolved: '/home/user/SG-1/Start SEO Engine.bat',
      },
      { type: 'text', value: ' now' },
    ]);
  });

  it('leaves absolute paths without a resolved field', () => {
    const result = splitTextByPaths('See /home/user/SG-1/lib/foo.ts here', project);
    expect(result).toEqual<PathSegment[]>([
      { type: 'text', value: 'See ' },
      { type: 'path', path: '/home/user/SG-1/lib/foo.ts' },
      { type: 'text', value: ' here' },
    ]);
  });

  it('falls back to plain text when relative path has no projectPath', () => {
    // No projectPath → resolver returns null → emit as plain text, not a chip.
    const result = splitTextByPaths('Edit lib/foo.ts please');
    expect(result).toEqual<PathSegment[]>([
      { type: 'text', value: 'Edit ' },
      { type: 'text', value: 'lib/foo.ts' },
      { type: 'text', value: ' please' },
    ]);
  });

  it('falls back to plain text when projectPath is empty string', () => {
    const result = splitTextByPaths('Edit lib/foo.ts please', '');
    expect(result).toEqual<PathSegment[]>([
      { type: 'text', value: 'Edit ' },
      { type: 'text', value: 'lib/foo.ts' },
      { type: 'text', value: ' please' },
    ]);
  });

  it('falls back to plain text when relative path attempts traversal', () => {
    // `lib/...` is detected by the dir-prefix branch; the resolver rejects it
    // because it escapes projectPath → no chip rendered, original text inline.
    const text = 'See lib/../../other/secret.ts now';
    const result = splitTextByPaths(text, project);
    const allText = result.filter(s => s.type === 'text').map(s => s.value).join('');
    expect(allText).toContain('See');
    expect(allText).toContain('secret');
    expect(result.some(s => s.type === 'path' && s.path.includes('secret'))).toBe(false);
  });

  it('mixes absolute and relative paths in the same message', () => {
    const result = splitTextByPaths(
      'See /home/user/SG-1/a.ts and components/X.tsx',
      project,
    );
    expect(result).toEqual<PathSegment[]>([
      { type: 'text', value: 'See ' },
      { type: 'path', path: '/home/user/SG-1/a.ts' },
      { type: 'text', value: ' and ' },
      {
        type: 'path',
        path: 'components/X.tsx',
        resolved: '/home/user/SG-1/components/X.tsx',
      },
    ]);
  });

  it('accepts null projectPath without throwing', () => {
    const result = splitTextByPaths('Edit lib/foo.ts please', null);
    expect(result).toEqual<PathSegment[]>([
      { type: 'text', value: 'Edit ' },
      { type: 'text', value: 'lib/foo.ts' },
      { type: 'text', value: ' please' },
    ]);
  });

  it('emits multiple resolved relative paths in one message', () => {
    const result = splitTextByPaths('Compare app/api/x.ts vs lib/y.ts', project);
    expect(result).toEqual<PathSegment[]>([
      { type: 'text', value: 'Compare ' },
      {
        type: 'path',
        path: 'app/api/x.ts',
        resolved: '/home/user/SG-1/app/api/x.ts',
      },
      { type: 'text', value: ' vs ' },
      {
        type: 'path',
        path: 'lib/y.ts',
        resolved: '/home/user/SG-1/lib/y.ts',
      },
    ]);
  });

  it('handles projectPath with trailing slash', () => {
    const result = splitTextByPaths('Edit lib/foo.ts', '/home/user/SG-1/');
    expect(result).toEqual<PathSegment[]>([
      { type: 'text', value: 'Edit ' },
      {
        type: 'path',
        path: 'lib/foo.ts',
        resolved: '/home/user/SG-1/lib/foo.ts',
      },
    ]);
  });
});
