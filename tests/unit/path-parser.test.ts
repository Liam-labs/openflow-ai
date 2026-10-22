/**
 * Unit tests for parsePathsInText — path detection in chat messages.
 * Sprint 37 P1-T1. Written TDD — RED first.
 */

import { describe, it, expect } from 'vitest';
import { parsePathsInText, type PathMatch } from '@/lib/path-parser';

// ─── Helper ──────────────────────────────────────────────────────────────────

function paths(text: string): string[] {
  return parsePathsInText(text).map((m) => m.path);
}

// ─── Happy-path detection ────────────────────────────────────────────────────

describe('parsePathsInText — happy path', () => {
  it('detects a simple /home path', () => {
    expect(paths('Check /home/tester/DevFlow/lib/foo.ts for details')).toEqual([
      '/home/tester/DevFlow/lib/foo.ts',
    ]);
  });

  it('detects a /mnt/c Windows-mapped path', () => {
    expect(paths('Open /mnt/c/Users/wuser/Documents/report.pdf')).toEqual([
      '/mnt/c/Users/wuser/Documents/report.pdf',
    ]);
  });

  it('detects /tmp paths', () => {
    expect(paths('Wrote to /tmp/scratch/output.log')).toEqual([
      '/tmp/scratch/output.log',
    ]);
  });

  it('detects /opt paths', () => {
    expect(paths('Installed at /opt/homebrew/bin/node')).toEqual([
      '/opt/homebrew/bin/node',
    ]);
  });

  it('detects /var/log paths', () => {
    expect(paths('Check /var/log/syslog for errors')).toEqual([
      '/var/log/syslog',
    ]);
  });

  it('detects /etc paths', () => {
    expect(paths('Config at /etc/nginx/nginx.conf')).toEqual([
      '/etc/nginx/nginx.conf',
    ]);
  });

  it('detects multiple paths in one message', () => {
    const result = paths(
      'Copy /home/tester/SG-1/plan.md to /mnt/c/Users/wuser/Desktop/plan.md'
    );
    expect(result).toEqual([
      '/home/tester/SG-1/plan.md',
      '/mnt/c/Users/wuser/Desktop/plan.md',
    ]);
  });

  it('detects a path at the start of the message', () => {
    expect(paths('/home/tester/DevFlow/package.json has the version')).toEqual([
      '/home/tester/DevFlow/package.json',
    ]);
  });

  it('detects a path at the end of the message', () => {
    expect(paths('See /home/tester/SG-1/README.md')).toEqual([
      '/home/tester/SG-1/README.md',
    ]);
  });

  it('handles paths with hyphens and dots in segments', () => {
    expect(
      paths('File at /home/tester/.DevData/docs/my-project/v2.1/notes.md')
    ).toEqual(['/home/tester/.DevData/docs/my-project/v2.1/notes.md']);
  });

  it('returns start and end offsets', () => {
    const text = 'See /home/tester/test.ts for info';
    const matches = parsePathsInText(text);
    expect(matches).toHaveLength(1);
    expect(matches[0].start).toBe(4);
    expect(matches[0].end).toBe(24);
    expect(text.slice(matches[0].start, matches[0].end)).toBe(
      '/home/tester/test.ts'
    );
  });
});

// ─── Trailing punctuation stripping ─────────────────────────────────────────

describe('parsePathsInText — trailing punctuation', () => {
  it('strips trailing period', () => {
    expect(paths('See /home/tester/DevFlow/lib/foo.ts.')).toEqual([
      '/home/tester/DevFlow/lib/foo.ts',
    ]);
  });

  it('strips trailing comma', () => {
    expect(paths('Files at /home/tester/SG-1/plan.md, check it')).toEqual([
      '/home/tester/SG-1/plan.md',
    ]);
  });

  it('strips trailing colon', () => {
    expect(paths('Config: /etc/nginx/nginx.conf:')).toEqual([
      '/etc/nginx/nginx.conf',
    ]);
  });

  it('strips trailing semicolon', () => {
    expect(paths('Source /home/tester/DevFlow/lib/config.ts;')).toEqual([
      '/home/tester/DevFlow/lib/config.ts',
    ]);
  });

  it('strips trailing closing paren', () => {
    expect(paths('(see /home/tester/SG-1/plan.md)')).toEqual([
      '/home/tester/SG-1/plan.md',
    ]);
  });

  it('strips trailing closing bracket', () => {
    expect(paths('[ref: /var/log/syslog]')).toEqual(['/var/log/syslog']);
  });

  it('does not strip .ts or .md as trailing punctuation', () => {
    // Period is part of the extension — only strip if the period is NOT followed by word chars
    expect(paths('Edit /home/tester/DevFlow/lib/foo.ts now')).toEqual([
      '/home/tester/DevFlow/lib/foo.ts',
    ]);
  });
});

// ─── Code block exclusion ────────────────────────────────────────────────────

describe('parsePathsInText — code block exclusion', () => {
  it('ignores paths inside fenced code blocks', () => {
    const text = [
      'Before the block.',
      '```',
      'cat /home/tester/DevFlow/secret.ts',
      '```',
      'After the block.',
    ].join('\n');
    expect(paths(text)).toEqual([]);
  });

  it('ignores paths inside fenced code blocks with language tag', () => {
    const text = [
      '```bash',
      'ls /home/tester/SG-1/',
      '```',
    ].join('\n');
    expect(paths(text)).toEqual([]);
  });

  it('ignores paths inside inline code', () => {
    expect(paths('Run `cat /home/tester/test.ts` to see it')).toEqual([]);
  });

  it('detects paths outside inline code in the same message', () => {
    const text = 'Use `cat` on /home/tester/DevFlow/README.md';
    expect(paths(text)).toEqual(['/home/tester/DevFlow/README.md']);
  });

  it('handles multiple code fences correctly', () => {
    const text = [
      'Path /home/tester/SG-1/a.ts here.',
      '```',
      '/home/tester/hidden/b.ts',
      '```',
      'And /home/tester/SG-1/c.ts here.',
      '```',
      '/home/tester/hidden/d.ts',
      '```',
    ].join('\n');
    expect(paths(text)).toEqual([
      '/home/tester/SG-1/a.ts',
      '/home/tester/SG-1/c.ts',
    ]);
  });

  it('handles unbalanced fence (single opening) — treats rest as code', () => {
    const text = [
      'Path /home/tester/SG-1/visible.ts here.',
      '```',
      '/home/tester/hidden/inside.ts',
    ].join('\n');
    // After opening ``` without a close, everything is "inside"
    expect(paths(text)).toEqual(['/home/tester/SG-1/visible.ts']);
  });
});

// ─── False-positive rejection ────────────────────────────────────────────────

describe('parsePathsInText — false positives', () => {
  it('rejects URLs starting with http://', () => {
    expect(paths('Visit http://example.com/home/tester')).toEqual([]);
  });

  it('rejects URLs starting with https://', () => {
    expect(paths('Visit https://example.com/home/tester')).toEqual([]);
  });

  it('rejects file:// URLs', () => {
    expect(paths('Open file:///home/tester/DevFlow')).toEqual([]);
  });

  it('rejects paths preceded by a word char (not a boundary)', () => {
    // "a/home/foo" should NOT match — the / is part of a bigger token
    expect(paths('Check a/home/tester/test')).toEqual([]);
  });

  it('rejects glob patterns with *', () => {
    expect(paths('Run /home/tester/DevFlow/lib/*.ts')).toEqual([]);
  });

  it('rejects patterns with ?', () => {
    expect(paths('Match /home/tester/DevFlow/lib/?.ts')).toEqual([]);
  });

  it('rejects patterns with {', () => {
    expect(paths('Match /home/tester/DevFlow/{a,b}.ts')).toEqual([]);
  });

  it('rejects patterns with [', () => {
    expect(paths('Match /home/tester/DevFlow/[id]/page.tsx')).toEqual([]);
  });

  it('rejects bare roots without a path segment', () => {
    // "/home" alone is too vague — need at least /home/something
    expect(paths('Go home to /home and relax')).toEqual([]);
  });

  it('rejects bare /tmp without a segment', () => {
    expect(paths('Write to /tmp and check')).toEqual([]);
  });

  it('rejects bare /etc without a segment', () => {
    expect(paths('Check /etc carefully')).toEqual([]);
  });

  it('rejects numeric-looking paths like "5/10 from /home"', () => {
    // "5/10" should not trigger, and "/home" alone is bare
    expect(paths('Error rate is 5/10 from /home')).toEqual([]);
  });

  it('normalizes //wsl.localhost/ paths without emitting an inner duplicate', () => {
    expect(paths('See //wsl.localhost/Ubuntu/home/tester')).toEqual(['/home/tester']);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('parsePathsInText — edge cases', () => {
  it('returns empty array for empty string', () => {
    expect(parsePathsInText('')).toEqual([]);
  });

  it('returns empty array for text with no paths', () => {
    expect(parsePathsInText('Just a normal message with no paths')).toEqual([]);
  });

  it('handles paths with spaces around them', () => {
    expect(paths('  /home/tester/SG-1/plan.md  ')).toEqual([
      '/home/tester/SG-1/plan.md',
    ]);
  });

  it('handles path surrounded by parentheses', () => {
    expect(paths('(file: /home/tester/SG-1/README.md)')).toEqual([
      '/home/tester/SG-1/README.md',
    ]);
  });

  it('handles path in markdown bold', () => {
    expect(paths('Check **/home/tester/SG-1/plan.md** for details')).toEqual([
      '/home/tester/SG-1/plan.md',
    ]);
  });

  it('handles deeply nested path', () => {
    expect(
      paths('At /home/tester/DevFlow/data/central-knowledge-base/platform/devflow.md')
    ).toEqual([
      '/home/tester/DevFlow/data/central-knowledge-base/platform/devflow.md',
    ]);
  });

  it('handles path with dotfiles', () => {
    expect(paths('Config at /home/tester/.claude/rules/startup.md')).toEqual([
      '/home/tester/.claude/rules/startup.md',
    ]);
  });

  it('does not match /usr, /bin, /sbin as roots (not in allowlist)', () => {
    // These are system paths we don't want to turn into clickable chips
    expect(paths('Binary at /usr/bin/node')).toEqual([]);
    expect(paths('Binary at /bin/bash')).toEqual([]);
  });

  it('handles newlines between paths', () => {
    const text = '/home/tester/SG-1/a.ts\n/home/tester/SG-1/b.ts';
    expect(paths(text)).toEqual([
      '/home/tester/SG-1/a.ts',
      '/home/tester/SG-1/b.ts',
    ]);
  });

  it('handles /mnt/ with various drive letters', () => {
    expect(paths('Drive at /mnt/d/Games/save.dat')).toEqual([
      '/mnt/d/Games/save.dat',
    ]);
  });
});

// ─── Sprint 69 T1.1 — Relative path detection ───────────────────────────────

function relativeOnly(text: string): PathMatch[] {
  return parsePathsInText(text).filter(m => m.isRelative);
}

describe('parsePathsInText — relative paths (Sprint 69 T1.1)', () => {
  describe('dir-prefix matches', () => {
    it('detects scripts/foo.sh', () => {
      const r = relativeOnly('Run scripts/foo.sh and report');
      expect(r.map(m => m.path)).toEqual(['scripts/foo.sh']);
      expect(r[0].isRelative).toBe(true);
    });

    it('detects components/X.tsx', () => {
      expect(relativeOnly('Edit components/X.tsx').map(m => m.path)).toEqual([
        'components/X.tsx',
      ]);
    });

    it('detects app/api/route.ts (multi-segment)', () => {
      expect(relativeOnly('Look at app/api/route.ts').map(m => m.path)).toEqual([
        'app/api/route.ts',
      ]);
    });

    it('detects src/utils/helpers (no extension, dir prefix only)', () => {
      expect(relativeOnly('In src/utils/helpers we expose foo').map(m => m.path)).toEqual([
        'src/utils/helpers',
      ]);
    });

    it('detects public/assets/icon.png (extension not in list, dir prefix saves it)', () => {
      expect(relativeOnly('Add public/assets/icon.png to header').map(m => m.path)).toEqual([
        'public/assets/icon.png',
      ]);
    });

    it('detects tests/unit/path-parser.test.ts', () => {
      expect(relativeOnly('See tests/unit/path-parser.test.ts').map(m => m.path)).toEqual([
        'tests/unit/path-parser.test.ts',
      ]);
    });

    it('detects docs/api.md', () => {
      expect(relativeOnly('Update docs/api.md').map(m => m.path)).toEqual(['docs/api.md']);
    });

    it('detects data/expert-agents.json', () => {
      expect(relativeOnly('Edit data/expert-agents.json').map(m => m.path)).toEqual([
        'data/expert-agents.json',
      ]);
    });
  });

  describe('extension-based matches (no spaces)', () => {
    it('detects bare package.json', () => {
      expect(relativeOnly('Open package.json').map(m => m.path)).toEqual(['package.json']);
    });

    it('detects README.md', () => {
      expect(relativeOnly('see README.md').map(m => m.path)).toEqual(['README.md']);
    });

    it('detects lib/path-parser.ts', () => {
      // dir-prefix branch fires (lib/) — verify the match
      expect(relativeOnly('Edit lib/path-parser.ts').map(m => m.path)).toEqual([
        'lib/path-parser.ts',
      ]);
    });

    it('detects file.toml extension', () => {
      expect(relativeOnly('edit Cargo.toml').map(m => m.path)).toEqual(['Cargo.toml']);
    });

    it('detects .yml and .yaml extensions', () => {
      expect(relativeOnly('edit github/workflows/ci.yml then config.yaml').map(m => m.path)).toEqual([
        'github/workflows/ci.yml',
        'config.yaml',
      ]);
    });

    it('detects file.py and file.sh', () => {
      const r = relativeOnly('Run helper.py then build.sh');
      expect(r.map(m => m.path)).toEqual(['helper.py', 'build.sh']);
    });
  });

  describe('Title Case multi-word filenames', () => {
    it('detects Start SEO Engine.bat', () => {
      const r = relativeOnly('execute Start SEO Engine.bat to begin');
      expect(r.map(m => m.path)).toEqual(['Start SEO Engine.bat']);
      expect(r[0].isRelative).toBe(true);
    });

    it('detects Run Build.bat (2-word title case)', () => {
      expect(relativeOnly('execute Run Build.bat now').map(m => m.path)).toEqual([
        'Run Build.bat',
      ]);
    });

    it('does NOT match lowercased space-separated tokens', () => {
      // `start seo engine.bat` — would only match `engine.bat` via extension branch
      const r = relativeOnly('lowercase start seo engine.bat');
      expect(r.map(m => m.path)).toEqual(['engine.bat']);
    });
  });

  describe('negative — must NOT match', () => {
    it('rejects bare "scripts" with no slash and no extension', () => {
      expect(relativeOnly('I have scripts and configs')).toEqual([]);
    });

    it('rejects "scripts run" — two prose words, no slash', () => {
      expect(relativeOnly('the scripts run nightly')).toEqual([]);
    });

    it('rejects ".bat" with no leading filename', () => {
      expect(relativeOnly('the .bat extension is Windows')).toEqual([]);
    });

    it('rejects unknown extensions like .pdf alone', () => {
      // .pdf is not in the extension list AND there's no dir prefix
      expect(relativeOnly('the report.pdf is here')).toEqual([]);
    });

    it('rejects extension-only words inside larger tokens', () => {
      // `mytest.ts` at start of `mytest.tsbig` shouldn't match
      expect(relativeOnly('xyzmytest.tsbiggertest')).toEqual([]);
    });

    it('rejects plain prose with no path-like tokens', () => {
      expect(relativeOnly('I think this works fine')).toEqual([]);
    });

    it('rejects relative paths inside fenced code blocks', () => {
      const text = 'Here:\n```ts\nscripts/foo.sh\n```\nSee?';
      expect(relativeOnly(text)).toEqual([]);
    });

    it('rejects relative paths inside inline code', () => {
      expect(relativeOnly('the `scripts/foo.sh` command')).toEqual([]);
    });
  });

  describe('flag and absolute-path coexistence', () => {
    it('marks absolute paths with isRelative falsy', () => {
      const r = parsePathsInText('Open /home/tester/DevFlow/lib/foo.ts');
      expect(r).toHaveLength(1);
      expect(r[0].isRelative).toBeFalsy();
    });

    it('marks relative paths with isRelative=true', () => {
      const r = parsePathsInText('Open scripts/foo.sh');
      expect(r).toHaveLength(1);
      expect(r[0].isRelative).toBe(true);
    });

    it('emits both kinds in the same message, sorted by start', () => {
      const text = 'See /home/tester/SG-1/a.ts then components/X.tsx then /tmp/b.log';
      const r = parsePathsInText(text);
      expect(r.map(m => m.path)).toEqual([
        '/home/tester/SG-1/a.ts',
        'components/X.tsx',
        '/tmp/b.log',
      ]);
      expect(r[0].isRelative).toBeFalsy();
      expect(r[1].isRelative).toBe(true);
      expect(r[2].isRelative).toBeFalsy();
    });

    it('does NOT double-detect a relative segment inside an already-matched absolute path', () => {
      // /home/tester/DevFlow/lib/foo.ts — `lib/foo.ts` would match relative branch too.
      // Suppression must keep only the absolute match.
      const r = parsePathsInText('Edit /home/tester/DevFlow/lib/foo.ts');
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe('/home/tester/DevFlow/lib/foo.ts');
      expect(r[0].isRelative).toBeFalsy();
    });

    it('does NOT match the same relative path twice across branches', () => {
      // app/api/route.ts: dir-prefix branch and ext-nospace branch could both fire.
      const r = parsePathsInText('Edit app/api/route.ts');
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe('app/api/route.ts');
    });
  });

  describe('boundary handling', () => {
    it('strips trailing punctuation from relative matches', () => {
      const r = relativeOnly('Files: components/A.tsx, components/B.tsx.');
      expect(r.map(m => m.path)).toEqual(['components/A.tsx', 'components/B.tsx']);
    });

    it('handles relative path at end of string', () => {
      expect(relativeOnly('the file is package.json').map(m => m.path)).toEqual(['package.json']);
    });

    it('handles relative path at start of string', () => {
      expect(relativeOnly('package.json is the manifest').map(m => m.path)).toEqual(['package.json']);
    });

    it('handles parentheses around a relative path', () => {
      expect(relativeOnly('see file (lib/foo.ts) for details').map(m => m.path)).toEqual([
        'lib/foo.ts',
      ]);
    });
  });
});
