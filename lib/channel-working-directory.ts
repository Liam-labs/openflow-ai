
import { getHomeDir } from '@/lib/home-dir';/**
 * Resolve the project root used as the default for new roster agents.
 *
 * New channels persist both projectId and projectPath. The registry lookup is
 * retained for older channels that have only projectId, while the final home
 * fallback keeps legacy unlinked channels usable.
 */
export function resolveChannelWorkingDirectory(
  channel: { projectId?: string; projectPath?: string } | null | undefined,
  projects: ReadonlyArray<{ id: string; path: string }>,
  fallback = getHomeDir(),
): string {
  const explicitPath = channel?.projectPath?.trim();
  if (explicitPath) return explicitPath;

  if (channel?.projectId) {
    const linkedPath = projects.find(project => project.id === channel.projectId)?.path?.trim();
    if (linkedPath) return linkedPath;
  }

  return fallback;
}
