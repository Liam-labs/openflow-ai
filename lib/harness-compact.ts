// The slash command that makes each agent harness compact (shrink) its context.
// null = we have no confirmed command for that harness, so the UI offers no button
// rather than typing something it cannot be sure of.

export function compactCommandFor(agentType: string | null | undefined): string | null {
  switch (agentType || 'claude') {
    case 'claude': return '/compact';
    case 'codex': return '/compact';
    case 'gemini': return '/compress';
    default: return null;
  }
}

export function harnessCanCompact(agentType: string | null | undefined): boolean {
  return compactCommandFor(agentType) !== null;
}
