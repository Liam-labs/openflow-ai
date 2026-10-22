import { describe, it, expect } from 'vitest';
import { detectCodeSnippet } from '@/lib/code-detect';

describe('detectCodeSnippet — prose is never code (non-destructive guard)', () => {
  it('rejects a normal chat sentence', () => {
    const r = detectCodeSnippet(
      'Hey team, can you review the parser changes when you get a chance? Thanks.',
    );
    expect(r.isCode).toBe(false);
    expect(r.language).toBeNull();
  });

  it('rejects a short acknowledgement', () => {
    expect(detectCodeSnippet('ok thanks').isCode).toBe(false);
  });

  it('rejects a prose line that contains a colon', () => {
    expect(detectCodeSnippet('Note: the build passed earlier today.').isCode).toBe(false);
  });

  it('rejects an empty / whitespace string', () => {
    expect(detectCodeSnippet('   \n  ').isCode).toBe(false);
  });
});

describe('detectCodeSnippet — language identification', () => {
  it('detects JSON', () => {
    const r = detectCodeSnippet('{\n  "name": "daniel",\n  "role": "frontend"\n}');
    expect(r.isCode).toBe(true);
    expect(r.language).toBe('json');
  });

  it('detects Python', () => {
    const r = detectCodeSnippet("def greet(name):\n    print(f'hi {name}')");
    expect(r.isCode).toBe(true);
    expect(r.language).toBe('python');
  });

  it('detects JavaScript', () => {
    const r = detectCodeSnippet('const x = 1;\nfunction add(a, b) {\n  return a + b;\n}');
    expect(r.isCode).toBe(true);
    expect(r.language).toBe('javascript');
  });

  it('detects TypeScript via type annotations', () => {
    const r = detectCodeSnippet(
      'interface Props {\n  name: string;\n}\nconst f = (p: Props): void => {};',
    );
    expect(r.isCode).toBe(true);
    expect(r.language).toBe('typescript');
  });

  it('detects HTML', () => {
    const r = detectCodeSnippet('<div class="card">\n  <span>Hi</span>\n</div>');
    expect(r.isCode).toBe(true);
    expect(r.language).toBe('html');
  });

  it('detects a shell command block', () => {
    const r = detectCodeSnippet('cd /home/user/DevFlow\nnpm run build && pm2 restart devflow');
    expect(r.isCode).toBe(true);
    expect(r.language).toBe('bash');
  });

  it('detects SQL', () => {
    const r = detectCodeSnippet('SELECT id, name FROM users WHERE active = 1;');
    expect(r.isCode).toBe(true);
    expect(r.language).toBe('sql');
  });
});

describe('detectCodeSnippet — already-fenced content is left alone', () => {
  it('reports already-fenced code so callers can skip re-wrapping', () => {
    const r = detectCodeSnippet('```js\nconst x = 1;\n```');
    expect(r.alreadyFenced).toBe(true);
  });
});
