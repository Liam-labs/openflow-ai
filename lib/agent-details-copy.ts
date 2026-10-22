import type { AgentRole, AgentRosterEntry } from '@/lib/types';
import { isWindowsPerMessageAgent } from '@/lib/roster-spawn-mode';

interface BuildAgentDetailsArgs {
  roster: AgentRosterEntry;
  participantName: string;
  channelName?: string;
  roles: AgentRole[];
}

function sentenceCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/^./, first => first.toUpperCase());
}

function section(title: string, rows: Array<string | null>): string[] {
  const visibleRows = rows.filter((row): row is string => Boolean(row));
  if (visibleRows.length === 0) return [];
  return [title, '-'.repeat(title.length), ...visibleRows, ''];
}

/** Build a readable, paste-friendly snapshot of the details shown in the agent modal. */
export function buildAgentDetailsText({
  roster,
  participantName,
  channelName,
  roles,
}: BuildAgentDetailsArgs): string {
  const role = roles.find(candidate => candidate.id === roster.roleId);
  const agentType = sentenceCase(roster.agentType ?? 'claude');
  const session = isWindowsPerMessageAgent(roster)
    ? `Per-message · ${roster.ptySessionStatus === 'responding' ? 'Responding' : 'Ready'}`
    : roster.pid
      ? `Persistent process · PID ${roster.pid}`
      : 'Not running';

  return [
    'Agent Details',
    '=============',
    '',
    ...section('Identity', [
      `Name: ${roster.name}`,
      participantName !== roster.name ? `Display name: ${participantName}` : null,
      `Status: ${sentenceCase(roster.status)}`,
      role ? `Role: ${role.name}` : null,
      roster.personality ? `Personality: ${roster.personality}` : null,
    ]),
    ...section('Runtime', [
      `Agent type: ${agentType}`,
      `Model: ${roster.model ?? 'default'}`,
      roster.effort ? `Effort: ${sentenceCase(roster.effort)}` : null,
      `Session: ${session}`,
      roster.tmuxSessionName ? `Tmux session: ${roster.tmuxSessionName}` : null,
      `Crash count: ${roster.crashCount}`,
    ]),
    ...section('Location', [
      `Channel: ${channelName ? `${channelName}  (${roster.channelId})` : roster.channelId}`,
      `Working directory: ${roster.workingDirectory}`,
      roster.effectiveWorkingDirectory && roster.effectiveWorkingDirectory !== roster.workingDirectory
        ? `Effective directory: ${roster.effectiveWorkingDirectory}`
        : null,
      roster.homeChannelName
        ? `Home channel: ${roster.homeChannelName}${roster.homeChannelId ? `  (${roster.homeChannelId})` : ''}`
        : null,
      roster.awayInChannelName
        ? `Active channel: ${roster.awayInChannelName}${roster.awayInChannelId ? `  (${roster.awayInChannelId})` : ''}`
        : null,
    ]),
    ...section('Identifiers', [
      `Agent ID: ${roster.id}`,
      `Participant ID: ${roster.participantId}`,
      roster.ptySessionId ? `PTY session ID: ${roster.ptySessionId}` : null,
    ]),
  ].join('\n').trimEnd();
}
