/**
 * Collaboration Utilities
 *
 * - Random agent name generation
 * - Agent primer/onboarding message construction
 * - Conversation context summarization
 */

import type { CollabMessage, CollabParticipant, AgentRosterEntry, AgentRole } from './types';
import { readdirSync } from 'fs';
import path from 'path';
import { APP_CWD } from './app-paths';
import { PRODUCT_NAME } from '@/lib/brand';

// Who plays which part is configuration, as in the Python wrappers: unset, the prompts name the roles.
const ARCHITECT = process.env.DEVFLOW_ARCHITECT_NAME?.trim() || 'the Architect';
const LEAD = process.env.DEVFLOW_LEAD_NAME?.trim() || 'the Team Lead';

// Character names loaded from personality files (data/roles/personalities/*.md)
// Scanned once at startup and cached. Falls back to hardcoded list if directory is missing.
let cachedPersonalityNames: string[] | null = null;

function getPersonalityNames(): string[] {
  if (cachedPersonalityNames) return cachedPersonalityNames;
  try {
    const personalitiesDir = path.join(/* turbopackIgnore: true */ APP_CWD, 'data', 'roles', 'personalities');
    const files = readdirSync(personalitiesDir);
    cachedPersonalityNames = files
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''))
      .sort();
    if (cachedPersonalityNames.length > 0) return cachedPersonalityNames;
  } catch { /* directory may not exist */ }
  // Fallback if no personality files found
  cachedPersonalityNames = [
    'Atlas', 'Nova', 'Spark', 'Pixel', 'Vector', 'Cipher', 'Prism', 'Nexus',
    'Phoenix', 'Raven', 'Falcon', 'Echo', 'Onyx', 'Sage', 'Zenith', 'Apex',
  ];
  return cachedPersonalityNames;
}

/**
 * Invalidate the personality name cache (call when files change).
 */
export function invalidatePersonalityNameCache(): void {
  cachedPersonalityNames = null;
}

// Track used names to avoid duplicates within a session
const usedNames = new Set<string>();

/**
 * Generate a random agent name from available personality files.
 * Cycles through data/roles/personalities/*.md filenames, avoiding recent duplicates.
 */
export function generateAgentName(): string {
  const names = getPersonalityNames();
  let attempts = 0;
  const maxAttempts = names.length * 2;

  while (attempts < maxAttempts) {
    const name = names[Math.floor(Math.random() * names.length)];

    if (!usedNames.has(name)) {
      usedNames.add(name);
      // Clear old names if set gets too large
      if (usedNames.size > Math.floor(names.length * 0.8)) {
        const namesArray = Array.from(usedNames);
        usedNames.clear();
        // Keep last few
        namesArray.slice(-5).forEach(n => usedNames.add(n));
      }
      return name;
    }
    attempts++;
  }

  // Fallback with timestamp (all names exhausted)
  return `Agent-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

/**
 * Generate a color for an agent based on their name
 * Returns a consistent color for the same name
 */
export function generateAgentColor(name: string): string {
  const colors = [
    '#8B5CF6', // Purple
    '#3B82F6', // Blue
    '#10B981', // Emerald
    '#F59E0B', // Amber
    '#EF4444', // Red
    '#EC4899', // Pink
    '#6366F1', // Indigo
    '#14B8A6', // Teal
    '#F97316', // Orange
    '#84CC16', // Lime
  ];

  // Simple hash of name to pick consistent color
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash = hash & hash;
  }
  return colors[Math.abs(hash) % colors.length];
}

/**
 * Summarize conversation context for a new agent
 * Returns a concise summary of recent activity
 */
export function summarizeConversation(
  messages: CollabMessage[],
  participants: CollabParticipant[],
  maxMessages: number = 10
): string {
  if (messages.length === 0) {
    return 'This is a new conversation with no prior messages.';
  }

  // Filter out system messages and get recent ones
  const relevantMessages = messages
    .filter(m => m.from.id !== 'system')
    .slice(-maxMessages);

  if (relevantMessages.length === 0) {
    return 'No substantive messages yet in this conversation.';
  }

  // Build participant list
  const activeParticipants = participants
    .filter(p => p.id !== 'system')
    .map(p => `${p.name} (${p.source})`)
    .join(', ');

  // Build message summary
  const messageSummary = relevantMessages
    .map(m => `- ${m.from.name}: ${truncate(m.content, 100)}`)
    .join('\n');

  return `Current participants: ${activeParticipants || 'None yet'}

Recent conversation (last ${relevantMessages.length} messages):
${messageSummary}`;
}

/**
 * Build the primer message for a new agent joining a collaboration
 */
export function buildAgentPrimer(
  agentName: string,
  channelName: string,
  messages: CollabMessage[],
  participants: CollabParticipant[],
  triggerMessage?: string
): string {
  const context = summarizeConversation(messages, participants);

  let primer = `# Agent Onboarding

You are **${agentName}**, an AI assistant participating in a multi-agent collaboration channel called "${channelName}".

## Your Identity
- Your name is: ${agentName}
- You should sign your messages with your name for clarity
- Format: Start or end messages with "— ${agentName}" or "[${agentName}]"

## Channel Context
${context}

## Collaboration Guidelines
1. This is a multi-agent/user chat - multiple AI agents and humans may be participating
2. Always identify yourself in messages so others know who is speaking
3. Follow channel-communication.md: finalise Plan.md, assign sprint tasks, then execute quietly
4. Work through ordinary defects, corrections, and testing without intermediate handoffs or progress posts
5. During execution report only hard blockers to ${ARCHITECT} or completed-task findings that affect the next phase to ${ARCHITECT} or ${LEAD}
6. Answer direct human questions; planning and hard-blocker resolution may be discussed

## Your Task
`;

  if (triggerMessage) {
    primer += `You are responding to this message: "${triggerMessage}"

Act on the request. Send a channel reply only when the communication rules call for one.`;
  } else {
    primer += `Read the context and carry out any clear assignment without an introduction or ready message.`;
  }

  return primer;
}

/**
 * Build primer for an agent being "ported in" (invited from terminal)
 */
export function buildPortedAgentPrimer(
  agentName: string,
  channelName: string,
  messages: CollabMessage[],
  participants: CollabParticipant[]
): string {
  const context = summarizeConversation(messages, participants, 15);

  return `# Joining Collaboration Channel

You have been invited to join the collaboration channel "${channelName}".

## Your Identity in This Channel
- Your display name is: ${agentName}
- When posting to this channel, your messages will be attributed to this name
- Other participants can see your messages in real-time via ${PRODUCT_NAME}

## Channel Context
${context}

## How to Participate
1. Use \`/collab-post "your message"\` to send messages to the channel
2. Use \`/collab-poll\` to check for new messages from others
3. You can @mention other participants by name
4. Other agents may auto-respond to your messages

## Guidelines
- Follow channel-communication.md: finalise Plan.md, assign sprint tasks, then execute quietly
- Work through fixes and testing without intermediate handoffs, confirmations, ready checks, or progress posts
- Report only hard blockers to ${ARCHITECT} or completed-task findings that affect the next phase to ${ARCHITECT} or ${LEAD}
- Answer direct human questions; planning and hard-blocker resolution may be discussed

You're now connected. Use /collab-poll to see any messages you may have missed.`;
}

/**
 * Truncate text to a maximum length with ellipsis
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Parse @mentions from message content, returning participant IDs.
 * Matches @Name and @"Name With Spaces", resolves against participants and roles.
 */
export function parseAtMentions(
  content: string,
  participants: CollabParticipant[],
  roster?: AgentRosterEntry[],
  roles?: AgentRole[]
): string[] {
  const mentionedIds = new Set<string>();
  const mentionPattern = /@(?:"([^"]+)"|(\S+))/g;
  let match;

  while ((match = mentionPattern.exec(content)) !== null) {
    const mentionedName = (match[1] || match[2]).replace(/[.,!?;:)\]*_]+$/, '');

    // Use filter (not find) to match ALL participants with this name.
    // An agent can have two participants (pre-registered roster ID + join-acquired ID);
    // we must include both so targeted delivery reaches the active polling ID.
    const matchingParticipants = participants.filter(
      p => p.name?.toLowerCase() === mentionedName.toLowerCase()
    );

    if (matchingParticipants.length > 0) {
      matchingParticipants.forEach(p => mentionedIds.add(p.id));
      continue;
    }

    // T3.2: an @mention can target a roster agent that is currently STOPPED and
    // therefore absent from channel.participants (killed agents are removed from
    // the participant list but persist in roster.agents). Resolve by agent name
    // to its stable participantId so the message stays TARGETED — queued to that
    // agent's inbox for boot-drain — instead of collapsing to a channel-wide
    // broadcast (recipients=undefined) that fans out to every agent.
    if (roster) {
      const matchingAgents = roster.filter(
        a => a.name?.toLowerCase() === mentionedName.toLowerCase()
      );
      if (matchingAgents.length > 0) {
        matchingAgents.forEach(a => mentionedIds.add(a.participantId));
        continue;
      }
    }

    if (roles && roster) {
      const matchedRole = roles.find(
        r => r.name?.toLowerCase() === mentionedName.toLowerCase() ||
             r.slug?.toLowerCase() === mentionedName.toLowerCase()
      );

      if (matchedRole) {
        for (const agent of roster) {
          if (agent.roleId === matchedRole.id) {
            const agentParticipant = participants.find(p => p.id === agent.participantId);
            if (agentParticipant) {
              mentionedIds.add(agentParticipant.id);
            }
          }
        }
      }
    }
  }

  return Array.from(mentionedIds);
}
