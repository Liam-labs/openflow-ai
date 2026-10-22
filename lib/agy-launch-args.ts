import { resolveApiIdForModel } from '@/lib/model-registry';

/**
 * Arguments for scripts/agy-launch.sh (the Antigravity two-pane spawn).
 *
 * The model goes through the registry first. `agy` rejects an id it no longer offers ("model gemini-3.5-flash is not recognized as a known
 * model"), and persisted roster records can still hold one: the registry keeps retired ids as `aliases` of their successor, and
 * `resolveApiIdForModel` turns them into the profile `agy` accepts. Without this a stopped agent on a retired id could never be started again.
 * `resolveModel` is a parameter only so a test can supply a fake registry.
 */
export function agyLaunchArgs(
  a: {
    launchScript: string;
    name: string;
    channelId: string;
    workDir: string;
    tmuxSession: string;
    model?: string | null;
    effort?: string | null;
  },
  resolveModel: (id: string) => string = resolveApiIdForModel,
): string[] {
  const effort = a.effort && ['low', 'medium', 'high'].includes(a.effort) ? a.effort : '';
  return [
    'bash', a.launchScript,
    `"${a.name}"`, `"${a.channelId}"`, `"${a.workDir}"`, `"${a.tmuxSession}"`,
    `"${a.model ? resolveModel(a.model) : ''}"`,
    `"${effort}"`,
  ];
}
