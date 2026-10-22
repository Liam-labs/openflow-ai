import { randomUUID } from 'node:crypto';
import { buildWindowsTerminalAttachLaunch } from '@/lib/windows-terminal-launch';

export type ClaudeDesignLaunchAction = 'login' | 'sync';

export interface ClaudeDesignLaunchPlan {
  action: ClaudeDesignLaunchAction;
  cwd: string;
  sessionName: string;
  slashCommand: '/design-login' | '/design-sync';
  attachCommand: string;
  terminalLaunch: ReturnType<typeof buildWindowsTerminalAttachLaunch>;
}

/** Claude Code is ready for a slash command only after its interactive prompt renders. */
export function isClaudeDesignPromptReady(output: string): boolean {
  return output.includes('Claude Code v') && /(?:^|\n)\s*❯(?:\s|\u00a0)/u.test(output);
}

export function buildClaudeDesignLaunchPlan(
  action: ClaudeDesignLaunchAction,
  cwd: string,
  id = randomUUID().slice(0, 8),
): ClaudeDesignLaunchPlan {
  const sessionName = `claude-design-${action}-${id}`;
  const slashCommand = action === 'login' ? '/design-login' : '/design-sync';

  return {
    action,
    cwd,
    sessionName,
    slashCommand,
    attachCommand: `tmux attach -t ${sessionName}`,
    terminalLaunch: buildWindowsTerminalAttachLaunch({
      title: action === 'login' ? 'Claude Design Login' : 'Claude Design Sync',
      tmuxSession: sessionName,
    }),
  };
}
