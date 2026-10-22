/**
 * Resolves the display label for an agent's current activity.
 *
 * When `activityDetail` is present (from the granular status pipeline),
 * use it directly ("Reading file...", "Editing...", etc.).
 * Otherwise fall back to the generic "Working..." label.
 *
 * Returns null when the agent is not actively working (no typing entry).
 */
export function resolveActivityLabel(
  activityDetail: string | null | undefined,
  isWorking: boolean,
): string | null {
  if (!isWorking) return null;
  if (activityDetail) return activityDetail;
  return 'Working...';
}
