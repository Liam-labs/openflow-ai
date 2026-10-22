/**
 * PTY roster management handlers: skills_list, personalities_list,
 * roster_list, roster_add, roster_add_from_participant, roster_remove,
 * roster_update, roster_directives_read, roster_directives_write.
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { resolveRosterIdentity, assertIdentityWorkspaceAvailable } from '@/lib/roster-identity';
import type { AgentRosterEntry } from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import {
  forceKillByTmuxName,
  safeKillProcess,
  cleanupTempFiles,
  killOrphanedWrapperProcesses,
  sweepStaleCollabFiles,
  validateClaudeFlags,
  tmuxSessionExists,
} from '@/lib/collab-pty';
import { generateAgentColor } from '@/lib/collab-utils';
import { readSystemOwnership, writeSystemOwnership } from '@/lib/system-ownership';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { logEvent } from '@/lib/log-writer';
import { resolveApiIdForModel } from '@/lib/model-registry';
import { loadConfig } from '@/lib/config';
import { resolveChannelWorkingDirectory } from '@/lib/channel-working-directory';
import { supportsPowerShellSpawn, isWindowsPerMessageAgent } from '@/lib/roster-spawn-mode';
import {
  applyPendingCodexRuntimeConfig,
  observeCodexRuntime,
} from '@/lib/codex-runtime-config';
import {
  inferAgentTypeForModel,
  isAgentTypeCompatibleWith,
} from '@/lib/model-registry';
import {
  readChannelsData,
  isAllowedWorkingDirectory,
  findPersonalityFile,
  type PtyActionRequest,
  type PtyActionResponse,
} from '../_pty-shared';
import { appPath, appRoot } from '@/lib/app-paths';

const execFileAsync = promisify(execFile);
import { tmuxRun, filesHostFor, hostCall } from '@/lib/host-executor';
import { WINDOWS_SPAWN_UNAVAILABLE, windowsSpawnAvailable } from '@/lib/windows-spawn-availability';
import { refuseRunLocationChange, type Refusal } from '@/lib/laptop-readiness';
import { getDevflowHome, getHomeDir } from '@/lib/home-dir';

// 2026-05-22: per-session reasoning effort. Whitelist matches `claude --effort`
// CLI accepted levels. Anything else (incl. empty string for "clear") returns
// undefined, which removes the field from the roster entry.
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
type EffortLevel = typeof VALID_EFFORTS[number];
function validateEffort(input: unknown): EffortLevel | undefined {
  if (typeof input !== 'string' || !input) return undefined;
  return (VALID_EFFORTS as readonly string[]).includes(input) ? (input as EffortLevel) : undefined;
}

// Harness/runtime allow-list — the 6 agentTypes a roster entry may declare.
// Used to validate an explicit `body.agentType` on UPDATE (plan §1.2) and to
// gate model-derived auto-routing (plan §1.3).
const VALID_AGENT_TYPES = ['claude', 'gemini', 'grok', 'codex', 'antigravity'] as const;

// agentTypes whose per-runtime scaffolding (AGENTS.md / GEMINI.md / GROK.md +
// alignment + config.yaml) must be deployed BEFORE spawn. 'claude' is excluded —
// it syncs at spawn time in roster.ts. Both the ADD provision path and the
// UPDATE harness-change path (plan §1.4) gate on this set.
const SCAFFOLDED_AGENT_TYPES = ['antigravity', 'gemini', 'grok', 'codex'] as const;

/**
 * Deploy per-runtime scaffolding for an agent, then fire sync.py.
 *
 * Lifted from the roster ADD "Fix 1" path (plan §1.4) so the UPDATE harness-change
 * path shares identical behaviour. Registers/updates the agent in
 * `.AppData/scaffolding/agents.json` — sets `agentType` and extends `models[]` so
 * sync.py's `agentType:X` AND `model:X` conditions both evaluate true — then runs
 * `sync.py --agent <name>`. Without the agents.json mutation, per-runtime
 * scaffolding silently never deploys on a Claude→Codex flip (the scope §4B bug).
 */
async function syncScaffoldingForAgentType(agentName: string, agentType: string, host: string | null = null): Promise<void> {
  const AGENTS_PATH = DataPaths.scaffolding.agents;
  await fs.readFile(AGENTS_PATH, 'utf-8')
    .then(raw => JSON.parse(raw))
    .catch(() => ({ agents: [] }))
    .then((data: { agents: Array<Record<string, unknown>> }) => {
      const existing = data.agents.find(
        (a: Record<string, unknown>) =>
          (a.name as string).toLowerCase() === agentName.toLowerCase(),
      );
      if (!existing) {
        data.agents.push({
          name: agentName,
          teamId: 'sg1',
          role: 'Agent',
          domain: '',
          models: ['claude', 'gemini', agentType],
          agentType,
        });
        return fs.writeFile(AGENTS_PATH, JSON.stringify(data, null, 2), 'utf-8');
      }
      let mutated = false;
      if (existing.agentType !== agentType) {
        existing.agentType = agentType;
        mutated = true;
      }
      const models = Array.isArray(existing.models) ? (existing.models as string[]) : [];
      if (!models.map(m => m.toLowerCase()).includes(agentType.toLowerCase())) {
        existing.models = [...models, agentType];
        mutated = true;
      }
      if (mutated) {
        return fs.writeFile(AGENTS_PATH, JSON.stringify(data, null, 2), 'utf-8');
      }
    })
    .then(() => {
      const SYNC_SCRIPT = path.join(
        getDevflowHome(),
        'data', 'scaffolding', 'sync.py',
      );
      if (host) {
        return hostCall(host, 'sync', { agent: agentName, agentType }, 120000)
          .then(() => undefined)
          .catch(err => { console.error(`[roster.sync] remote sync failed for ${agentName}:`, (err as Error).message); });
      }
      return new Promise<void>(resolve => {
        execFile('python3', [SYNC_SCRIPT, '--agent', agentName], (err) => {
          if (err) console.error(`[roster.sync] sync.py failed for ${agentName}:`, err.message);
          resolve();
        });
      });
    })
    .catch(err => {
      console.error(`[roster.sync] agents.json update failed for ${agentName}:`, err.message);
    });
}

// ---------------------------------------------------------------------------
// skills_list
// ---------------------------------------------------------------------------

export async function handleSkillsList(
  body: PtyActionRequest
): Promise<NextResponse> {
  const homeDir = getHomeDir();
  const projectPath = (body.workingDirectory as string) || appRoot();
  const parseFm = (content: string): Record<string, string> => {
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const r: Record<string, string> = {};
    for (const line of m[1].split('\n')) {
      const ci = line.indexOf(':');
      if (ci > 0) { const k = line.slice(0, ci).trim(), v = line.slice(ci + 1).trim(); if (k && v) r[k] = v; }
    }
    return r;
  };
  const scanCmds = async (dir: string) => {
    try {
      const files = await fs.readdir(dir);
      return Promise.all(files.filter(f => f.endsWith('.md')).map(async f => {
        try {
          const fm = parseFm(await fs.readFile(path.join(dir, f), 'utf-8'));
          return { name: f.replace('.md', ''), description: fm.description || '', type: 'command' as const, argumentHint: fm['argument-hint'] || undefined };
        } catch { return null; }
      }));
    } catch { return []; }
  };
  const scanSkills = async (dir: string) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return Promise.all(entries.filter(e => e.isDirectory()).map(async e => {
        try {
          const fm = parseFm(await fs.readFile(path.join(dir, e.name, 'SKILL.md'), 'utf-8'));
          return { name: fm.name || e.name, description: fm.description || '', type: 'skill' as const };
        } catch { return null; }
      }));
    } catch { return []; }
  };
  const [gc, pc, gs, ps] = await Promise.all([
    scanCmds(path.join(homeDir, '.claude', 'commands')),
    scanCmds(path.join(projectPath, '.claude', 'commands')),
    scanSkills(path.join(homeDir, '.claude', 'skills')),
    scanSkills(path.join(projectPath, '.claude', 'skills')),
  ]);
  const seen = new Map<string, { name: string; description: string; type: string; argumentHint?: string }>();
  for (const item of [...gc, ...gs].filter(Boolean)) if (item) seen.set(`${item.type}:${item.name}`, item);
  for (const item of [...pc, ...ps].filter(Boolean)) if (item) seen.set(`${item.type}:${item.name}`, item);
  const items = Array.from(seen.values()).sort((a, b) => a.type !== b.type ? (a.type === 'command' ? -1 : 1) : a.name.localeCompare(b.name));
  return NextResponse.json({ success: true, items, count: items.length });
}

// ---------------------------------------------------------------------------
// role_character_generate — invent a new character when a role's are all in use
// ---------------------------------------------------------------------------

export async function handleRoleCharacterGenerate(body: PtyActionRequest): Promise<NextResponse> {
  if (!body.roleId) {
    return NextResponse.json({ success: false, error: 'roleId is required' }, { status: 400 });
  }
  let rosterNames: string[] = [];
  if (body.channelId) {
    const data = await readChannelsData();
    const channel = data.channels.find(c => c.id === body.channelId);
    rosterNames = (channel?.roster?.agents || []).map(a => a.name);
  }
  try {
    const { generateRoleCharacter } = await import('@/lib/role-character-generator');
    const character = await generateRoleCharacter(body.roleId, rosterNames);
    return NextResponse.json({ success: true, ...character });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode ?? 502;
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Character generation failed' },
      { status },
    );
  }
}

// ---------------------------------------------------------------------------
// personalities_list
// ---------------------------------------------------------------------------

/** Which execution environments this DevFlow can start, for the Add Agent / roster dialogs. */
export async function handleSpawnCapabilities(): Promise<NextResponse> {
  const powershell = await windowsSpawnAvailable();
  return NextResponse.json({ success: true, powershell, powershellReason: powershell ? undefined : WINDOWS_SPAWN_UNAVAILABLE });
}

export async function handlePersonalitiesList(): Promise<NextResponse> {
  const personalitiesDir = appPath('data', 'roles', 'personalities');
  try {
    const entries = await fs.readdir(personalitiesDir, { withFileTypes: true });
    const names = entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name.replace('.md', ''))
      .sort();
    return NextResponse.json({ success: true, personalities: names, count: names.length });
  } catch {
    return NextResponse.json({ success: true, personalities: [], count: 0 });
  }
}

// ---------------------------------------------------------------------------
// roster_list
// ---------------------------------------------------------------------------

export async function handleRosterList(
  body: PtyActionRequest
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'channelId is required' }, { status: 400 });
  }

  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === body.channelId);
  if (!channel) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  // Live-verify tmux sessions for agents claiming to be 'running'.
  // Catches stale status from crashes, restarts, or missed state transitions.
  const agents = channel.roster?.agents || [];
  let needsPersist = false;

  for (const agent of agents) {
    if ((agent.status === 'running' || agent.status === 'away') && agent.tmuxSessionName && !isWindowsPerMessageAgent(agent)) {
      const alive = await tmuxSessionExists(agent.tmuxSessionName);
      if (!alive) {
        agent.status = 'stopped';
        agent.lastStoppedAt = new Date().toISOString();
        agent.pid = undefined;
        needsPersist = true;
      }
    }
  }

  // Persist corrections so other consumers see the fix too
  if (needsPersist) {
    mutateChannels('pty-roster-list:status-correction', async freshData => {
      const freshChannel = freshData.channels.find(c => c.id === body.channelId);
      if (freshChannel?.roster?.agents) {
        for (const agent of freshChannel.roster.agents) {
          if ((agent.status === 'running' || agent.status === 'away') && agent.tmuxSessionName && !isWindowsPerMessageAgent(agent)) {
            const alive = await tmuxSessionExists(agent.tmuxSessionName);
            if (!alive) {
              agent.status = 'stopped';
              agent.lastStoppedAt = new Date().toISOString();
              agent.pid = undefined;
            }
          }
        }
        await saveChannels(freshData);
      }
    }).catch(err => console.error('[roster_list] Failed to persist status correction:', err));
  }

  const enrichedAgents = await Promise.all(agents.map(async agent => {
    const copy = { ...agent };
    const live = await observeCodexRuntime(agent);
    if (live?.model) copy.liveModel = live.model;
    if (live?.effort) copy.liveEffort = live.effort;
    if (live?.fastMode !== undefined) copy.liveFastMode = live.fastMode;
    return copy;
  }));

  return NextResponse.json<PtyActionResponse>({
    success: true,
    agents: enrichedAgents,
  });
}

// ---------------------------------------------------------------------------
// roster_add
// ---------------------------------------------------------------------------

/** The plain {success:false, error, code, details?} answer for a refused "where does this agent run" change (contract: board task "UI: 'Runs on' choice"). */
function runLocationRefusal(refusal: Refusal): NextResponse<PtyActionResponse> {
  return NextResponse.json({
    success: false, error: refusal.message, code: refusal.code, ...(refusal.details ? { details: refusal.details } : {}),
  }, { status: refusal.status }) as unknown as NextResponse<PtyActionResponse>;
}

export async function handleRosterAdd(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.name) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'channelId and name are required',
    }, { status: 400 });
  }

  // Only supported harnesses can be persisted; an unknown type (for example the
  // removed 'hermes') would otherwise create an agent that cannot spawn.
  if (body.agentType && !(VALID_AGENT_TYPES as readonly string[]).includes(body.agentType as string)) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: `Invalid agentType '${body.agentType}' — must be one of ${VALID_AGENT_TYPES.join(', ')}`,
    }, { status: 400 });
  }

  // The laptop guard comes first so "PowerShell on the laptop" gets its own plain answer, not the generic PowerShell one.
  if (body.runLocation === 'server') {
    const refusal = await refuseRunLocationChange({ channelId: body.channelId, runLocation: body.runLocation, spawnMode: body.spawnMode });
    if (refusal) return runLocationRefusal(refusal);
  }

  if (body.spawnMode === 'powershell' && supportsPowerShellSpawn(body.agentType) && !(await windowsSpawnAvailable())) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: WINDOWS_SPAWN_UNAVAILABLE }, { status: 400 });
  }

  // Role IDs are persisted references. Validate at the write boundary so a
  // stale modal or non-UI caller cannot create a dangling roster assignment.
  if (body.roleId) {
    try {
      const rolesRaw = await fs.readFile(appPath('data', 'roles', 'roles.json'), 'utf-8');
      const rolesData = JSON.parse(rolesRaw) as { roles?: Array<{ id: string }> };
      if (!rolesData.roles?.some(role => role.id === body.roleId)) {
        return NextResponse.json<PtyActionResponse>({
          success: false,
          error: 'Unknown roleId. Refresh roles and choose an available role.',
        }, { status: 400 });
      }
    } catch {
      return NextResponse.json<PtyActionResponse>({
        success: false,
        error: 'Could not validate roleId.',
      }, { status: 500 });
    }
  }

  let workingDirectory = body.workingDirectory?.trim();
  if (!workingDirectory) {
    const [channelsData, config] = await Promise.all([readChannelsData(), loadConfig()]);
    const channel = channelsData.channels.find(candidate => candidate.id === body.channelId);
    workingDirectory = resolveChannelWorkingDirectory(channel, config.projects);
  }

  if (!isAllowedWorkingDirectory(workingDirectory)) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'workingDirectory is outside allowed paths',
    }, { status: 400 });
  }

  let directoryCreated = false;
  try {
    if (filesHostFor({ runLocation: (body as { runLocation?: 'server' }).runLocation })) throw new Error('remote');
    const stat = await fs.stat(workingDirectory);
    if (!stat.isDirectory()) {
      return NextResponse.json<PtyActionResponse>({
        success: false,
        error: `${workingDirectory} exists but is not a directory`,
      }, { status: 400 });
    }
  } catch {
    if (filesHostFor({ runLocation: (body as { runLocation?: 'server' }).runLocation })) {
      // directory is created on the host by the scaffolding sync
    } else try {
      await fs.mkdir(workingDirectory, { recursive: true });
      directoryCreated = true;
    } catch (mkdirErr) {
      return NextResponse.json<PtyActionResponse>({
        success: false,
        error: `Could not create directory ${workingDirectory}: ${mkdirErr instanceof Error ? mkdirErr.message : 'Unknown error'}`,
      }, { status: 400 });
    }
  }

  const agentId = randomUUID();
  const participantId = `roster-${agentId.slice(0, 8)}`;
  const agentColor = body.color || generateAgentColor(body.name);

  let personality = body.personality;
  if (!personality) {
    const found = await findPersonalityFile(body.name);
    if (found) personality = body.name;
  }

  const newAgent: AgentRosterEntry = {
    id: agentId,
    name: body.name,
    workingDirectory,
    channelId: body.channelId,
    participantId,
    color: agentColor,
    homeChannelId: body.channelId,
    status: 'stopped',
    autoResume: body.autoResume !== false,
    useCollabWrapper: (body.agentType === 'grok' || body.agentType === 'codex' || body.agentType === 'antigravity') ? false : body.useCollabWrapper !== false,
    dangerouslySkipPermissions: body.dangerouslySkipPermissions !== false,
    claudeFlags: validateClaudeFlags(body.claudeFlags || []),
    roleId: body.roleId || undefined,
    model: body.model || undefined,
    agentType: body.agentType || undefined,
    personality: personality || undefined,
    spawnMode: body.spawnMode === 'powershell' && supportsPowerShellSpawn(body.agentType)
      ? 'powershell'
      : undefined,
    runLocation: body.runLocation === 'server' ? 'server' : undefined,
    effort: validateEffort(body.effort),
    fastMode: body.agentType === 'codex' ? body.fastMode === true : undefined,
    lastClaudeSessionId: body.lastClaudeSessionId || undefined,
    temporary: body.temporary === true ? true : undefined,
    createdAt: now,
    crashCount: 0,
  };

  let existingAgent: AgentRosterEntry | undefined;
  await mutateChannels('pty-roster-add', async channelsData => {
    const channel = channelsData.channels.find(c => c.id === body.channelId);
    if (!channel) throw new Error('Channel not found');

    if (!channel.roster) {
      channel.roster = { agents: [], lastUpdated: now };
    }

    const MAX_ROSTER_SIZE = 50;
    if (channel.roster.agents.length >= MAX_ROSTER_SIZE) {
      throw Object.assign(new Error(`Roster full: max ${MAX_ROSTER_SIZE} agents per channel`), { statusCode: 400 });
    }

    const duplicate = channel.roster.agents.find(
      a => a.name.toLowerCase() === newAgent.name.toLowerCase()
    );
    if (duplicate) {
      existingAgent = duplicate;
      return;
    }

    channel.roster.agents.push(newAgent);
    channel.roster.lastUpdated = now;
    await saveChannels(channelsData);
  });

  if (existingAgent) {
    return NextResponse.json({
      success: true,
      agent: existingAgent,
      directoryCreated,
      _duplicate: true,
    });
  }

  // Deploy scaffolding templates for non-Claude agent types before first spawn.
  // Claude agents get CLAUDE.md via the spawn-time sync in roster.ts:459;
  // Antigravity/Gemini/Grok/Codex need GEMINI.md / GROK.md / AGENTS.md
  // deployed now so the agent doesn't start with a stale or missing context.
  // Register in agents.json + deploy per-runtime scaffolding before first spawn.
  // Await completion so the first spawn cannot read the previous runtime's
  // entry point. Shared with the UPDATE harness-change path (plan §1.4).
  const needsEarlySync = (SCAFFOLDED_AGENT_TYPES as readonly string[]).includes(
    (newAgent.agentType as string) || '',
  );
  if (needsEarlySync) {
    await syncScaffoldingForAgentType(newAgent.name, newAgent.agentType as string, filesHostFor(newAgent));
  }

  return NextResponse.json({
    success: true,
    agent: newAgent,
    directoryCreated,
  });
}

// ---------------------------------------------------------------------------
// roster_add_from_participant
// ---------------------------------------------------------------------------

export async function handleRosterAddFromParticipant(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.participantId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'channelId and participantId are required',
    }, { status: 400 });
  }

  let promotedAgent: AgentRosterEntry | undefined;
  const channelId = body.channelId;
  const participantIdToPromote = body.participantId;

  await mutateChannels('pty-roster-add-from-participant', async channelsData => {
    const channel = channelsData.channels.find(c => c.id === channelId);
    if (!channel) throw new Error('Channel not found');

    const participant = channel.participants.find(p => p.id === participantIdToPromote);
    if (!participant) throw new Error('Participant not found in channel');

    const existingRoster = channel.roster?.agents?.find(
      a => a.participantId === participant.id || a.name === participant.name
    );
    if (existingRoster) throw new Error('Agent is already in the roster');

    const agentId = randomUUID();
    const agentColor = body.color || participant.color || generateAgentColor(participant.name);
    const config = await loadConfig();
    const workDir = body.workingDirectory
      || participant.projectPath
      || resolveChannelWorkingDirectory(
        channel,
        config.projects,
        getDevflowHome(),
      );

    let detectedStatus: AgentRosterEntry['status'] = 'stopped';
    let detectedTmuxSession: string | undefined;
    let detectedPid: number | undefined = participant.pid;

    if (detectedPid) {
      try {
        process.kill(detectedPid, 0);
        detectedStatus = 'running';
      } catch {
        detectedPid = undefined;
      }
    }

    if (!detectedPid) {
      try {
        const tmpFiles = await fs.readdir('/tmp');
        const sessionFiles = tmpFiles.filter(f => f.startsWith('collab-session-') && f.endsWith('.json'));
        for (const fileName of sessionFiles) {
          try {
            const sessionRaw = await fs.readFile(`/tmp/${fileName}`, 'utf-8');
            const session = JSON.parse(sessionRaw);
            if (session.participantId === participantIdToPromote) {
              const pidMatch = fileName.match(/collab-session-(\d+)\.json$/);
              if (pidMatch) {
                const candidatePid = parseInt(pidMatch[1], 10);
                try {
                  process.kill(candidatePid, 0);
                  detectedPid = candidatePid;
                  detectedStatus = 'running';
                } catch { /* PID not alive */ }
              }
              break;
            }
          } catch { /* skip unreadable file */ }
        }
      } catch { /* no session files */ }
    }

    if (!detectedTmuxSession) {
      try {
        const { stdout: tmuxListOut } = await tmuxRun(['list-sessions', '-F', '#{session_name}'], { timeout: 5000, encoding: 'utf-8' });
        const participantNameLower = participant.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const sessionName of tmuxListOut.trim().split('\n').filter(Boolean)) {
          if (detectedPid) {
            try {
              const { stdout: panesOut } = await tmuxRun(['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], { timeout: 5000, encoding: 'utf-8' });
              for (const panePid of panesOut.trim().split('\n').filter(Boolean)) {
                try {
                  const { stdout: childrenOut } = await execFileAsync('pgrep', ['-P', panePid], { timeout: 3000, encoding: 'utf-8' });
                  if (childrenOut.trim().split('\n').includes(String(detectedPid)) || panePid === String(detectedPid)) {
                    detectedTmuxSession = sessionName;
                    break;
                  }
                } catch { /* no children */ }
              }
              if (detectedTmuxSession) break;
            } catch { /* skip session */ }
          }
          const sessionNameLower = sessionName.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (sessionNameLower.includes(participantNameLower) || participantNameLower.includes(sessionNameLower)) {
            detectedTmuxSession = sessionName;
            if (detectedStatus !== 'running') detectedStatus = 'running';
            break;
          }
        }
      } catch { /* tmux not running or no sessions */ }
    }

    const promotedAgentType: AgentRosterEntry['agentType'] =
      body.agentType ||
      (participant.type === 'grok' ? 'grok' :
        participant.type === 'codex' ? 'codex' :
            participant.type.startsWith('gemini') ? 'gemini' : 'claude');

    promotedAgent = {
      id: agentId,
      name: participant.name,
      workingDirectory: workDir,
      channelId: channelId,
      participantId: participant.id,
      color: agentColor,
      homeChannelId: channelId,
      status: detectedStatus,
      autoResume: true,
      useCollabWrapper: promotedAgentType === 'claude',
      dangerouslySkipPermissions: true,
      claudeFlags: validateClaudeFlags(body.claudeFlags || []),
      roleId: body.roleId || undefined,
      model: body.model || undefined,
      agentType: promotedAgentType,
      pid: detectedPid || participant.pid,
      tmuxSessionName: detectedTmuxSession,
      createdAt: now,
      crashCount: 0,
    };

    if (!channel.roster) {
      channel.roster = { agents: [], lastUpdated: now };
    }
    channel.roster.agents.push(promotedAgent);
    channel.roster.lastUpdated = now;
    await saveChannels(channelsData);
  });

  return NextResponse.json<PtyActionResponse>({
    success: true,
    agent: promotedAgent,
  });
}

// ---------------------------------------------------------------------------
// roster_remove
// ---------------------------------------------------------------------------

export async function handleRosterRemove(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.agentId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'channelId and agentId are required',
    }, { status: 400 });
  }

  let removedAgentName: string | undefined;

  await mutateChannels('pty-roster-remove', async channelsData => {
    const channel = channelsData.channels.find(c => c.id === body.channelId);
    if (!channel?.roster) throw Object.assign(new Error('Channel or roster not found'), { statusCode: 404 });

    const agent = channel.roster.agents.find(a => a.id === body.agentId);
    if (!agent) throw Object.assign(new Error('Agent not found in roster'), { statusCode: 404 });

    removedAgentName = agent.name;

    // Audit trail: record removal in removedRoster so we can trace
    // who/what removed an agent and when. Previously removals were silent
    // with zero forensic trail — agents would vanish with no explanation.
    if (!channel.removedRoster) channel.removedRoster = [];
    channel.removedRoster.push({
      agentId: agent.id,
      name: agent.name,
      participantId: agent.participantId,
      removedAt: now,
      reason: body.reason || 'roster_remove API called',
      callerParticipantId: body.callerParticipantId || undefined,
      callerName: body.callerName || undefined,
    });
    // Keep removedRoster bounded: max 50 entries per channel
    if (channel.removedRoster.length > 50) {
      channel.removedRoster = channel.removedRoster.slice(-50);
    }

    if (agent.tmuxSessionName) {
      await forceKillByTmuxName(agent.tmuxSessionName, agent.pid);
    } else if (agent.pid) {
      await safeKillProcess(agent.pid);
      await cleanupTempFiles(agent.pid);
    }

    try {
      await fs.unlink(`/tmp/role-prompt-${body.agentId}.md`);
    } catch { /* doesn't exist */ }

    channel.roster.agents = channel.roster.agents.filter(a => a.id !== body.agentId);
    channel.roster.lastUpdated = now;
    channel.participants = channel.participants.filter(p => p.id !== agent.participantId);

    await saveChannels(channelsData);
  });

  if (removedAgentName) {
    await killOrphanedWrapperProcesses(removedAgentName, body.channelId);
    // Log the removal so it appears in DevFlow's log stream and stability digest
    logEvent('agent', 'high', `Agent "${removedAgentName}" removed from roster`, {
      event: 'roster_remove',
      agentName: removedAgentName,
      channelId: body.channelId,
      agentId: body.agentId,
      reason: body.reason || 'unspecified',
      caller: body.callerParticipantId || body.callerName || 'unknown',
    }).catch(() => {});
  }
  await sweepStaleCollabFiles();

  return NextResponse.json<PtyActionResponse>({ success: true });
}

// ---------------------------------------------------------------------------
// roster_update
// ---------------------------------------------------------------------------

export async function handleRosterUpdate(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.agentId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'channelId and agentId are required',
    }, { status: 400 });
  }

  if (body.runLocation !== undefined) {
    const refusal = await refuseRunLocationChange({ channelId: body.channelId, agentId: body.agentId, runLocation: body.runLocation, spawnMode: body.spawnMode });
    if (refusal) return runLocationRefusal(refusal);
  }

  if (body.spawnMode === 'powershell' && !(await windowsSpawnAvailable())) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: WINDOWS_SPAWN_UNAVAILABLE }, { status: 400 });
  }

  let updatedAgent: AgentRosterEntry | undefined;
  // Captured for the post-lock scaffolding sync (plan §1.4): a harness flip
  // must deploy the new runtime's scaffolding before respawn.
  let previousAgentType: string | undefined;
  let runtimeConfigRequested = false;
  let previousModel: string | undefined;
  let claudeModelChanged = false;

  await mutateChannels('pty-roster-update', async channelsData => {
    const channel = channelsData.channels.find(c => c.id === body.channelId);
    if (!channel?.roster) throw Object.assign(new Error('Channel or roster not found'), { statusCode: 404 });

    const agent = channel.roster.agents.find(a => a.id === body.agentId);
    if (!agent) throw Object.assign(new Error('Agent not found in roster'), { statusCode: 404 });
    previousAgentType = agent.agentType;
    const identity = resolveRosterIdentity(agent, body, channel.roster.agents);
    if (identity.changed && !['stopped', 'crashed'].includes(agent.status)) {
      throw Object.assign(new Error('Stop the agent before changing its name/personality.'), { statusCode: 409 });
    }
    if (identity.changed && identity.personality && !(await findPersonalityFile(identity.personality))) {
      throw Object.assign(new Error('Choose an available personality.'), { statusCode: 400 });
    }
    if (identity.changed) assertIdentityWorkspaceAvailable(channelsData, agent, identity.name);

    // Plan §1.2 — accept & persist an EXPLICIT harness choice from the modal.
    // Validated against the harness allow-list. Applied BEFORE the model block
    // so an explicit choice wins over model-derived inference (§1.3). This is
    // what lets the modal express "Codex harness + a compatible model"
    // instead of being silently re-routed to claude.
    let explicitAgentTypeApplied = false;
    if (body.agentType !== undefined) {
      const requested = (body.agentType as string) || '';
      if (requested && (VALID_AGENT_TYPES as readonly string[]).includes(requested)) {
        agent.agentType = requested as AgentRosterEntry['agentType'];
        explicitAgentTypeApplied = true;
      } else if (requested && requested === previousAgentType) {
        // Unchanged legacy value (e.g. 'ollama'/'gpt' — valid runtimes that the
        // harness selector can't represent). The modal re-POSTs the current type
        // when editing such an agent; accept it as a no-op rather than 400. Treat
        // as explicit so the model auto-route below doesn't clobber the kept type.
        explicitAgentTypeApplied = true;
      } else if (requested) {
        throw Object.assign(new Error(`Invalid agentType '${requested}' — must be one of ${VALID_AGENT_TYPES.join(', ')} (or unchanged from the agent's current type)`), { statusCode: 400 });
      }
    }

    const oldName = agent.name;
    agent.name = identity.name;
    if (body.workingDirectory !== undefined) agent.workingDirectory = body.workingDirectory;
    if (body.autoResume !== undefined) agent.autoResume = body.autoResume;
    if (body.useCollabWrapper !== undefined) agent.useCollabWrapper = body.useCollabWrapper;
    if (body.dangerouslySkipPermissions !== undefined) agent.dangerouslySkipPermissions = body.dangerouslySkipPermissions;
    if (body.claudeFlags !== undefined) agent.claudeFlags = validateClaudeFlags(body.claudeFlags);
    if (body.roleId !== undefined) {
      if (body.roleId) {
        const rolesPath = appPath('data', 'roles', 'roles.json');
        let roleValid = false;
        try {
          const rolesRaw = await fs.readFile(rolesPath, 'utf-8');
          const rolesData = JSON.parse(rolesRaw) as { roles: Array<{ id: string }> };
          roleValid = (rolesData.roles || []).some(r => r.id === body.roleId);
        } catch { /* roles.json unreadable — deny */ }
        if (!roleValid) throw new Error('roleId does not refer to a known role');
      }
      agent.roleId = body.roleId || undefined;
    }
    if (body.model !== undefined) {
      const newModel = body.model || undefined;
      previousModel = agent.model;
      agent.model = newModel;
      // Sprint c62ebbd2 B3 — model change implies agentType change when not
      // compatible. Without this, changing an agent's model to one its
      // current agentType can't run (e.g. switching Claude → Gemini-3.5-Flash)
      // would persist a broken pair: agent stuck on Claude wrapper trying
      // to spawn an Antigravity model. Atomic with the model write under the
      // same channels lock.
      // Plan §1.3 — model→agentType auto-route is now a FALLBACK only. Skip it
      // when the caller supplied an explicit harness this update: an explicit
      // (compatible) harness+model pair from the modal must be left intact, not
      // overridden by inference. The model-only change path (no body.agentType)
      // keeps the original auto-route for back-compat (e.g. Claude→Gemini model
      // swap still re-routes the wrapper).
      if (newModel && !explicitAgentTypeApplied) {
        const currentAgentType = agent.agentType || 'claude';
        if (!isAgentTypeCompatibleWith(newModel, currentAgentType)) {
          const inferred = inferAgentTypeForModel(newModel);
          if (inferred && (VALID_AGENT_TYPES as readonly string[]).includes(inferred)) {
            agent.agentType = inferred as AgentRosterEntry['agentType'];
            console.warn(
              `[roster_update] model='${newModel}' not compatible with agentType='${currentAgentType}'; auto-routing to agentType='${inferred}'`,
            );
          }
        }
      }
    }
    // Non-Claude runtimes are stored with useCollabWrapper=false. A flip INTO
    // Claude must restore the Claude default, or the agent spawns as bare
    // `claude` with no wrapper and AgentChat never sees working/idle status.
    if (
      agent.agentType === 'claude' &&
      (previousAgentType ?? 'claude') !== 'claude' &&
      body.useCollabWrapper === undefined
    ) {
      agent.useCollabWrapper = true;
    }
    agent.personality = identity.personality;
    if (body.color !== undefined) agent.color = body.color;
    // PowerShell per-message mode belongs to the Claude harness only. Clear a
    // stale value when a model/harness switch routes the agent to Codex (or any
    // other persistent WSL runtime); otherwise terminal/open/kill paths mistake
    // a live tmux session for a Windows one.
    if (!supportsPowerShellSpawn(agent.agentType)) {
      agent.spawnMode = undefined;
    } else if (body.spawnMode !== undefined) {
      agent.spawnMode = body.spawnMode === 'powershell' ? 'powershell' : undefined;
    }
    if (body.psWorkingDirectory !== undefined) agent.psWorkingDirectory = (body.psWorkingDirectory as string) || undefined;
    if (body.runLocation !== undefined) agent.runLocation = body.runLocation === 'server' ? 'server' : undefined;
    if (body.effort !== undefined) {
      const validated = validateEffort(body.effort);
      if (body.effort && !validated) {
        throw Object.assign(new Error(`Invalid effort '${body.effort}'`), { statusCode: 400 });
      }
      if (validated === 'ultra' && agent.agentType !== 'codex') {
        throw Object.assign(new Error('Ultra effort is available only for Codex agents'), { statusCode: 400 });
      }
      agent.effort = validated;
    }
    if (body.fastMode !== undefined) {
      if (typeof body.fastMode !== 'boolean') {
        throw Object.assign(new Error('fastMode must be a boolean'), { statusCode: 400 });
      }
      if (agent.agentType !== 'codex') {
        throw Object.assign(new Error('Fast mode is available only for Codex agents'), { statusCode: 400 });
      }
      agent.fastMode = body.fastMode;
    }

    const currentEffort = agent.effort ?? 'medium';
    const currentFastMode = agent.fastMode === true;
    // The live TUI may have drifted from the persisted roster through a manual
    // /model or /fast command. Treat explicit Codex controls on Save as a
    // convergence request even when the durable values themselves are unchanged.
    runtimeConfigRequested = agent.agentType === 'codex'
      && (body.model !== undefined || body.effort !== undefined || body.fastMode !== undefined);
    if (runtimeConfigRequested && (agent.status === 'running' || agent.status === 'away')) {
      agent.runtimeConfigPending = {
        revision: randomUUID(),
        model: agent.model,
        effort: currentEffort,
        fastMode: currentFastMode,
        requestedAt: now,
      };
    } else if (agent.agentType !== 'codex' || !['running', 'away'].includes(agent.status)) {
      agent.runtimeConfigPending = undefined;
    }

    if (identity.changed) {
      // Keep the old workspace intact. A name replacement uses the new dedicated
      // workspace, never a nested Team/Old/Team/New directory or old session ID.
      const oldSafeName = oldName.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'agent';
      if (identity.nameChanged && path.basename(agent.workingDirectory) === oldSafeName && path.basename(path.dirname(agent.workingDirectory)) === 'Team') {
        agent.workingDirectory = path.dirname(path.dirname(agent.workingDirectory));
      }
      const { setupAgentWorkspace } = await import('./message-inject');
      agent.effectiveWorkingDirectory = await setupAgentWorkspace(
        agent.workingDirectory, agent.name, agent.roleId, agent.personality, agent.agentType, true, filesHostFor(agent),
      );
      agent.lastClaudeSessionId = undefined;
      agent.runtimeConfigPending = undefined;
      agent.status = 'stopped';
      agent.pid = undefined;
      agent.tmuxSessionName = undefined;
      agent.ptySessionId = undefined;
      agent.lastContextHealth = undefined;
      agent.awayInChannelId = undefined;
      agent.awayInChannelName = undefined;
      channel.preferredNames = { ...channel.preferredNames, [agent.participantId]: agent.name };
      for (const participant of channel.participants) {
        if (participant.id === agent.participantId) participant.name = agent.name;
      }
    }
    channel.roster.lastUpdated = now;
    updatedAgent = { ...agent };
    await saveChannels(channelsData);
  });

  // Plan §1.4 — on a harness flip (e.g. Claude→Codex), deploy the new runtime's
  // scaffolding (AGENTS.md + alignment-*.md + config.yaml) and finish sync.py BEFORE
  // the caller respawns. Awaited outside the channels lock. Covers both
  // an explicit harness choice (§1.2) and a model-driven auto-route (§1.3).
  const finalAgentType = updatedAgent?.agentType;
  if (
    finalAgentType &&
    finalAgentType !== previousAgentType &&
    (SCAFFOLDED_AGENT_TYPES as readonly string[]).includes(finalAgentType) &&
    updatedAgent?.name
  ) {
    await syncScaffoldingForAgentType(updatedAgent.name, finalAgentType, filesHostFor(updatedAgent));
  }

  const runtimeApply = runtimeConfigRequested && updatedAgent?.runtimeConfigPending
    ? await applyPendingCodexRuntimeConfig(body.channelId, body.agentId)
    : undefined;

  // A running Claude agent takes the new model live via /model, like a terminal
  // user would; it no longer waits for the next restart. Runs in the background
  // because a busy agent can take minutes to reach an empty composer.
  claudeModelChanged = body.model !== undefined
    && (updatedAgent?.model || undefined) !== (previousModel || undefined)
    && (previousAgentType ?? 'claude') === 'claude' && updatedAgent?.agentType === 'claude';
  const liveSession = updatedAgent?.tmuxSessionName;
  const liveModel = claudeModelChanged && liveSession
    && (updatedAgent?.status === 'running' || updatedAgent?.status === 'away')
    && updatedAgent?.spawnMode !== 'powershell';
  if (liveModel && updatedAgent) {
    const agentName = updatedAgent.name;
    const apiId = updatedAgent.model ? resolveApiIdForModel(updatedAgent.model) : null;
    void (async () => {
      const { applyClaudeModelLive } = await import('@/lib/claude-live-model');
      const result = await applyClaudeModelLive(liveSession!, apiId);
      logEvent('agent', result === 'applied' ? 'info' : 'medium',
        `${agentName} model ${result === 'applied' ? 'switched live' : `switch ${result}`} → ${apiId ?? 'default'}`,
        { event: 'model-live-switch', agentName, channelId: body.channelId, apiId, result }).catch(() => {});
    })().catch(err => console.error('[roster_update] live model switch failed:', err));
  }

  return NextResponse.json<PtyActionResponse>({
    success: true,
    agent: updatedAgent,
    runtimeApply: runtimeApply ?? (liveModel ? { state: 'pending', message: 'Switching the running agent with /model' } : undefined),
  });
}

// ---------------------------------------------------------------------------
// roster_directives_read
// ---------------------------------------------------------------------------

export async function handleRosterDirectivesRead(
  body: PtyActionRequest
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.agentId) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'channelId and agentId are required' }, { status: 400 });
  }

  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === body.channelId);
  if (!channel?.roster) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Channel or roster not found' }, { status: 404 });
  }

  const agent = channel.roster.agents.find(a => a.id === body.agentId);
  if (!agent) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent not found in roster' }, { status: 404 });
  }

  const workDir = agent.effectiveWorkingDirectory || agent.workingDirectory;
  const rulesDir = path.join(workDir, '.claude', 'rules');
  const fileMap: Record<string, string> = { personality: 'Personality.md', directives: 'Directives.md', expertise: 'Expertise.md' };
  const result: Record<string, string> = {};
  for (const [key, filename] of Object.entries(fileMap)) {
    try {
      result[key] = await fs.readFile(path.join(rulesDir, filename), 'utf-8');
    } catch {
      result[key] = '';
    }
  }

  return NextResponse.json({ success: true, ...result, agentName: agent.name, workingDirectory: workDir });
}

// ---------------------------------------------------------------------------
// roster_system_ownership_read
// ---------------------------------------------------------------------------

export async function handleRosterSystemOwnershipRead(
  body: PtyActionRequest
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.agentId) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'channelId and agentId are required' }, { status: 400 });
  }

  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === body.channelId);
  if (!channel?.roster) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Channel or roster not found' }, { status: 404 });
  }

  const agent = channel.roster.agents.find(a => a.id === body.agentId);
  if (!agent) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent not found in roster' }, { status: 404 });
  }

  // Same workDir resolution as roster_directives_read — effectiveWorkingDirectory
  // is the agent's LIVE spawn dir, so this reads the file the running agent sees.
  const workDir = agent.effectiveWorkingDirectory || agent.workingDirectory;
  const ownership = await readSystemOwnership(workDir);

  return NextResponse.json({ success: true, systems: ownership.systems, agentName: agent.name, workingDirectory: workDir });
}

// ---------------------------------------------------------------------------
// roster_system_ownership_write
// ---------------------------------------------------------------------------

export async function handleRosterSystemOwnershipWrite(
  body: PtyActionRequest
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.agentId) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'channelId and agentId are required' }, { status: 400 });
  }
  if (!Array.isArray(body.systems)) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'systems must be an array' }, { status: 400 });
  }

  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === body.channelId);
  if (!channel?.roster) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Channel or roster not found' }, { status: 404 });
  }

  const agent = channel.roster.agents.find(a => a.id === body.agentId);
  if (!agent) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent not found in roster' }, { status: 404 });
  }

  // Same workDir resolution as the read — write the file the running agent will read.
  // Full-replace: the client sends the whole systems[]; the writer normalizes + drops
  // nameless entries. agent.name is stamped so the file's sanity field always matches the roster.
  const workDir = agent.effectiveWorkingDirectory || agent.workingDirectory;
  // Defensive (T4.3 bulk): a roster entry with no workDir must fail clean — never let an
  // empty path silently write SystemOwnership.json into the server CWD.
  if (!workDir) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent has no working directory configured' }, { status: 400 });
  }

  // try/catch so one bad agent in a bulk backfill loop returns a structured, named error
  // (missing dir, perms, etc.) instead of an opaque 500 — the driver logs it and continues.
  try {
    const written = await writeSystemOwnership(workDir, { agent: agent.name, systems: body.systems });
    return NextResponse.json({ success: true, systems: written.systems, agentName: agent.name, workingDirectory: workDir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: `Failed to write SystemOwnership.json for ${agent.name} (${workDir}): ${message}`,
    }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// roster_directives_write
// ---------------------------------------------------------------------------

export async function handleRosterDirectivesWrite(
  body: PtyActionRequest
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.agentId || !body.file || body.content === undefined) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'channelId, agentId, file, and content are required' }, { status: 400 });
  }

  const fileMap: Record<string, string> = { personality: 'Personality.md', directives: 'Directives.md', expertise: 'Expertise.md' };
  const filename = fileMap[body.file as string];
  if (!filename) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'file must be personality, directives, or expertise' }, { status: 400 });
  }

  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === body.channelId);
  if (!channel?.roster) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Channel or roster not found' }, { status: 404 });
  }

  const agent = channel.roster.agents.find(a => a.id === body.agentId);
  if (!agent) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent not found in roster' }, { status: 404 });
  }

  // Enforce 150-line cap — rules files are loaded on every message, so every line costs tokens
  const content = body.content as string;
  const lineCount = content.split('\n').length;
  if (lineCount > 150) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: `File exceeds 150-line limit (${lineCount} lines). Rules files are loaded on every message — keep them concise.`,
    }, { status: 400 });
  }

  const workDir = agent.effectiveWorkingDirectory || agent.workingDirectory;
  const rulesDir = path.join(workDir, '.claude', 'rules');
  await fs.mkdir(rulesDir, { recursive: true });
  const filePath = path.join(rulesDir, filename);
  await fs.writeFile(filePath, content, 'utf-8');

  return NextResponse.json({ success: true, file: filename, path: filePath, lineCount });
}
