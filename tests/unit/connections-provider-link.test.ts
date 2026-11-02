import { describe, expect, it } from 'vitest';
import { keyProvider, resumeDestination } from '../../components/systems/connections/provider-link';

const query = (returnTo: string, resume = 'knowledge-update') => new URLSearchParams({ returnTo, resume }).toString();

describe('Connections return trip', () => {
  it('preserves the page, query and hash while replacing the resume feature', () => {
    expect(resumeDestination(query('/operations?tab=kb&resume=old#settings')))
      .toBe('/operations?tab=kb&resume=knowledge-update#settings');
  });
  it.each(['https://elsewhere.invalid', '//elsewhere.invalid', '/\\elsewhere.invalid', '/\n/elsewhere.invalid', 'javascript:alert(1)', 'relative', '/a/..//elsewhere.invalid'])('refuses external or malformed destinations: %s', path => {
    expect(resumeDestination(query(path))).toBeNull();
  });
  it('requires a destination and does not forward an invalid feature id', () => {
    expect(resumeDestination('?resume=overwatch')).toBeNull();
    expect(resumeDestination(query('/operations#settings', 'bad/id'))).toBe('/operations#settings');
  });
  it('uses only supported API-key providers', () => {
    expect(keyProvider('deepseek')?.secretName).toBe('DEEPSEEK_API_KEY');
    expect(keyProvider('ollama')).toBeUndefined();
    expect(keyProvider('unknown')).toBeUndefined();
  });
});
