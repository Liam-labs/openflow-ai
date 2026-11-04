import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const script = path.resolve(__dirname, '../../scripts/check-kb.py');
const docsScript = path.resolve(__dirname, '../../scripts/check-public-docs.py');
const PAGE = ['What it does', 'Why you would want it', 'What it needs', 'How to set it up', 'How to tell it is working'].map((h) => `## ${h}\n\nText.\n`).join('\n');
let root: string;

function run(args: string[] = [], file = script) {
  return spawnSync('python3', ['-I', file, ...args], { env: { ...process.env, DOCS_CHECK_ROOT: root }, encoding: 'utf8' });
}
function write(rel: string, text: string) { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); }
const feature = (extra = {}) => JSON.stringify([{ id: 'memory', title: 'Memory', page: 'kb/memory.md', paths: ['lib/wizards/memory.ts'], ...extra }]);

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'kbcheck-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('KB check', () => {
  it('passes with no registry', () => { expect(run().status).toBe(0); });
  it('passes when every feature has a complete page', () => {
    write('kb/features.json', feature()); write('kb/memory.md', '# Memory\n\n' + PAGE);
    expect(run().status).toBe(0);
  });
  it('fails a shipped feature with no page, and only warns with --warn-only', () => {
    write('kb/features.json', feature());
    const r = run(); expect(r.status).toBe(1); expect(r.stdout).toContain('no knowledge-base page');
    const w = run(['--warn-only']); expect(w.status).toBe(0); expect(w.stdout).toContain('::warning::');
  });
  it('fails a page that lacks the fixed headings', () => {
    write('kb/features.json', feature()); write('kb/memory.md', '# Memory\n\n## What it does\n');
    const r = run(); expect(r.status).toBe(1); expect(r.stdout).toContain('missing the heading');
  });
  it('refuses a page outside kb/', () => {
    write('kb/features.json', feature({ page: '../outside.md' }));
    expect(run().status).toBe(1);
  });
});

describe('KB check on a change', () => {
  function git(...a: string[]) { return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf8' }); }
  it('wants the page updated when the feature code changed, and accepts it when it was', () => {
    write('kb/features.json', feature()); write('kb/memory.md', '# Memory\n\n' + PAGE); write('lib/wizards/memory.ts', 'a');
    git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'base');
    write('lib/wizards/memory.ts', 'b'); git('commit', '-qam', 'code only');
    const bad = run(['--changed', 'HEAD~1', 'HEAD']); expect(bad.status).toBe(1); expect(bad.stdout).toContain('did not');
    write('kb/memory.md', '# Memory\n\n' + PAGE + '\nMore.\n'); git('commit', '-qam', 'page');
    expect(run(['--changed', 'HEAD~2', 'HEAD']).status).toBe(0);
  });
});

describe('public docs check covers kb/', () => {
  it('flags a private string inside a kb page', () => {
    write('kb/leak.md', '# Leak\n\nContact liam@airframemedia.co.uk for help.\n');
    const r = run([], docsScript); expect(r.status).toBe(1); expect(r.stdout).toContain('kb/leak.md');
  });
});
