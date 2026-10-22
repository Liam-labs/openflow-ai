import type { SupabaseInstance } from '@/lib/supabase-types';

const DEFAULT_LOCAL_STUDIO_PORT = 54323;

function localStudioOrigin(instance: SupabaseInstance): string {
  const explicitStudioPort = instance.portMap?.studio;

  try {
    const apiUrl = new URL(instance.connection.url);
    const apiPort = Number.parseInt(apiUrl.port, 10);
    const derivedStudioPort = Number.isInteger(apiPort) && apiPort > 0
      ? apiPort + 2
      : DEFAULT_LOCAL_STUDIO_PORT;
    apiUrl.port = String(explicitStudioPort ?? derivedStudioPort);
    apiUrl.pathname = '/';
    apiUrl.search = '';
    apiUrl.hash = '';
    return apiUrl.origin;
  } catch {
    return `http://localhost:${explicitStudioPort ?? DEFAULT_LOCAL_STUDIO_PORT}`;
  }
}

export function getSupabaseStudioUrl(instance: SupabaseInstance): string {
  if (instance.type === 'local') return localStudioOrigin(instance);

  const projectRef = instance.connection.projectId;
  return projectRef
    ? `https://supabase.com/dashboard/project/${encodeURIComponent(projectRef)}`
    : 'https://supabase.com/dashboard';
}

export function getSupabaseAuthUsersUrl(instance: SupabaseInstance): string {
  const studioUrl = getSupabaseStudioUrl(instance);
  return instance.type === 'local'
    ? `${studioUrl}/project/default/auth/users`
    : instance.connection.projectId
      ? `${studioUrl}/auth/users`
      : studioUrl;
}
