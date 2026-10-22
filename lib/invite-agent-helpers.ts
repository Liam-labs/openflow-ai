/**
 * Pure helpers for the InviteAgentPicker component.
 * Extracted for testability — no React/DOM dependencies.
 */

export interface PickerSession {
  pid: number;
  displayName: string;
  capabilities: string[];
  collabReady: boolean;
}

export interface CapabilityGroup {
  label: string;
  sessions: PickerSession[];
}

/**
 * Filter sessions by exclusion list and optional keyword query.
 * Query matches displayName or any capability token (case-insensitive).
 */
export function filterPickerSessions(
  sessions: PickerSession[],
  query: string,
  excludeNames: string[]
): PickerSession[] {
  const excludeSet = new Set(excludeNames);
  const q = query.trim().toLowerCase();

  return sessions.filter(s => {
    if (excludeSet.has(s.displayName)) return false;
    if (!q) return true;
    if (s.displayName.toLowerCase().includes(q)) return true;
    return s.capabilities.some(c => c.toLowerCase().includes(q));
  });
}

/**
 * Group sessions by their first capability token.
 * Sessions with no capabilities land in "General".
 */
export function groupSessionsByCapability(sessions: PickerSession[]): CapabilityGroup[] {
  if (sessions.length === 0) return [];

  const map = new Map<string, PickerSession[]>();
  for (const s of sessions) {
    const label = s.capabilities[0] ?? 'General';
    const existing = map.get(label);
    if (existing) {
      existing.push(s);
    } else {
      map.set(label, [s]);
    }
  }

  return Array.from(map.entries()).map(([label, grpSessions]) => ({
    label,
    sessions: grpSessions,
  }));
}
