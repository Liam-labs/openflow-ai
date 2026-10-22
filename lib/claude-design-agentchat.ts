export type ClaudeDesignAgentChatCommand =
  | { action: 'login' }
  | { action: 'sync'; path?: string };

/**
 * Commands handled by AgentChat itself rather than posted into a channel.
 *
 * Claude Design owns these slash commands inside the interactive Claude Code
 * TUI. AgentChat launches that TUI and types the command as literal terminal
 * input; sending the text to an agent as a normal prompt does not invoke it.
 */
export function parseClaudeDesignAgentChatCommand(
  input: string,
): ClaudeDesignAgentChatCommand | null {
  const trimmed = input.trim();
  if (trimmed === '/design-login') return { action: 'login' };

  const syncMatch = trimmed.match(/^\/design-sync(?:\s+([\s\S]+))?$/);
  if (!syncMatch) return null;

  const rawPath = syncMatch[1]?.trim();
  return rawPath ? { action: 'sync', path: rawPath } : { action: 'sync' };
}

export const CLAUDE_DESIGN_AGENTCHAT_COMMANDS = [
  {
    name: 'design-login',
    description: 'Open Claude Code and authenticate Claude Design (one time per account)',
    type: 'command',
  },
  {
    name: 'design-sync',
    description: 'Open Claude Code and sync the design system from this channel project',
    type: 'command',
    argumentHint: '[project path]',
  },
] as const;
