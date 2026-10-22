import { filesHostFor, hostFor, type HostAgentRef } from './host-executor';

/**
 * Where the "Open terminal" window for a roster agent opens, and how it reaches the agent's live tmux session.
 *  - agent-host: the agent runs on the desktop (the agent host); the desktop opens a tab attached to its own tmux.
 *  - desktop-to-server: the agent runs on the DevFlow server (roster "Runs on: server"); the window still has to open on the desktop screen, so the
 *    desktop opens a tab that ssh-es to the server and attaches there. The desktop dials out with its own key; the server holds no key to the desktop.
 *  - this-machine: DevFlow itself has the screen (no agent host is set up).
 *  - unavailable: the agent runs on the server but no desktop is connected to show the window.
 */
export type TerminalRoute =
  | { kind: 'agent-host'; host: string }
  | { kind: 'desktop-to-server'; host: string }
  | { kind: 'this-machine' }
  | { kind: 'unavailable'; reason: string };

export function openTerminalRoute(agent: HostAgentRef): TerminalRoute {
  const agentHost = hostFor(agent);
  if (agentHost) return { kind: 'agent-host', host: agentHost };
  if (agent.runLocation === 'server') {
    const desktop = filesHostFor(agent);
    return desktop
      ? { kind: 'desktop-to-server', host: desktop }
      : { kind: 'unavailable', reason: 'This agent runs on the Remote server and no desktop is connected to open the window on.' };
  }
  return { kind: 'this-machine' };
}
