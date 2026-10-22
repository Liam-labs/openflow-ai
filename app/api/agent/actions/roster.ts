/**
 * Roster Management Actions (Agent API)
 *
 * Provides programmatic access to agent roster management.
 */

import type { AgentApiRequest, AgentAuthContext, AgentRosterEntry, CollabChannelsData, CollabParticipant } from '@/lib/types';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdirSync } from 'fs';
import { readFile, stat, unlink, writeFile } from 'fs/promises';
import chokidar from 'chokidar';
import {
  resolveModelFromRegistry,
  inferAgentTypeForModel,
  isAgentTypeCompatibleWith,
} from '@/lib/model-registry';
import { randomUUID } from 'crypto';
import path from 'path';
import { appendMessage, appendSilentMessage, readChannelMessages } from '@/lib/collab-message-io';
import { eventBus } from '@/lib/event-bus';
import { emitApiEvent } from '@/lib/log-emitter';
import { tmuxSendKeys } from '@/lib/tmux-send';
import { compactCommandFor } from '@/lib/harness-compact';
import { getDevFlowApiToken } from '@/lib/api-auth';
import { readJsonFile } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { DataPaths } from '@/lib/data-paths';
import { applyRoleMcpConfigToAgentDir } from '@/lib/agent-mcp-config';
import { writeToParticipantInbox } from '@/lib/collab-delivery';
import { appPath } from '@/lib/app-paths';
import { resolveRolloutBase } from '@/lib/rollout-base';
import { getDevflowHome, getHomeDir } from '@/lib/home-dir';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';
import { PRODUCT_NAME } from '@/lib/brand';
import { selfOrigin } from '@/lib/self-origin';

const execFileAsync = promisify(execFile);

const ROLLOUT_SCRIPT = `${getDevflowHome()}/scripts/rollout-agent-dirs.py`;

/**
 * Run the rollout script for a single agent (fire-and-forget, non-blocking).
 * Errors are logged but never propagate — provisioning succeeds regardless.
 */
function runRolloutForAgent(name: string, workingDirectory: string, roleSlug: string, agentType: string = 'claude', teamId: string = 'sg1', personality: string = ''): void {
  const args = [
    ROLLOUT_SCRIPT,
    '--single-agent',
    '--name', name,
    '--working-dir', workingDirectory,
  ];
  if (roleSlug) {
    args.push('--role-slug', roleSlug);
  }
  if (agentType) {
    args.push('--agent-type', agentType);
  }
  if (teamId) {
    args.push('--team-id', teamId);
  }
  if (personality) {
    args.push('--personality', personality);
  }

  execFile('python3', args, (error, stdout, stderr) => {
    if (error) {
      console.error(`[roster.provision] rollout failed for ${name}:`, error.message);
      if (stderr) console.error(`[roster.provision] stderr:`, stderr);
    } else {
    }
  });
}

const PTY_API_URL = `${selfOrigin()}/api/collab/pty`;

/**
 * Call the internal /api/collab/pty endpoint and return BOTH the HTTP status
 * and the parsed body. Status is propagated so callers can attach it to
 * thrown errors (see ptyErrorStatusCode). Without this, 4xx client errors
 * from the PTY layer were being promoted to 'critical' at the outer
 * /api/agent catch (T2.2 / T2.3).
 */
interface PtyCallResult {
  status: number;
  body: { success?: boolean; error?: string; [k: string]: unknown };
}

async function callPtyApi(body: Record<string, unknown>): Promise<PtyCallResult> {
  const res = await fetch(PTY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed as PtyCallResult['body'] };
}

/**
 * Clamp a PTY response status into a safe statusCode for thrown errors.
 * Returns 500 for any out-of-range value so the outer /api/agent catch
 * won't misbehave.
 */
function ptyErrorStatusCode(status: number): number {
  return status >= 400 && status < 600 ? status : 500;
}

/**
 * roster.list - List roster agents for a channel
 */
export async function list(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  if (!channelId) throw Object.assign(new Error('channelId is required'), { statusCode: 400 });

  const { status, body: data } = await callPtyApi({ action: 'roster_list', channelId });
  if (!data.success) throw Object.assign(new Error(data.error || 'Failed to list roster'), { statusCode: ptyErrorStatusCode(status) });

  return { agents: data.agents, count: (data.agents as unknown[] | undefined)?.length || 0 };
}

/**
 * roster.add - Add agent to roster
 */
export async function add(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const name = body.name as string;
  const workingDirectory = body.workingDirectory as string;
  if (!channelId || !name || !workingDirectory) throw new Error('channelId, name, and workingDirectory are required');

  // Validate roleId exists in roles registry if provided
  if (body.roleId) {
    const rolesJsonPath = appPath('data', 'roles', 'roles.json');
    let rolesData: { roles: Array<{ id: string }> } = { roles: [] };
    try {
      rolesData = JSON.parse(await readFile(rolesJsonPath, 'utf-8'));
    } catch { /* roles.json missing — allow through */ }
    const roleExists = rolesData.roles.some(r => r.id === body.roleId);
    if (!roleExists) {
      throw Object.assign(new Error(`Role '${body.roleId}' does not exist`), { statusCode: 400 });
    }
  }

  const { status, body: data } = await callPtyApi({
    action: 'roster_add',
    channelId,
    name,
    workingDirectory,
    autoResume: body.autoResume,
    useCollabWrapper: body.useCollabWrapper,
    dangerouslySkipPermissions: body.dangerouslySkipPermissions,
    roleId: body.roleId,
    model: body.model,
    claudeFlags: body.claudeFlags,
    color: body.color,
    agentType: body.agentType,
  });
  if (!data.success) throw Object.assign(new Error(data.error || 'Failed to add agent'), { statusCode: ptyErrorStatusCode(status) });

  return { agent: data.agent };
}

/**
 * roster.provision - Add agent to roster, assign role, and spawn in one call.
 * Designed for Team Lead agents to dynamically scale their team.
 */
export async function provision(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const name = body.name as string;
  const workingDirectory = body.workingDirectory as string;
  if (!channelId || !name || !workingDirectory) throw new Error('channelId, name, and workingDirectory are required');

  // Validate roleId exists in roles registry if provided; also apply role-level defaults
  // for spawnMode, claudeFlags, and workingDirectory when not explicitly provided by caller.
  type RoleDef = { id: string; spawnMode?: string; claudeFlags?: string[]; workingDirectory?: string };
  let roleSpawnMode: string | undefined;
  let roleClaudeFlags: string[] | undefined;
  let roleWorkingDirectory: string | undefined;
  if (body.roleId) {
    const rolesJsonPath = appPath('data', 'roles', 'roles.json');
    let rolesData: { roles: RoleDef[] } = { roles: [] };
    try {
      rolesData = JSON.parse(await readFile(rolesJsonPath, 'utf-8'));
    } catch { /* roles.json missing — allow through */ }
    const roleEntry = rolesData.roles.find(r => r.id === body.roleId);
    if (!roleEntry) {
      throw Object.assign(new Error(`Role '${body.roleId}' does not exist`), { statusCode: 400 });
    }
    roleSpawnMode = roleEntry.spawnMode;
    roleClaudeFlags = roleEntry.claudeFlags;
    roleWorkingDirectory = roleEntry.workingDirectory;
  }

  // Sprint c62ebbd2 B1 — model-aware agentType default. Resolve BEFORE
  // roster_add so the resolved agentType is stored in the roster entry.
  // Without this, `roster_add` stores a potentially-undefined agentType,
  // and handleRosterSpawn can't route to non-Claude wrappers (antigravity,
  // codex, grok). Resolution order:
  //   1. body.agentType compatible with body.model      → use body.agentType (explicit wins)
  //   2. body.model set + inferred agentType available  → use inferred (with a log noting the override)
  //   3. body.agentType set                              → use body.agentType (preserves old behaviour)
  //   4. fall back to 'claude'                           → preserves old default for the unmodelled path
  const requestedAgentType = typeof body.agentType === 'string' ? body.agentType : undefined;
  const requestedModel = typeof body.model === 'string' ? body.model : undefined;
  let agentType: string;
  if (requestedModel) {
    const inferred = inferAgentTypeForModel(requestedModel);
    if (requestedAgentType && isAgentTypeCompatibleWith(requestedModel, requestedAgentType)) {
      agentType = requestedAgentType;
    } else if (inferred) {
      if (requestedAgentType && requestedAgentType !== inferred) {
        console.warn(
          `[roster.provision] model-aware default: model='${requestedModel}' is not compatible with agentType='${requestedAgentType}'; switching to '${inferred}'`,
        );
      }
      agentType = inferred;
    } else {
      agentType = requestedAgentType || 'claude';
    }
  } else {
    agentType = requestedAgentType || 'claude';
  }
  // Write resolved agentType back so roster_add stores the correct value
  (body as Record<string, unknown>).agentType = agentType;

  // Step 1: Add to roster
  const addRes = await callPtyApi({
    action: 'roster_add',
    channelId,
    name,
    // Role workingDirectory is a default; caller-provided value takes priority
    workingDirectory: workingDirectory || roleWorkingDirectory || '',
    autoResume: true,
    useCollabWrapper: true,
    dangerouslySkipPermissions: body.dangerouslySkipPermissions ?? true,
    roleId: body.roleId,
    model: body.model,
    effort: body.effort,
    personality: body.personality,
    claudeFlags: body.claudeFlags ?? roleClaudeFlags,
    color: body.color,
    agentType: body.agentType,
    spawnMode: (body.spawnMode as string | undefined) ?? roleSpawnMode,
  });
  const addData = addRes.body;
  if (!addData.success) throw Object.assign(new Error(addData.error || 'Failed to add agent to roster'), { statusCode: ptyErrorStatusCode(addRes.status) });

  const agent = addData.agent as { id: string };

  // Step 1.5: Run rollout script to scaffold agent directories, hooks, and MEMORY.md
  // Resolve role slug from roles.json if we have a roleId
  let roleSlug = (body.roleSlug as string) || '';
  if (!roleSlug && body.roleId) {
    // Best-effort slug lookup — rollout script will handle unknown role IDs gracefully
    const rolesPath = appPath('data', 'roles', 'roles.json');
    try {
      const rolesData = JSON.parse(await readFile(rolesPath, 'utf-8'));
      const roles = Array.isArray(rolesData) ? rolesData : (rolesData.roles || []);
      const role = roles.find((r: { id: string; slug: string }) => r.id === body.roleId);
      if (role?.slug) roleSlug = role.slug;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[roster.provision] Failed to read roles.json for slug lookup:', error instanceof Error ? error.message : error);
      }
      // Non-fatal — rollout will use generic template
    }
  }

  // Resolve effective model from central registry (3-layer: override → roleDefault → isDefault)
  // Only apply if caller did not explicitly pass a model
  if (!body.model) {
    const resolvedModel = resolveModelFromRegistry(name, roleSlug, agentType);
    if (resolvedModel) {
      (body as Record<string, unknown>).model = resolvedModel;
    }
  }

  // Rollout needs the team base dir (teamDir), not the project root —
  // rollout-agent-dirs.py appends the agent name to derive the effective agent dir.
  // e.g. teamDir=~/SG-1/Team → effective=~/SG-1/Team/an agent
  // With no team record the agent lives in <project>/Team/<name>, the folder the spawn code and sync.py use.
  let rolloutBaseDir = path.basename(workingDirectory.replace(/\/+$/, '')) === 'Team' ? workingDirectory : path.join(workingDirectory, 'Team');
  let teamId = (body.teamId as string) || '';
  const teamsPath = appPath('.AppData', 'scaffolding', 'teams.json');
  try {
    const teamsData = JSON.parse(await readFile(teamsPath, 'utf-8'));
    const resolved = resolveRolloutBase(workingDirectory, teamsData.teams || [], teamId);
    rolloutBaseDir = resolved.baseDir;
    teamId = resolved.teamId;
  } catch {
    // Non-fatal — rollout will attempt to use workingDirectory as-is
    if (!teamId) teamId = 'sg1';
  }
  runRolloutForAgent(name, rolloutBaseDir, roleSlug, agentType, teamId, (body.personality as string) || '');

  // Step 2: Spawn the agent
  const spawnRes = await callPtyApi({
    action: 'roster_spawn',
    channelId,
    agentId: agent.id,
  });
  const spawnData = spawnRes.body;
  if (!spawnData.success) {
    // Agent was added but spawn failed — remove from roster to prevent zombie entries
    try {
      await callPtyApi({ action: 'roster_remove', channelId, agentId: agent.id });
    } catch {
      console.error(`[roster.provision] Failed to clean up zombie entry for "${name}"`);
    }
    return {
      agent,
      spawned: false,
      error: spawnData.error || 'Agent added to roster but spawn failed — entry cleaned up',
    };
  }

  // Step 2.5: Apply per-role MCP config to the agent's effective dir.
  // Sprint 38 T3.3 — writes <agentDir>/.mcp.json + merges
  // <agentDir>/.claude/settings.local.json from roles.json mcpServers.
  // Non-fatal: a failure here does not reverse the provision.
  try {
    const agentEffectiveDir = path.join(rolloutBaseDir, name);
    const rolesJsonPath = appPath('data', 'roles', 'roles.json');
    const canonicalMcpJsonPath = path.join(getHomeDir(), '.mcp.json');
    const applyResult = await applyRoleMcpConfigToAgentDir({
      agentDir: agentEffectiveDir,
      roleId: body.roleId as string | undefined,
      rolesJsonPath,
      canonicalMcpJsonPath,
    });
    if (applyResult.applied && applyResult.result) {
      const { resolvedServers, unresolvedServers } = applyResult.result;
      if (unresolvedServers.length > 0) {
        console.log(
          `[roster.provision] ${name}: MCP config written (resolved: ${resolvedServers.join(', ') || 'none'}; unresolved/allow-list-only: ${unresolvedServers.join(', ')})`,
        );
      }
    } else if (applyResult.reason) {
      console.log(`[roster.provision] ${name}: MCP config skipped — ${applyResult.reason}`);
    }
  } catch (error) {
    console.error(
      `[roster.provision] ${name}: applyRoleMcpConfigToAgentDir failed (non-fatal):`,
      error instanceof Error ? error.message : error,
    );
  }

  emitApiEvent({
    action: 'roster.provision',
    status: 200,
    durationMs: 0,
    requestId: _auth.requestId,
    severity: 'info',
    actor: name,
    channelId,
    summary: `Agent provisioned: ${name} in ${channelId}`,
  });

  const session = spawnData.session as { pid?: number } | undefined;
  return {
    agent: { ...agent, status: 'running', pid: session?.pid },
    spawned: true,
    session: spawnData.session,
    participant: spawnData.participant,
  };
}

/**
 * roster.remove - Remove agent from roster
 */
export async function remove(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  const { status, body: data } = await callPtyApi({ action: 'roster_remove', channelId, agentId });
  if (!data.success) throw Object.assign(new Error(data.error || 'Failed to remove agent'), { statusCode: ptyErrorStatusCode(status) });

  emitApiEvent({
    action: 'roster.remove',
    status: 200,
    durationMs: 0,
    requestId: _auth.requestId,
    severity: 'medium',
    channelId,
    summary: `Agent removed: ${agentId}`,
  });

  return { message: 'Agent removed from roster' };
}

/**
 * roster.update - Update agent config
 */
export async function update(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  // Validate roleId exists in roles registry to prevent setting arbitrary/nonexistent roles
  if (body.roleId) {
    const rolesJsonPath = appPath('data', 'roles', 'roles.json');
    let rolesData: { roles: Array<{ id: string }> } = { roles: [] };
    try {
      rolesData = JSON.parse(await readFile(rolesJsonPath, 'utf-8'));
    } catch { /* roles.json missing — allow through */ }
    const roleExists = rolesData.roles.some(r => r.id === body.roleId);
    if (!roleExists) {
      throw Object.assign(new Error(`Role '${body.roleId}' does not exist`), { statusCode: 400 });
    }
  }

  const { status, body: data } = await callPtyApi({
    action: 'roster_update',
    channelId,
    agentId,
    name: body.name,
    workingDirectory: body.workingDirectory,
    autoResume: body.autoResume,
    useCollabWrapper: body.useCollabWrapper,
    dangerouslySkipPermissions: body.dangerouslySkipPermissions,
    model: body.model,
    personality: body.personality,
    roleId: body.roleId,
    mcpServers: body.mcpServers,
    spawnMode: body.spawnMode,
    claudeFlags: body.claudeFlags,
    color: body.color,
    effort: body.effort,
    runLocation: body.runLocation,
    fastMode: body.fastMode,
  });
  if (!data.success) throw Object.assign(new Error(data.error || 'Failed to update agent'), { statusCode: ptyErrorStatusCode(status) });

  return { agent: data.agent };
}

/**
 * roster.mcp.list - List available MCP servers (global + project-level)
 */
export async function listMcp(body: AgentApiRequest, _auth: AgentAuthContext) {
  const agentDir = body.agentDir as string | undefined;
  const servers: Array<{ name: string; source: 'global' | 'project' }> = [];

  // Read global ~/.mcp.json
  try {
    const globalPath = path.join(getHomeDir(), '.mcp.json');
    const globalMcp = JSON.parse(await readFile(globalPath, 'utf-8'));
    for (const name of Object.keys(globalMcp.mcpServers || {})) {
      servers.push({ name, source: 'global' });
    }
  } catch { /* no global .mcp.json */ }

  // Read project-level .mcp.json if agentDir provided
  if (agentDir) {
    try {
      const projectMcp = JSON.parse(await readFile(path.join(agentDir, '.mcp.json'), 'utf-8'));
      for (const name of Object.keys(projectMcp.mcpServers || {})) {
        if (!servers.find(s => s.name === name)) {
          servers.push({ name, source: 'project' });
        }
      }
    } catch { /* no project .mcp.json */ }
  }

  return { servers };
}

const SYNC_SCRIPT = `${getDevflowHome()}/data/scaffolding/sync.py`;

/**
 * roster.spawn - Launch a rostered agent
 * Also triggers sync.py to re-render CLAUDE.md (and other overwrite:true files) from current template.
 */
export async function spawn(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  const { status, body: data } = await callPtyApi({ action: 'roster_spawn', channelId, agentId });
  if (!data.success) throw Object.assign(new Error(data.error || 'Failed to spawn agent'), { statusCode: ptyErrorStatusCode(status) });

  // Fire-and-forget: re-render scaffolding for this agent on every spawn
  // so CLAUDE.md (overwrite:true) stays current with the template
  try {
    const { body: listData } = await callPtyApi({ action: 'roster_list', channelId });
    const agents = (listData.agents as Array<{ id: string; name: string }> | undefined) || [];
    const agent = agents.find((a: { id: string; name: string }) => a.id === agentId);
    if (agent?.name) {
      execFile('python3', [SYNC_SCRIPT, '--agent', agent.name], (err) => {
        if (err) console.error(`[roster.spawn] sync.py failed for ${agent.name}:`, err.message);
      });
    }
  } catch (err) {
    console.error('[roster.spawn] sync lookup failed:', err);
  }

  emitApiEvent({
    action: 'roster.spawn',
    status: 200,
    durationMs: 0,
    requestId: _auth.requestId,
    severity: 'info',
    channelId,
    summary: `Agent spawned: ${agentId}`,
  });

  return { session: data.session, participant: data.participant };
}

/**
 * roster.kill - Force-kill a running agent
 */
export async function kill(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  const { status, body: data } = await callPtyApi({ action: 'roster_kill', channelId, agentId });
  if (!data.success) throw Object.assign(new Error(data.error || 'Failed to kill agent'), { statusCode: ptyErrorStatusCode(status) });

  emitApiEvent({
    action: 'roster.kill',
    status: 200,
    durationMs: 0,
    requestId: _auth.requestId,
    severity: 'medium',
    channelId,
    summary: `Agent killed: ${agentId}`,
  });

  return { message: 'Agent killed' };
}

/**
 * roster.respawn - Kill + relaunch agent
 */
export async function respawn(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  const { status, body: data } = await callPtyApi({ action: 'roster_respawn', channelId, agentId });
  if (!data.success) throw Object.assign(new Error(data.error || 'Failed to respawn agent'), { statusCode: ptyErrorStatusCode(status) });

  return { session: data.session, participant: data.participant };
}

/**
 * roster.compactAgent - Send the harness's compact command (/compact, or /compress for Gemini) to a running agent's tmux session
 */
export async function compactAgent(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  const channelsPath = DataPaths.collabChannels;
  const channelsData = await readJsonFile<CollabChannelsData>(channelsPath, { channels: [], lastUpdated: new Date().toISOString() });
  const channel = channelsData.channels.find(ch => ch.id === channelId);
  if (!channel) throw Object.assign(new Error('Channel not found'), { statusCode: 404 });

  const agent = channel.roster?.agents?.find((a: AgentRosterEntry) => a.id === agentId);
  if (!agent) throw Object.assign(new Error('Agent not found in roster'), { statusCode: 404 });

  if (agent.status !== 'running') {
    throw Object.assign(new Error('agent not running'), { statusCode: 400 });
  }

  if (!agent.tmuxSessionName) {
    throw Object.assign(new Error('no tmux session'), { statusCode: 400 });
  }

  const compactCommand = compactCommandFor(agent.agentType);
  if (!compactCommand) {
    throw Object.assign(new Error(`${agent.agentType} agents have no compact command`), { statusCode: 400 });
  }
  await tmuxSendKeys(agent.tmuxSessionName, compactCommand);

  emitApiEvent({
    action: 'roster.compactAgent',
    status: 200,
    durationMs: 0,
    requestId: _auth.requestId,
    severity: 'info',
    channelId,
    summary: `Compact sent to ${agent.name} (${agent.tmuxSessionName})`,
  });

  return { success: true, agentName: agent.name, tmuxSessionName: agent.tmuxSessionName };
}

/**
 * roster.recall - Recall an away agent back to its home channel
 */
export async function recall(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const participantId = body.participantId as string;
  if (!channelId || !participantId) throw new Error('channelId and participantId are required');

  const res = await fetch(`${selfOrigin()}/api/collab`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'recall',
      channelId,
      participantId,
    }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Failed to recall agent');

  return { recalled: true, channelId };
}

/**
 * roster.launch_all - Relaunch all stopped/crashed agents
 */
export async function launchAll(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  if (!channelId) throw new Error('channelId is required');

  const { status, body: data } = await callPtyApi({ action: 'roster_launch_all', channelId });
  if (!data.success) throw Object.assign(new Error(data.error || 'Failed to launch all'), { statusCode: ptyErrorStatusCode(status) });

  return { launched: data.launched, failed: data.failed, errors: data.errors };
}

const DEFAULT_FLUSH_PROMPT = `[System] Memory flush requested. Write a brief extract to your logs/today.md NOW:
(1) What task you're currently working on and its status
(2) Any decisions made this session with rationale
(3) Any unsolved problems or blockers
(4) Next steps when you resume
Be extractive — record decisions and outcomes, not conversation summaries. Max 10 lines.`;

/**
 * collab.interrupt - Gracefully interrupt a running agent and flush its memory to today.md.
 *
 * Flow (Claude/Gemini): tmux C-c → 2s settle → post flush message → watch today.md for write
 * Flow (Grok):          skip C-c → post flush message → watch today.md for write
 *
 * Timeout is NOT an error — returns flushed: false if today.md doesn't change within timeoutMs.
 *
 * IMPORTANT — Idle agent behaviour:
 * C-c only interrupts an agent that is mid-response. If the agent is idle (sitting at prompt),
 * the Stop hook never fires and today.md will not be updated — the flush will time out regardless
 * of how long the timeout or settle gap is. This is correct by design: the Stop hook fires on
 * response completion, not on silence.
 *
 * In normal production use (single interrupt of an active agent) capture rate is high.
 * Multi-shot test harnesses that interrupt a previously-flushed idle agent will see low rates —
 * this is expected, not a timing bug. Do not increase timeouts to compensate.
 *
 * Tuned parameters (validated 2026-02-19):
 *   settle delay:          2000ms   — time for agent to return to prompt after C-c
 *   flush timeout:         15000ms  — sufficient for active agents; idle agents never flush
 *   stabilityThreshold:    200ms    — eliminates write-race on file detection
 */
export async function interrupt(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  const flushPrompt = (body.flushPrompt as string) || DEFAULT_FLUSH_PROMPT;
  const timeoutMs = (body.timeoutMs as number) || 15000;

  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  // 1. Look up agent in roster
  const { status: listStatus, body: listData } = await callPtyApi({ action: 'roster_list', channelId });
  if (!listData.success) throw Object.assign(new Error(listData.error || 'Failed to list roster'), { statusCode: ptyErrorStatusCode(listStatus) });

  const agent = (listData.agents as AgentRosterEntry[]).find((a: AgentRosterEntry) => a.id === agentId);
  if (!agent) throw Object.assign(new Error('Agent not found in roster'), { statusCode: 404 });
  if (agent.status !== 'running') {
    throw Object.assign(new Error(`Agent is not running (status: ${agent.status})`), { statusCode: 409 });
  }

  const agentType = agent.agentType || 'claude';
  const agentName = agent.name;
  // effectiveWorkingDirectory is the agent-specific workspace (e.g. SG-1/Team/an agent),
  // workingDirectory may be the project root — always prefer the effective path
  const agentWorkDir = agent.effectiveWorkingDirectory ?? agent.workingDirectory;
  const todayMdPath = path.join(agentWorkDir, 'logs', 'today.md');

  // 3. Interrupt via tmux (Claude/Gemini only — Grok has no PTY to interrupt)
  let interrupted = false;
  if (agentType !== 'grok' && agent.tmuxSessionName) {
    try {
      await execFileAsync('tmux', ['send-keys', '-t', agent.tmuxSessionName, 'C-c']);
      interrupted = true;
    } catch (err) {
      console.error(`[collab.interrupt] tmux C-c failed for ${agentName}:`, err);
    }
  }

  // 4. Settle — give agent time to return to prompt after interrupt
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 5. Deliver flush prompt — inject via PTY for Claude/Gemini, channel message fallback for Grok
  if (agentType !== 'grok' && agent.tmuxSessionName) {
    // Write directly into the agent's tmux session — not visible in the public channel
    try {
      await tmuxSendKeys(agent.tmuxSessionName, flushPrompt);
    } catch (err) {
      console.error(`[collab.interrupt] tmux flush inject failed for ${agentName}:`, err);
      // Fall through — polling will still detect if the agent manages to flush anyway
    }
  } else {
    // Grok or no PTY — fall back to channel message
    const now = new Date().toISOString();
    const systemSender: CollabParticipant = {
      id: 'system',
      type: 'user',
      name: 'System',
      source: 'DevFlow',
      joinedAt: now,
      lastSeen: now,
    };
    await appendMessage(channelId, {
      id: randomUUID(),
      channelId,
      from: systemSender,
      content: flushPrompt,
      timestamp: now,
      mentions: [agent.participantId],
      system: true,
      metadata: { isHidden: true },
    });
  }

  // 6. Watch today.md for creation or modification using chokidar.
  //    awaitWriteFinish waits for the file size to stabilise before firing —
  //    eliminates the race between the kernel flush and our detection.
  const flushStartTime = Date.now();
  const watchDir = path.dirname(todayMdPath);
  const watchFile = path.basename(todayMdPath);

  const flushed = await new Promise<boolean>(resolve => {
    const watcher = chokidar.watch(watchDir, {
      persistent: false,
      ignoreInitial: true,
      usePolling: false,       // inotify on native Linux FS (/home); usePolling fallback below
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    const timeout = setTimeout(() => {
      watcher.close();
      resolve(false);
    }, timeoutMs);

    const onWrite = (filePath: string) => {
      if (path.basename(filePath) === watchFile) {
        clearTimeout(timeout);
        watcher.close();
        resolve(true);
      }
    };

    watcher.on('add', onWrite);     // today.md created fresh
    watcher.on('change', onWrite);  // today.md updated
    watcher.on('error', () => {
      // Fall back to polling on inotify error (WSL2 edge case)
      watcher.close();
      clearTimeout(timeout);
      // Re-watch with polling enabled
      const pollWatcher = chokidar.watch(watchDir, {
        persistent: false,
        ignoreInitial: true,
        usePolling: true,
        interval: 200,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      });
      const pollTimeout = setTimeout(() => { pollWatcher.close(); resolve(false); }, timeoutMs);
      const onPollWrite = (filePath: string) => {
        if (path.basename(filePath) === watchFile) {
          clearTimeout(pollTimeout);
          pollWatcher.close();
          resolve(true);
        }
      };
      pollWatcher.on('add', onPollWrite);
      pollWatcher.on('change', onPollWrite);
    });
  });

  return flushed
    ? { interrupted, flushed: true, flushDurationMs: Date.now() - flushStartTime, agentType, agentName, todayMdPath }
    : { interrupted, flushed: false, flushDurationMs: timeoutMs, agentType, agentName, todayMdPath, note: 'Flush timed out' };
}

/**
 * roster.prepareRestart - Broadcast restart warning to all running agents.
 *
 * Posts a system message to each channel with running agents, @mentioning them
 * so they receive the injection and can save state to logs/today.md.
 *
 * If channelId is provided, only that channel is notified. Otherwise all channels
 * with running agents are notified.
 */
export async function prepareRestart(body: AgentApiRequest, _auth: AgentAuthContext) {
  const targetChannelId = body.channelId as string | undefined;
  const mode = (body.mode as 'restart' | 'shutdown') || 'restart';

  // 1. Get all channels (or just the target)
  const channelsRes = await fetch(`${selfOrigin()}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getDevFlowApiToken()}` },
    body: JSON.stringify({ action: 'collab.channels.list' }),
  });
  const channelsData = await channelsRes.json();
  if (!channelsData.success) throw new Error(channelsData.error || 'Failed to list channels');

  const channels: Array<{ id: string; name: string }> = channelsData.data?.channels || [];
  const targetChannels = targetChannelId
    ? channels.filter(ch => ch.id === targetChannelId)
    : channels;

  let channelsBroadcast = 0;
  let agentsNotified = 0;

  // Full channel objects (with participants) for the inbox-delivery leg below.
  // collab.channels.list only returns {id,name}; we need each running agent's
  // CollabParticipant (type + projectPath) to write its inbox file.
  const fullChannelsData = await readJsonFile<CollabChannelsData>(
    DataPaths.collabChannels,
    { channels: [], lastUpdated: new Date().toISOString() }
  );

  // 2. For each channel, get running agents and post warning
  for (const ch of targetChannels) {
    let agents: AgentRosterEntry[];
    try {
      const { body: rosterData } = await callPtyApi({ action: 'roster_list', channelId: ch.id });
      if (!rosterData.success) continue;
      agents = (rosterData.agents as AgentRosterEntry[]) || [];
    } catch (error) {
      console.error('[roster.notifyRestart] Failed to fetch roster for channel', ch.id, ':', error instanceof Error ? error.message : error);
      continue;
    }

    const runningAgents = agents.filter(a => a.status === 'running');
    if (runningAgents.length === 0) continue;

    // Build @mentions string and participant ID list
    const mentionNames = runningAgents.map(a => `@${a.name}`).join(' ');
    const mentionIds = runningAgents.map(a => a.participantId);

    const now = new Date().toISOString();
    const systemSender: CollabParticipant = {
      id: 'devflow-admin',
      type: 'user',
      name: PRODUCT_NAME,
      source: 'DevFlow',
      joinedAt: now,
      lastSeen: now,
    };

    const isShutdown = mode === 'shutdown';
    const label = isShutdown ? 'Roster Shutdown' : 'Roster Restart';
    const verb = isShutdown ? 'shut down' : 'restarted';
    const suffix = isShutdown
      ? 'Save your state now. Sessions will be terminated in ~45 seconds.'
      : 'No action needed — your state will be preserved automatically.';

    const restartMessage = {
      id: randomUUID(),
      channelId: ch.id,
      from: systemSender,
      content: `[${PRODUCT_NAME} ${label}] ${mentionNames} — a roster ${mode} was triggered from the ${PRODUCT_NAME} dashboard. Your sessions will be gracefully ${verb} in ~45 seconds. ${suffix}`,
      timestamp: now,
      mentions: mentionIds,
      system: true,
      silent: true,
    };
    await appendSilentMessage(ch.id, restartMessage);
    // Emit SSE so active agents receive the message in real-time
    eventBus.emitEvent('collab:message', { channelId: ch.id, message: restartMessage });

    // Reliable inbox leg — the wrapper's ~2s idle-poll path. SSE push alone does
    // not reach an IDLE agent when push is dropped (owner 2026-06-05: idle agent
    // got no restart warning, so it lost its grace window). Writing the warning
    // to each running claude agent's inbox file guarantees it lands within ~2s
    // and interrupts the idle loop. Mirrors deliverMessage's primary leg.
    const fullCh = fullChannelsData.channels.find(c => c.id === ch.id);
    const participants = fullCh?.participants || [];
    await Promise.allSettled(
      runningAgents.map(a => {
        const p = participants.find(pp => pp.id === a.participantId);
        return p ? writeToParticipantInbox(p, restartMessage, ch.name) : Promise.resolve();
      })
    );

    channelsBroadcast++;
    agentsNotified += runningAgents.length;
  }

  // Update roster status for all running agents to 'restarting' or 'shutting-down'
  const shuttingDown: Array<{ channelId: string; agentId: string; name: string }> = [];
  const targetStatus = mode === 'shutdown' ? 'shutting-down' as const : 'restarting' as const;
  await mutateChannels('agent-api:prepare-restart', async channelsData => {
    const channelsToUpdate = targetChannelId
      ? channelsData.channels.filter(ch => ch.id === targetChannelId)
      : channelsData.channels;

    let modified = false;
    const stamp = new Date().toISOString();
    for (const ch of channelsToUpdate) {
      if (!ch.roster?.agents) continue;
      for (const agent of ch.roster.agents) {
        if (agent.status === 'running') {
          agent.status = targetStatus;
          agent.statusChangedAt = stamp;
          shuttingDown.push({ channelId: ch.id, agentId: agent.id, name: agent.name });
          modified = true;
        }
      }
      if (modified) {
        ch.roster.lastUpdated = new Date().toISOString();
      }
    }
    if (modified) {
      await saveChannels(channelsData);
    }
  });

  // The dashboard button runs the final stop after its countdown, but only while
  // the page stays open. Closing it (or a phone locking) left agents running yet
  // marked 'shutting-down' for hours, and Codex delivery refused them every
  // message (Costa Vida, 1 Oct 2026). The server now finishes the shutdown itself;
  // the button's own later kill call is a harmless repeat.
  if (mode === 'shutdown' && shuttingDown.length > 0) {
    setTimeout(() => {
      void finishShutdown(shuttingDown).catch(err =>
        console.error('[roster.prepareRestart] server-side shutdown failed:', err instanceof Error ? err.message : err));
    }, SHUTDOWN_GRACE_MS).unref?.();
  }

  return { channelsBroadcast, agentsNotified };
}

const SHUTDOWN_GRACE_MS = 47_000; // dashboard countdown is 45s; stop just after it

async function finishShutdown(agents: Array<{ channelId: string; agentId: string; name: string }>): Promise<void> {
  const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, { channels: [], lastUpdated: '' });
  for (const target of agents) {
    const current = data.channels.find(c => c.id === target.channelId)?.roster?.agents.find(a => a.id === target.agentId);
    // Only agents still mid-shutdown: anything relaunched in the meantime is left alone.
    if (current?.status !== 'shutting-down') continue;
    await callPtyApi({ action: 'roster_kill', channelId: target.channelId, agentId: target.agentId }).catch(() => undefined);
  }
}

/**
 * roster.personalities - List available character personalities.
 * Scans data/roles/personalities/*.md and returns names for the UI picker.
 */
export async function personalities(_body: AgentApiRequest, _auth: AgentAuthContext) {
  const personalitiesDir = appPath('data', 'roles', 'personalities');
  try {
    const files = readdirSync(personalitiesDir);
    const names = files
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''))
      .sort();
    return { personalities: names, count: names.length };
  } catch {
    return { personalities: [], count: 0 };
  }
}

// ---------------------------------------------------------------------------
// P2 Handoff Pipeline — model-switch context preservation
// ---------------------------------------------------------------------------

const HANDOFF_FILENAME = 'Model-Switch-Handoff.md';
const HANDOFF_FRESHNESS_MS = 90_000;
const FALLBACK_MESSAGE_COUNT = 5;
const OVERLAP_KEEP_ALIVE_MS = 35_000; // owner 2026-06-08 — reduced from 60s to 35s

const SUMMARIZE_PROMPT = `[System — Model Switch Handoff]
${HUMAN_ROUTING_NAME} is switching this chat to a different model. Before you go: write a structured handover brief to ./Model-Switch-Handoff.md in your working directory. Include:
1. Current task (1 line)
2. State / progress so far (2-3 lines)
3. Key decisions made (bullet points)
4. Immediate next step (1 line)
5. Open blockers or questions

NOT a chatty recap. Structured brief the next model reads and continues from. Max 15 lines.`;

function buildContinuationPrimer(handoffContent: string | null, fallbackMessages: string): string {
  if (handoffContent) {
    return `[System — Model Switch Continuation]
You're continuing an in-progress conversation — ${HUMAN_ROUTING_NAME} just switched this chat to your model mid-task. A handover brief from the previous model is below. Read it, then pick up exactly where it left off: continue the task, don't restart, don't re-introduce yourself, act as if you'd been here the whole time. If the context leaves something genuinely unclear, ask ${HUMAN_ROUTING_NAME} one tight question before proceeding.

--- HANDOVER BRIEF ---
${handoffContent}
--- END HANDOVER ---`;
  }

  return `[System — Model Switch Continuation]
You're continuing an in-progress conversation — ${HUMAN_ROUTING_NAME} just switched this chat to your model mid-task. The previous model didn't leave a fresh handover brief, so below are its last ${FALLBACK_MESSAGE_COUNT} messages. Infer the task and context from them, then pick up exactly where it left off: continue the task, don't restart, don't re-introduce yourself, act as if you'd been here the whole time. If the context leaves something genuinely unclear, ask ${HUMAN_ROUTING_NAME} one tight question before proceeding.

--- LAST MESSAGES FROM PREVIOUS MODEL ---
${fallbackMessages}
--- END CONTEXT ---`;
}

async function readHandoffFile(agentWorkDir: string): Promise<string | null> {
  const filePath = path.join(agentWorkDir, HANDOFF_FILENAME);
  try {
    const s = await stat(filePath);
    if (Date.now() - s.mtimeMs > HANDOFF_FRESHNESS_MS) return null;
    const content = await readFile(filePath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function getLastAgentMessages(
  channelId: string,
  participantId: string,
  count: number,
): Promise<string> {
  try {
    const data = await readChannelMessages(channelId);
    const agentMessages = data.messages
      .filter(m => m.from.id === participantId && !m.system)
      .slice(-count);
    if (agentMessages.length === 0) return '(no recent messages from this agent)';
    return agentMessages.map(m => `[${m.timestamp}] ${m.content}`).join('\n\n');
  } catch {
    return '(could not read channel messages)';
  }
}

/**
 * roster.switchModel — Hot-swap an agent's model mid-conversation (P1 + P2).
 *
 * Full flow: validate target → inject summarize-prompt (P2a) → roster.update(model
 * + canonical agentType) → roster.respawn → parser freshness check (P2b) → inject
 * continuation primer (P2c).
 *
 * Params: channelId, agentId (or agentName), targetModel
 * Returns: { agentId, agentName, previousModel, newModel, agentType, respawned, handoffUsed, switchStatus }
 */
export async function switchModel(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  const agentName = body.agentName as string;
  const targetModel = body.targetModel as string;

  if (!channelId) throw Object.assign(new Error('channelId is required'), { statusCode: 400 });
  if (!targetModel || typeof targetModel !== 'string') throw Object.assign(new Error('targetModel is required'), { statusCode: 400 });
  if (!agentId && !agentName) throw Object.assign(new Error('agentId or agentName is required'), { statusCode: 400 });

  // 1. Validate target model is registered and has a working wrapper
  const inferredType = inferAgentTypeForModel(targetModel);
  if (!inferredType) {
    throw Object.assign(
      new Error(`Model '${targetModel}' is not registered or has no compatible wrapper`),
      { statusCode: 400 },
    );
  }

  // 2. Resolve agent from roster
  const { status: listStatus, body: listData } = await callPtyApi({ action: 'roster_list', channelId });
  if (!listData.success) {
    throw Object.assign(new Error(listData.error || 'Failed to list roster'), { statusCode: ptyErrorStatusCode(listStatus) });
  }

  const agents = (listData.agents as AgentRosterEntry[]) || [];
  const agent = agentId
    ? agents.find(a => a.id === agentId)
    : agents.find(a => a.name === agentName);
  if (!agent) {
    throw Object.assign(new Error('Agent not found in roster'), { statusCode: 404 });
  }

  const targetAgentId = agent.id;
  const previousModel = agent.model || 'unknown';

  // 3. Reject no-op: same model
  if (agent.model === targetModel) {
    throw Object.assign(
      new Error(`Agent '${agent.name}' is already using model '${targetModel}'`),
      { statusCode: 400 },
    );
  }

  // 4. P2a: If agent is running, interrupt + inject summarize-prompt to write
  // the handoff file BEFORE respawn kills the process.
  //
  // Delivery mechanism depends on agent type: tmux-based wrappers (Claude, Gemini,
  // Codex, DeepSeek) read stdin; poll-only wrappers (Grok, Antigravity)
  // read the channel API.
  //
  // ALL agent types then poll for Model-Switch-Handoff.md — the old agent must
  // finish writing it before step 6 respawns (kills) it.
  const wasRunning = agent.status === 'running';
  const agentWorkDir = agent.effectiveWorkingDirectory ?? agent.workingDirectory;
  const agentType = agent.agentType || 'claude';
  const isPollOnly = agentType === 'grok' || agentType === 'antigravity';

  if (wasRunning) {
    // Step 4a: Interrupt + inject the summarize prompt.
    if (!isPollOnly && agent.tmuxSessionName) {
      // Only interrupt if the agent is mid-generation. C-c alone returns
      // the agent to a clean prompt — never send ESC here (even post-C-c).
      // ESC opens the Ink escape menu, swallowing the subsequent injection
      // (prompt typed into menu state, Enter ignored).
      // (an agent/Jack 2026-06-08 — ESC×3 path removed; C-c already does the job.)
      try {
        let isBusy = false;
        try {
          const channelsData = await readJsonFile<CollabChannelsData>(
            DataPaths.collabChannels,
            { channels: [], lastUpdated: new Date().toISOString() },
          );
          const ch = channelsData.channels.find(c => c.id === channelId);
          const p = ch?.participants?.find(pp => pp.id === agent.participantId);
          const fresh = p?.activityUpdatedAt ? (Date.now() - Date.parse(p.activityUpdatedAt) < 15_000) : false;
          isBusy = fresh && (p?.activityStatus === 'working' || p?.activityStatus === 'typing');
        } catch { /* default: treat as not busy → skip interrupt */ }

        await execFileAsync('tmux', ['send-keys', '-t', agent.tmuxSessionName, 'C-c']);
        await new Promise(r => setTimeout(r, 2000));

        // Inject summarize prompt via load-buffer + paste-buffer.
        // send-keys -l types character-by-character — for long text, the
        // Enter sent in a separate call can race ahead. load-buffer +
        // paste-buffer pastes atomically, no race.
        const summarizeTmp = path.join('/tmp', `summarize-${randomUUID()}.txt`);
        await writeFile(summarizeTmp, SUMMARIZE_PROMPT, 'utf-8');
        await execFileAsync('tmux', ['load-buffer', '-t', agent.tmuxSessionName, summarizeTmp]);
        await execFileAsync('tmux', ['paste-buffer', '-t', agent.tmuxSessionName]);
        await execFileAsync('tmux', ['send-keys', '-t', agent.tmuxSessionName, 'Enter']);
        await unlink(summarizeTmp).catch(() => {});
      } catch (err) {
        console.error(`[roster.switchModel] tmux summarize inject failed for ${agent.name}:`, err);
      }
    } else if (isPollOnly) {
      // Poll-only wrappers (Grok, Antigravity) do NOT read from tmux, and their
      // SSE listener drops system messages (sender_id == "system" → return).
      // Channel-message delivery would silently fail — the agent never sees it.
      //
      // Instead, construct the handoff file directly from the agent's last
      // channel messages. Deterministic, no agent dependency, no timing race.
      try {
        const lastMessages = await getLastAgentMessages(channelId, agent.participantId, 5);
        const handoffBrief = `## Model Switch Handoff — ${agent.name}
**Previous model:** ${previousModel}
**When:** ${new Date().toISOString()}

### Recent context (last messages from this agent)
${lastMessages}

### Auto-generated summary
The above messages represent the agent's most recent activity. The agent was switched mid-conversation and did not produce a manual handoff brief.
`;
        const handoffPath = path.join(agentWorkDir, HANDOFF_FILENAME);
        await writeFile(handoffPath, handoffBrief, 'utf-8');
      } catch (err) {
        console.error(`[roster.switchModel] direct handoff write failed for ${agent.name}:`, err);
      }
    }
  }

  // 5. Update model + canonical agentType atomically.
  const updateRes = await callPtyApi({
    action: 'roster_update',
    channelId,
    agentId: targetAgentId,
    model: targetModel,
    // A model may support multiple wrappers. Pass the registry's canonical
    // choice explicitly so roster_update does not preserve an old wrapper
    // merely because it is also compatible (for example GPT-5.6 on Codex).
    agentType: inferredType,
  });
  if (!updateRes.body.success) {
    throw Object.assign(
      new Error(updateRes.body.error || 'Failed to update agent model'),
      { statusCode: ptyErrorStatusCode(updateRes.status) },
    );
  }

  // 6. Respawn on new model — preserves identity + working dir.
  //    Tmux agents: 60s overlap (owner 2026-06-06) — new session spawns immediately,
  //    old session stays alive writing the handoff, cleanup injects primer + kills old.
  //    Poll-only agents: standard kill→spawn (no tmux to overlap).
  let respawned = false;
  let handoffUsed = false;
  let overlapPending = false;
  if (wasRunning) {
    const useOverlap = !isPollOnly && !!agent.tmuxSessionName;
    const respawnRes = await callPtyApi({
      action: 'roster_respawn',
      channelId,
      agentId: targetAgentId,
      ...(useOverlap ? { keepAliveMs: OVERLAP_KEEP_ALIVE_MS } : {}),
    });
    respawned = respawnRes.body.success === true;

    if (useOverlap && respawned) {
      // Overlap mode: handoff is pending — the delayed cleanup (message-inject.ts)
      // reads the handoff file, injects the primer into the new tmux, and kills
      // the old session after keepAliveMs.
      overlapPending = true;
    } else if (!useOverlap && respawned) {
      // Poll-only or no-tmux: read the handoff file (written above or by the agent)
      // and inject the primer via appendMessage.
      const handoffContent = await readHandoffFile(agentWorkDir);
      if (handoffContent) handoffUsed = true;
      const fallbackMessages = handoffContent
        ? ''
        : await getLastAgentMessages(channelId, agent.participantId, FALLBACK_MESSAGE_COUNT);
      const primer = buildContinuationPrimer(handoffContent, fallbackMessages);

      const ts = new Date().toISOString();
      const systemSender: CollabParticipant = {
        id: 'system',
        type: 'user',
        name: 'System',
        source: 'DevFlow',
        joinedAt: ts,
        lastSeen: ts,
      };
      await appendMessage(channelId, {
        id: randomUUID(),
        channelId,
        from: systemSender,
        content: primer,
        timestamp: ts,
        mentions: [agent.participantId],
        system: true,
        metadata: { isHidden: true },
      });
    }
  }

  emitApiEvent({
    action: 'roster.switchModel',
    status: 200,
    durationMs: 0,
    requestId: _auth.requestId,
    severity: 'info',
    channelId,
    summary: `Model switch: ${agent.name} ${previousModel} → ${targetModel} (agentType=${inferredType}, respawned=${respawned}, handoff=${handoffUsed ? 'file' : overlapPending ? 'pending-overlap' : 'fallback'})`,
  });

  return {
    agentId: targetAgentId,
    agentName: agent.name,
    previousModel,
    newModel: targetModel,
    agentType: inferredType,
    respawned,
    handoffUsed,
    overlapPending,
    switchStatus: respawned ? 'live' : 'model-updated-agent-stopped',
  };
}
