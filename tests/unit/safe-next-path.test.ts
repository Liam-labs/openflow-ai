import { describe, it, expect } from 'vitest';
import { safeNextPath } from '@/lib/safe-next-path';

describe('safeNextPath', () => {
  it.each(['/\t/evil.example', '/\n/evil.example', '/\\evil.example', '/path\\elsewhere'])('rejects browser-normalized unsafe path %j', (p) => expect(safeNextPath(p)).toBe('/'));
  it.each([['/'], ['/collab'], ['/a/b?c=d#e']])('keeps %s', (p) => expect(safeNextPath(p)).toBe(p));
  it.each([[null], [undefined], [''], ['//evil.example'], ['https://evil.example'], ['/\\evil.example'], ['javascript:alert(1)'], ['/ok\r\nSet-Cookie: x=1'], ['evil']])('turns %j into /', (p) => expect(safeNextPath(p as string | null)).toBe('/'));
});
