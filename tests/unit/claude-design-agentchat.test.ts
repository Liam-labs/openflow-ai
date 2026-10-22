import { describe, expect, it } from 'vitest';
import {
  CLAUDE_DESIGN_AGENTCHAT_COMMANDS,
  parseClaudeDesignAgentChatCommand,
} from '@/lib/claude-design-agentchat';
import {
  buildClaudeDesignLaunchPlan,
  isClaudeDesignPromptReady,
} from '@/lib/claude-design-launch';

describe('parseClaudeDesignAgentChatCommand', () => {
  it('recognises the exact login command', () => {
    expect(parseClaudeDesignAgentChatCommand('  /design-login\n')).toEqual({ action: 'login' });
  });

  it('uses the channel project for design-sync when no path is supplied', () => {
    expect(parseClaudeDesignAgentChatCommand('/design-sync')).toEqual({ action: 'sync' });
  });

  it('preserves an explicit project path, including spaces', () => {
    expect(parseClaudeDesignAgentChatCommand('/design-sync /home/user/My Design System')).toEqual({
      action: 'sync',
      path: '/home/user/My Design System',
    });
  });

  it('does not swallow ordinary channel messages or command-like prefixes', () => {
    expect(parseClaudeDesignAgentChatCommand('@Morpheus use /design-login')).toBeNull();
    expect(parseClaudeDesignAgentChatCommand('/design-login please')).toBeNull();
    expect(parseClaudeDesignAgentChatCommand('/design-sync-now')).toBeNull();
  });

  it('publishes both commands in AgentChat autocomplete', () => {
    expect(CLAUDE_DESIGN_AGENTCHAT_COMMANDS.map(command => command.name)).toEqual([
      'design-login',
      'design-sync',
    ]);
  });
});

describe('buildClaudeDesignLaunchPlan', () => {
  it('builds a direct Claude Design login terminal', () => {
    const plan = buildClaudeDesignLaunchPlan('login', '/home/user/DevFlow', 'deadbeef');
    expect(plan.sessionName).toBe('claude-design-login-deadbeef');
    expect(plan.slashCommand).toBe('/design-login');
    expect(plan.attachCommand).toBe('tmux attach -t claude-design-login-deadbeef');
    expect(plan.terminalLaunch.args.join(' ')).toContain('claude-design-login-deadbeef');
  });

  it('builds design-sync in the selected project directory', () => {
    const plan = buildClaudeDesignLaunchPlan('sync', '/home/user/design-system', 'cafebabe');
    expect(plan.cwd).toBe('/home/user/design-system');
    expect(plan.slashCommand).toBe('/design-sync');
    expect(plan.sessionName).toBe('claude-design-sync-cafebabe');
  });

  it('waits for the real Claude Code prompt instead of a fixed startup delay', () => {
    expect(isClaudeDesignPromptReady('Claude Code v2.1.251\n\n❯\u00a0')).toBe(true);
    expect(isClaudeDesignPromptReady('Claude Code v2.1.251\nStarting…')).toBe(false);
    expect(isClaudeDesignPromptReady('❯\u00a0')).toBe(false);
  });
});
