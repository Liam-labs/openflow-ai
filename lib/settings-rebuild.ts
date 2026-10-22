/**
 * Triggers a DevFlow rebuild via the settings API.
 * Fire-and-forget: PM2 restart disconnects the page;
 * the existing SSE restart signal handles the reconnect.
 */
export async function triggerRebuild(): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch('/api/settings/rebuild', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      return { success: true, message: 'Build started' };
    }
    return { success: false, message: (data as any).error || 'Rebuild failed' };
  } catch {
    return { success: false, message: 'Request failed' };
  }
}
