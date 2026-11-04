import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import postcss from 'postcss';
import { THEMES } from '@/lib/contexts/ThemeContext';

const css = readFileSync('app/globals.css', 'utf-8');
const root = postcss.parse(css);
const marker = root.nodes.find((n) => n.type === 'comment' && /THEMES: Light and Dark Orange/.test((n as postcss.Comment).text));

describe('theme styles', () => {
  it('has a block for every theme the account menu offers', () => {
    for (const t of THEMES.filter((x) => x.id !== 'default')) {
      expect(css, `no [data-theme="${t.id}"] block`).toContain(`[data-theme="${t.id}"]`);
    }
  });

  it('colours text and background together in the Light theme (dark text on a light page)', () => {
    let bg = '', text = '';
    root.walkRules((r) => { if (r.selector.trim() === '[data-theme="light"]') r.walkDecls((d) => { if (d.prop === '--df-bg') bg = d.value; if (d.prop === '--df-text') text = d.value; }); });
    expect(bg).toMatch(/^#f/i);
    expect(text).toMatch(/^#[01]/);
  });

  it('only touches the page when a theme is chosen: every rule added in the themes section names a data-theme', () => {
    expect(marker).toBeTruthy();
    const after = root.nodes.slice(root.nodes.indexOf(marker!) + 1);
    expect(after.length).toBeGreaterThan(20);
    for (const node of after) {
      const selectors: string[] = [];
      if (node.type === 'rule') selectors.push((node as postcss.Rule).selector);
      if (node.type === 'atrule') (node as postcss.AtRule).walkRules((r) => { selectors.push(r.selector); });
      for (const s of selectors) expect(s, 'a theme rule without [data-theme]').toMatch(/\[data-theme/);
    }
  });

  it('carries nothing private: no host names, accounts or personal strings', () => {
    const section = css.slice(css.indexOf('THEMES: Light and Dark Orange'));
    expect(section).not.toMatch(/zazool|airframe|liam|sg-1|\.ts\.net|localhost/i);
  });

  it('keeps the dark Midnight Glass areas readable on a light page: the Set up more panel stays dark and the dialog gets white text back', () => {
    const cards = readFileSync('app/setup-cards.css', 'utf-8');
    expect(cards).toMatch(/\[data-theme="light"\] \.sc\.mg-scope\{background:var\(--bg\)/);
    expect(cards).toMatch(/\[data-theme="light"\] \.sc-dialog \.text-white\{color:#fff !important\}/);
  });
});
