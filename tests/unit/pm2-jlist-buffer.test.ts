import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('PM2 jlist subprocess buffer', () => {
  it('uses the shared enlarged buffer for every host-bridge PM2 list read', async () => {
    const source = await readFile('lib/host-bridge/client.ts', 'utf8');
    const calls = source.match(/execAsync\('pm2 jlist',[\s\S]*?\);/g) ?? [];

    expect(source).toContain('const PM2_JLIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024');
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.includes('maxBuffer: PM2_JLIST_MAX_BUFFER_BYTES'))).toBe(true);
  });
});
