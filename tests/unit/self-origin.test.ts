import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { selfOrigin } from '@/lib/self-origin';

describe('selfOrigin', () => {
  it('uses the app port and defaults to 3000', () => {
    expect(selfOrigin({ PORT: '3277' })).toBe('http://127.0.0.1:3277');
    expect(selfOrigin({})).toBe('http://127.0.0.1:3000');
  });
  it('ignores a PORT that is not a plain number', () => {
    for (const bad of ['', 'abc', '3000/evil', '3000;rm', '12345678', '-1', ' 3000']) {
      expect(selfOrigin({ PORT: bad })).toBe('http://127.0.0.1:3000');
    }
  });
});

describe('server code does not call itself on a fixed port 3000', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'tests') walk(p, out); }
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }
  it('no fetch( or request to http://localhost:3000 in app/ lib/ slack-integration/ teams-integration/', () => {
    const root = path.resolve(__dirname, '..', '..');
    const offenders: string[] = [];
    for (const dir of ['app', 'lib', 'slack-integration', 'teams-integration']) {
      let files: string[] = [];
      try { files = walk(path.join(root, dir)); } catch { continue; }
      for (const f of files) {
        readFileSync(f, 'utf-8').split('\n').forEach((line, i) => {
          if (/fetch\(\s*[`'"]http:\/\/localhost:3000/.test(line)) offenders.push(`${path.relative(root, f)}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
