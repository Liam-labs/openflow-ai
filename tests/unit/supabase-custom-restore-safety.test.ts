import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PG_RESTORE_ARGS,
  validateCustomArchiveCatalog,
} from '@/lib/supabase-custom-restore';

describe('custom Supabase restore safety contract', () => {
  it('uses an atomic, fail-fast pg_restore invocation', () => {
    expect(CUSTOM_PG_RESTORE_ARGS).toEqual(expect.arrayContaining([
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      '--single-transaction',
    ]));
  });

  it('accepts a catalog with meaningful non-system table data', () => {
    expect(() => validateCustomArchiveCatalog(
      '1234; 0 16400 TABLE DATA public customers postgres\n',
    )).not.toThrow();
  });

  it('rejects schema-only and system-only custom archives', () => {
    expect(() => validateCustomArchiveCatalog(
      '1234; 0 16400 TABLE public customers postgres\n',
    )).toThrow(/TABLE DATA/);
    expect(() => validateCustomArchiveCatalog(
      '1234; 0 16400 TABLE DATA pg_catalog pg_stat postgres\n',
    )).toThrow(/non-system schema/);
  });
});
