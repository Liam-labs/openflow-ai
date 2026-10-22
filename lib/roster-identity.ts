import path from 'node:path';
import type { AgentRosterEntry, CollabChannelsData } from './types';

const workspaceName = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export function assertIdentityWorkspaceAvailable(data: CollabChannelsData, agent: AgentRosterEntry, name: string) {
  const projectBase = (entry: AgentRosterEntry) => {
    const directory = path.resolve(entry.workingDirectory);
    return path.basename(path.dirname(directory)) === 'Team' ? path.dirname(path.dirname(directory)) : directory;
  };
  if (data.channels.some(channel => channel.id !== agent.channelId
    && channel.roster?.agents.some(other => workspaceName(other.name) === workspaceName(name)
      && projectBase(other) === projectBase(agent)))) {
    throw Object.assign(new Error(`Another channel already uses ${name} in this project. Choose a different name to avoid sharing its workspace.`), { statusCode: 409 });
  }
}

/** Identity changes keep roster IDs/tasks, but must never impersonate a sibling. */
export function resolveRosterIdentity(
  agent: AgentRosterEntry,
  requested: { name?: unknown; personality?: unknown },
  siblings: AgentRosterEntry[],
) {
  const name = requested.name === undefined ? agent.name : requested.name;
  const personality = requested.personality === undefined ? agent.personality : requested.personality;
  if (name === agent.name && (personality || undefined) === agent.personality) {
    return { name: agent.name, personality: agent.personality, nameChanged: false, changed: false };
  }
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(name.trim())) {
    throw Object.assign(new Error('Choose a valid agent name (1–64 letters, numbers, spaces, _ or -).'), { statusCode: 400 });
  }
  if (personality != null && personality !== '' && (typeof personality !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(personality))) {
    throw Object.assign(new Error('Choose an available personality.'), { statusCode: 400 });
  }
  const normalizedName = name.trim();
  if (siblings.some(other => other.id !== agent.id && workspaceName(other.name) === workspaceName(normalizedName))) {
    throw Object.assign(new Error(`This channel already has an agent named ${normalizedName}. Choose a different name.`), { statusCode: 409 });
  }
  const normalizedPersonality = personality || undefined;
  return {
    name: normalizedName,
    personality: normalizedPersonality,
    nameChanged: normalizedName !== agent.name,
    changed: normalizedName !== agent.name || normalizedPersonality !== agent.personality,
  };
}
