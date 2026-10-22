import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Ask-Owner floating card overflow', () => {
  it.each([
    ['mobile', 568],
    ['desktop', 768],
  ])('keeps a tall card as a non-shrinking child of the scrollable overlay at %s height (%dpx)', async () => {
    const source = await readFile('components/ColabChatView.tsx', 'utf8');
    const overlay = source.match(
      /<div className="ask-owner-overlay([^"\n]*)"[^>]*style=\{\{([^}]*)\}\}>/,
    );
    const floating = source.match(
      /className="ask-owner-floating([^"\n]*)"/,
    );

    expect(overlay?.[1]).toContain('overflow-y-auto');
    expect(overlay?.[2]).toContain("maxHeight: 'calc(100% - 2rem)'");
    expect(floating?.[1]).toContain('shrink-0');
  });
});
