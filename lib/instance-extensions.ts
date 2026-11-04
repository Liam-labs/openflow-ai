/**
 * What each installation may add to shared code, without the shared code naming it.
 *
 * Shared routes call the hooks in `instance/extensions.ts`. DevFlow's copy of that file is an empty list. OpenFlow's registers what only
 * OpenFlow has (for example the Setup channel). This file holds only the types, so it is the same in both trees.
 */

export interface FirstTeamContext {
  agentType: string;
  model?: string;
  workingDirectory: string;
  /** Make a channel and return its id. */
  createChannel: (name: string, description: string, projectPath: string) => Promise<string>;
  /** Start one agent in a channel on the runtime and model the user chose. */
  startAgent: (channelId: string, agent: { name: string; roleSlug: string; personality: string; workingDirectory: string; roleLabel?: string }) => Promise<{ started: boolean; error?: string }>;
}

export interface FirstTeamHook {
  /** The key the result appears under in the first-team response. */
  id: string;
  /** Runs once the first team has started. A failure must never fail the wizard, so it returns its result instead of throwing. */
  run: (ctx: FirstTeamContext) => Promise<unknown>;
}

export interface InstanceExtensions {
  afterFirstTeam: FirstTeamHook[];
}
