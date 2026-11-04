/**
 * Does a message with no @mention need the "this goes to everyone" confirmation?
 * Only when there is more than one agent to hear it, nobody was replied to and this is not a phone, where the warning would push
 * the input off the screen. With a single agent (the Setup channel has only Jack) a plain message is simply for that agent.
 */
export function needsBroadcastWarning(input: { mentionCount: number; agentCount: number; alreadyConfirmed: boolean; isReply: boolean; isMobile: boolean }): boolean {
  return input.mentionCount === 0 && input.agentCount > 1 && !input.alreadyConfirmed && !input.isReply && !input.isMobile;
}
