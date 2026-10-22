/**
 * Tests for S2.2 — supabase navTarget resolver.
 *
 * ServiceAlertsPanel emits navTargets with `entityId` = the backup-script slug
 * (derived from the instance name). SupabaseSection's resolver must match
 * either the real instance UUID or the slug, so the alert click lands on the
 * right instance regardless of which form was passed.
 */

import { describe, it, expect } from 'vitest';
import {
  supabaseInstanceSlug,
  resolveSupabaseInstanceToken,
} from '@/components/systems/SupabaseSection';

describe('supabaseInstanceSlug', () => {
  it('lowercases a simple name', () => {
    expect(supabaseInstanceSlug('BnG-CRM')).toBe('bng-crm');
  });

  it('replaces spaces with dashes', () => {
    expect(supabaseInstanceSlug('Local Development')).toBe('local-development');
  });

  it('strips characters outside a-z0-9- (matches the shell script)', () => {
    expect(supabaseInstanceSlug("Pete's SEO Tool!")).toBe('petes-seo-tool');
    expect(supabaseInstanceSlug('Acme.co.uk')).toBe('acmecouk');
    expect(supabaseInstanceSlug('wind-turbine-tracker')).toBe('wind-turbine-tracker');
  });

  it('handles all-uppercase and mixed punctuation', () => {
    expect(supabaseInstanceSlug('BnG_CRM & Co.')).toBe('bngcrm--co');
  });

  it('returns empty string for empty input', () => {
    expect(supabaseInstanceSlug('')).toBe('');
  });
});

describe('resolveSupabaseInstanceToken', () => {
  const instances = [
    { id: '81090279-95d9-44ec-9105-b9850e961413', name: 'Local Development' },
    { id: '31371924-e4fe-4205-9437-656ba3d3c5c9', name: 'BnG-CRM' },
    { id: 'c1e77abb-e25f-4d68-98b4-748bee98da52', name: 'seoengine-local' },
  ];

  it('resolves an exact UUID match', () => {
    expect(resolveSupabaseInstanceToken(instances, '31371924-e4fe-4205-9437-656ba3d3c5c9'))
      .toBe('31371924-e4fe-4205-9437-656ba3d3c5c9');
  });

  it('resolves a slug derived from the name', () => {
    expect(resolveSupabaseInstanceToken(instances, 'bng-crm'))
      .toBe('31371924-e4fe-4205-9437-656ba3d3c5c9');
  });

  it('resolves a slug with internal dashes preserved', () => {
    expect(resolveSupabaseInstanceToken(instances, 'local-development'))
      .toBe('81090279-95d9-44ec-9105-b9850e961413');
  });

  it('resolves a slug that is already in slug form (dashes, lowercase)', () => {
    expect(resolveSupabaseInstanceToken(instances, 'seoengine-local'))
      .toBe('c1e77abb-e25f-4d68-98b4-748bee98da52');
  });

  it('returns null for an unknown token', () => {
    expect(resolveSupabaseInstanceToken(instances, 'nonexistent-instance')).toBeNull();
  });

  it('returns null for an empty token', () => {
    expect(resolveSupabaseInstanceToken(instances, '')).toBeNull();
  });

  it('returns null when the instance list is empty', () => {
    expect(resolveSupabaseInstanceToken([], 'bng-crm')).toBeNull();
  });

  it('prefers exact UUID match over slug match (UUID-shaped slugs are safe)', () => {
    const mixed = [
      { id: 'bng-crm', name: 'Real BnG-CRM Instance' },
      { id: 'real-uuid', name: 'BnG-CRM' },
    ];
    // 'bng-crm' matches BOTH: the id of the first entry AND the slug of the second.
    // The function should prefer exact id match (first entry).
    expect(resolveSupabaseInstanceToken(mixed, 'bng-crm')).toBe('bng-crm');
  });

  it('matches slug derivation that mirrors the shell script exactly', () => {
    // Ensures the TS slug function and the bash `tr` pipeline produce identical output
    const name = 'Acme.co.uk';
    const slug = supabaseInstanceSlug(name);
    // The shell script: tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-'
    // 'Acme.co.uk' → 'acme.co.uk' → 'acme.co.uk' → 'acmecouk'
    expect(slug).toBe('acmecouk');
    const instancesWithNoble = [{ id: 'noble-uuid', name: 'Acme.co.uk' }];
    expect(resolveSupabaseInstanceToken(instancesWithNoble, slug)).toBe('noble-uuid');
  });
});
