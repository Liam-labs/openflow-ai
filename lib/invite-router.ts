/**
 * /invite slash command — parser + capability-match router + invite dispatch
 *
 * Grammar: /invite <capability-keyword> ["optional task description"]
 *
 * Server writes /tmp/collab-invite-{pid}.json; the collab-claude.py wrapper
 * picks it up on the next slow-poll cycle and switches channels.
 */

import { writeFile } from 'fs/promises';
import type { AgentRosterEntry, AgentRole } from './types';

export interface InviteCommand {
  capability: string;
  task?: string;
}

/**
 * Parses a `/invite` slash command from message content.
 * Returns null if the message is not an invite command.
 */
export function parseInviteCommand(content: string): InviteCommand | null {
  if (!content) return null;
  const trimmed = content.trim();
  const match = trimmed.match(/^\/invite\s+(\S+)(?:\s+"([^"]+)"|\s+(.+))?$/i);
  if (!match) return null;

  const capability = match[1].toLowerCase();
  const task = match[2] ?? match[3]?.trim() ?? undefined;
  return { capability, task };
}

/**
 * Finds the best-matching agent for a given capability keyword.
 *
 * Priority: running agents > stopped agents > null
 * Match condition: agent's role has a capabilities[] entry that includes
 * the keyword (case-insensitive).
 */
export function findAgentByCapability(
  capability: string,
  agents: AgentRosterEntry[],
  roles: AgentRole[]
): AgentRosterEntry | null {
  const kw = capability.toLowerCase();

  const matches = agents.filter(agent => {
    if (!agent.roleId) return false;
    const role = roles.find(r => r.id === agent.roleId);
    if (!role?.capabilities) return false;
    return role.capabilities.some(cap => cap.toLowerCase() === kw);
  });

  if (matches.length === 0) return null;

  // Prefer running agents with a known PID
  const running = matches.find(a => a.status === 'running' && a.pid);
  return running ?? matches[0];
}

/**
 * Writes a collab-invite file for the target agent.
 * Returns true on success, false if the agent has no PID (stopped without known PID).
 */
export async function dispatchInvite(
  agent: AgentRosterEntry,
  channelId: string,
  channelName: string,
  task?: string
): Promise<boolean> {
  if (!agent.pid) return false;

  const invite = {
    channelId,
    channelName,
    displayName: agent.name,
    invitedAt: new Date().toISOString(),
    ...(task && { task }),
  };

  await writeFile(
    `/tmp/collab-invite-${agent.pid}.json`,
    JSON.stringify(invite)
  );
  return true;
}
