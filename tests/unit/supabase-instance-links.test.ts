import { describe, expect, it } from 'vitest';
import {
  getSupabaseAuthUsersUrl,
  getSupabaseStudioUrl,
} from '@/lib/supabase-instance-links';
import type { SupabaseInstance } from '@/lib/supabase-types';

function localInstance(
  url: string,
  portMap?: SupabaseInstance['portMap'],
): SupabaseInstance {
  return {
    id: 'local-instance',
    name: 'Local instance',
    type: 'local',
    connection: {
      url,
      anonKeyEnvVar: 'SUPABASE_LOCAL_ANON_KEY',
      serviceRoleKeyEnvVar: 'SUPABASE_LOCAL_SERVICE_ROLE_KEY',
    },
    linkedProjects: [],
    status: 'online',
    lastCheckedAt: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    portMap,
  };
}

describe('Supabase instance links', () => {
  it('routes Emails-and-Marketing to its selected local Studio', () => {
    const instance = localInstance('http://127.0.0.1:54361');

    expect(getSupabaseStudioUrl(instance)).toBe('http://127.0.0.1:54363');
    expect(getSupabaseAuthUsersUrl(instance)).toBe(
      'http://127.0.0.1:54363/project/default/auth/users',
    );
  });

  it('keeps ACME Payment Portal on its own local Studio', () => {
    const instance = localInstance('http://localhost:54321');

    expect(getSupabaseStudioUrl(instance)).toBe('http://localhost:54323');
  });

  it('prefers an explicit Studio port over the conventional API-plus-two fallback', () => {
    const instance = localInstance('http://127.0.0.1:61000', {
      api: 61000,
      db: 62000,
      studio: 63000,
    });

    expect(getSupabaseStudioUrl(instance)).toBe('http://127.0.0.1:63000');
  });

  it('routes hosted projects to the Supabase dashboard', () => {
    const instance: SupabaseInstance = {
      ...localInstance('https://project-ref.supabase.co'),
      type: 'hosted',
      connection: {
        url: 'https://project-ref.supabase.co',
        anonKeyEnvVar: 'SUPABASE_PUBLISHABLE_KEY',
        serviceRoleKeyEnvVar: 'SUPABASE_SECRET_KEY',
        projectId: 'project-ref',
      },
    };

    expect(getSupabaseStudioUrl(instance)).toBe(
      'https://supabase.com/dashboard/project/project-ref',
    );
    expect(getSupabaseAuthUsersUrl(instance)).toBe(
      'https://supabase.com/dashboard/project/project-ref/auth/users',
    );
  });
});
