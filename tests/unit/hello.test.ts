import { describe, it, expect } from 'vitest';

describe('Vitest setup', () => {
  it('runs a hello-world test', () => {
    expect(1 + 1).toBe(2);
  });

  it('resolves @/* path aliases', async () => {
    // Importing from lib via alias verifies vite-tsconfig-paths is working
    const { fetchWithTimeout } = await import('@/lib/fetch-utils');
    expect(typeof fetchWithTimeout).toBe('function');
  });
});
