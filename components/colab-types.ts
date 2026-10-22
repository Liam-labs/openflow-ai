/**
 * colab-types.ts — Shared types for ColabPanel and its split components.
 *
 * Re-exports Collab types from @/lib/types so split components have a single
 * import path. Also defines types that were previously inline in ColabPanel.tsx.
 */

// Re-export collab-related types from the central types file
export type {
  CollabChannel,
  CollabParticipant,
  CollabMessage,
  CollabTask,
  CollabSprint,
  CollabPhase,
  CollabTaskStatus,
  CollabTaskPriority,
  CollabSprintStatus,
  CollabParticipantType,
  CollabPresenceStatus,
  CollabActivityStatus,
  AgentRosterEntry,
  AgentRosterStatus,
  AgentRole,
  Team,
  TeamAgentDefinition,
  Project,
  ClaudeSession,
  WindowsTerminalTab,
} from '@/lib/types';

// Tracks which participants are currently typing/responding
export interface TypingState {
  participantId: string;
  participantName: string;
  startedAt: number;
  activity?: 'typing' | 'working';
}

// Model registry entry
export interface ModelCapabilities {
  reasoning?: boolean;
  reasoningOnly?: boolean;
  vision?: boolean;
  toolUse?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStreaming?: boolean;
  supportsTemperature?: boolean;
  preview?: boolean;
}

export interface ModelEntry {
  id: string;
  aliases?: string[];
  provider: string;
  label: string;
  description?: string;
  tier: string;
  agentTypes: string[];
  isDefault?: boolean;
  apiId?: string;
  capabilities?: ModelCapabilities;
}

// Alignment file metadata (for anchor rules panel)
export interface AlignmentFile {
  model: string;
  filename: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
}

// Main ColabPanel component props
export interface ColabPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialChannelId?: string | null;
  mode?: 'modal' | 'page';
}

// ColabTrigger button props
export interface ColabTriggerProps {
  onClick: () => void;
  hasActiveChannel?: boolean;
  participantCount?: number;
}
