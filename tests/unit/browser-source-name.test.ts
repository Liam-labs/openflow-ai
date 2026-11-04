import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PRODUCT_NAME } from '@/lib/brand';

/** The participant picker shows each person's source. A new install must not show another product's name there. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('the browser participant source name', () => {
  it('is built from the product name, and no app, component or lib file hard-codes another product\'s name', () => {
    const offenders = ['app', 'components', 'lib'].flatMap((d) => sourceFiles(d)).filter((f) => readFileSync(f, 'utf-8').includes('DevFlow Browser'));
    expect(offenders).toEqual([]);
    expect(`${PRODUCT_NAME} Browser`).toBe('OpenFlow Browser');
  });
});
