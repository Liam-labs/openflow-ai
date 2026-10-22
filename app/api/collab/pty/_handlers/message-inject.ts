/**
 * PTY roster lifecycle handlers: roster_spawn, roster_kill, roster_respawn,
 * roster_launch_all, roster_kill_all, roster_open_terminal.
 * Also contains agent workspace setup helpers and flush/kill internals.
 */

import { tmuxSendKeys } from '@/lib/tmux-send';
import { compactCommandFor } from '@/lib/harness-compact';
import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID, createHash } from 'crypto';
import { logEvent } from '@/lib/log-writer';
import { resolveRosterIdentity, assertIdentityWorkspaceAvailable } from '@/lib/roster-identity';
import { buildWindowsTerminalAttachLaunch } from '@/lib/windows-terminal-launch';
import { resolveWorkingWslInterop } from '@/lib/windows-interop';
import type { AgentRosterEntry } from '@/lib/types';
import { buildSeatParticipant, reconcileParticipantWithRoster } from '@/lib/collab-participants';
import {
  spawnCollabPtySession,
  spawnWindowsPtySession,
  forceKillPtySession,
  forceKillByTmuxName,
  captureClaudeSessionId,
  snapshotSessionFiles,
  safeKillProcess,
  cleanupTempFiles,
  killOrphanedWrapperProcesses,
  sweepStaleCollabFiles,
  tmuxSessionExists,
  isPtySessionActive,
} from '@/lib/collab-pty';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { humanParticipants } from '@/lib/human-identity';
import { syncSessionIdsToTeam } from '@/lib/team-operations';
import { readChannelMessages, appendMessage } from '@/lib/collab-message-io';
import { getEffectiveToolsForRole, buildAllowedToolsFlag } from '@/lib/role-tools';
import {
  resolveApiIdForModel,
  resolveContextWindowForModel,
} from '@/lib/model-registry';
import { agyLaunchArgs } from '@/lib/agy-launch-args';
import { getDefaultPsWorkingDirectory, isWindowsPerMessageAgent } from '@/lib/roster-spawn-mode';
import { stageCodexWindowsPackage } from '@/lib/codex-windows-stage';
import {
  readChannelsData,
  getAvailableMemoryMB,
  MIN_MEMORY_FOR_SPAWN_MB,
  findPersonalityFile,
  readTemplateFile,
  type PtyActionRequest,
  type PtyActionResponse,
} from '../_pty-shared';
import { appPath } from '@/lib/app-paths';

const execFileAsync = promisify(execFile);
import { tmuxRun, pasteRun, hostCall, filesHostFor } from '@/lib/host-executor';
import { openTerminalRoute } from '@/lib/open-terminal-route';
import { WINDOWS_SPAWN_UNAVAILABLE, windowsSpawnAvailable } from '@/lib/windows-spawn-availability';
import { getDevflowHome } from '@/lib/home-dir';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';

// Overlap constants (owner 2026-06-06 — 60s overlap for Model Switcher handoff)
const HANDOFF_FILENAME = 'Model-Switch-Handoff.md';
const HANDOFF_FRESHNESS_MS = 90_000;

// In-memory guard to prevent concurrent respawn/spawn of the same agent. Every lifecycle op uses the
// same per-agent key: separate spawn:/respawn: keys let a roster_spawn run during an auto-respawn and
// start a second live session of one agent (Riley, 4 Oct 2026 20:55Z).
const activeSpawnOps = new Set<string>();
const agentOpKey = (channelId: string, agentId: string) => `agent-op:${channelId}:${agentId}`;

/** Stop the old identity before preparing/saving the replacement. Never resume
 * its old conversation under the new name. The panel restarts after file edits. */
export async function handleRosterIdentitySwitchAction(body: PtyActionRequest, now: string) {
  if (!body.channelId || !body.agentId) {
    return NextResponse.json({ success: false, error: 'channelId and agentId are required' }, { status: 400 });
  }
  const key = agentOpKey(body.channelId, body.agentId);
  if (activeSpawnOps.has(key)) return NextResponse.json({ success: false, error: 'Agent operation already in progress' }, { status: 409 });
  activeSpawnOps.add(key);
  try {
    const data = await readChannelsData();
    const channel = data.channels.find(c => c.id === body.channelId);
    const agent = channel?.roster?.agents.find(a => a.id === body.agentId);
    if (!agent || !channel?.roster) return NextResponse.json({ success: false, error: 'Agent not found' }, { status: 404 });
    const identity = resolveRosterIdentity(agent, body, channel.roster.agents);
    if (identity.changed) assertIdentityWorkspaceAvailable(data, agent, identity.name);
    if (identity.personality && !(await findPersonalityFile(identity.personality))) {
      return NextResponse.json({ success: false, error: 'Choose an available personality.' }, { status: 400 });
    }
    const restart = identity.changed && ['running', 'away', 'starting'].includes(agent.status);
    // readChannelsData may return the same cached object that kill mutates.
    // Snapshot this setting before shutdown, not from the old agent afterwards.
    const autoResume = body.autoResume ?? agent.autoResume;
    if (restart) await handleRosterKill(body.channelId, body.agentId, now, true);
    const { handleRosterUpdate } = await import('./roster-ops');
    try {
      const response = await handleRosterUpdate({ ...body, autoResume }, now);
      const result = await response.json();
      return NextResponse.json({ ...result, identityRestartRequired: restart && result.success === true, agentStopped: restart }, { status: response.status });
    } catch (error) {
      const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      return NextResponse.json({ success: false, agentStopped: restart, error: `${restart ? 'The old agent is stopped. ' : ''}${error instanceof Error ? error.message : 'Identity switch failed'}` }, { status });
    }
  } finally {
    activeSpawnOps.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Rehydrate block builder (Sprint 40)
// ---------------------------------------------------------------------------

/**
 * Build the markdown block appended to the role temp file when rehydrate=true.
 * Returns null if rehydrate is falsy — caller should skip injection.
 */
export function buildRehydrateBlock(rehydrate: boolean | undefined): string | null {
  if (!rehydrate) return null;
  return [
    '',
    '## Rehydrate Context',
    '',
    '[REHYDRATE] Read the last 50 messages in this channel before responding to any new messages. A mention alone does not require an acknowledgement. A newer stop, replacement, or decision supersedes older instructions. Summarize key context.',
  ].join('\n');
}

export const ACTIVE_TASK_TITLE_MAX = 160;
export const ACTIVE_TASK_DESCRIPTION_MAX = 240;
export const ACTIVE_TASK_BLOCK_MAX_BYTES = 8 * 1024;

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Bounded task list for the spawn-time role prompt. Each task keeps its id and
 * title plus a short description; the whole list is capped so many long task
 * descriptions can never push the system prompt past the 128 KB single-argument
 * limit (MAX_ARG_STRLEN) when the wrapper passes it to the CLI. Agents read full
 * details from the task board.
 */
export function buildActiveTaskLines(
  tasks: { id: string; title: string; description?: string }[],
  maxBytes: number = ACTIVE_TASK_BLOCK_MAX_BYTES
): string {
  const lines: string[] = [];
  let used = 0;
  let included = 0;
  for (const t of tasks) {
    const desc = t.description ? clipText(t.description, ACTIVE_TASK_DESCRIPTION_MAX) : '';
    const line = `- [${t.id.slice(0, 8)}] ${clipText(t.title || '', ACTIVE_TASK_TITLE_MAX)}${desc ? `: ${desc}` : ''}`;
    const cost = Buffer.byteLength(line, 'utf-8') + 1;
    // Reserve room for the trailing "more tasks" line.
    if (used + cost > maxBytes - 120) break;
    lines.push(line);
    used += cost;
    included++;
  }
  const remaining = tasks.length - included;
  if (remaining > 0) {
    lines.push(`- ${remaining} more task${remaining === 1 ? '' : 's'} in progress; read the task board for the full list and details.`);
  } else if (tasks.length > 0 && tasks.some(t => (t.description || '').length > ACTIVE_TASK_DESCRIPTION_MAX)) {
    lines.push('- Descriptions above are shortened; read the task board for full details.');
  }
  return lines.join('\n');
}

/** Active board work is useful context, not a priority or completion gate. */
export function buildActiveTaskContext(taskLines: string): string {
  return (
    `\n\n## Active Sprint Tasks\n\nYou have the following tasks assigned and in progress:\n${taskLines}` +
    '\n\nThis is context for the current work. Follow the latest explicit human or system direction; it determines priority and supersedes older queued task context.'
  );
}

// ---------------------------------------------------------------------------
// roster_spawn
// ---------------------------------------------------------------------------

export async function handleRosterSpawnAction(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.agentId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'channelId and agentId are required',
    }, { status: 400 });
  }

  const spawnKey = agentOpKey(body.channelId, body.agentId);
  if (activeSpawnOps.has(spawnKey)) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'Agent spawn already in progress',
    }, { status: 409 });
  }
  activeSpawnOps.add(spawnKey);
  try {
    return await handleRosterSpawn(body.channelId, body.agentId, now);
  } finally {
    activeSpawnOps.delete(spawnKey);
  }
}

// ---------------------------------------------------------------------------
// roster_kill
// ---------------------------------------------------------------------------

export async function handleRosterKillAction(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.agentId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'channelId and agentId are required',
    }, { status: 400 });
  }

  return handleRosterKill(body.channelId, body.agentId, now);
}

// ---------------------------------------------------------------------------
// roster_respawn
// ---------------------------------------------------------------------------

export async function handleRosterRespawnAction(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.agentId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'channelId and agentId are required',
    }, { status: 400 });
  }

  const respawnKey = agentOpKey(body.channelId, body.agentId);
  if (activeSpawnOps.has(respawnKey)) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'Agent respawn already in progress',
    }, { status: 409 });
  }

  // Overlap mode: spawn new agent immediately, keep old session alive for keepAliveMs,
  // then inject handoff + kill old. (owner 2026-06-06 — 60s overlap for Model Switcher)
  const keepAliveMs = body.keepAliveMs;
  if (keepAliveMs && keepAliveMs > 0) {
    return await handleRosterRespawnWithOverlap(body, now, keepAliveMs);
  }

  activeSpawnOps.add(respawnKey);

  try {
    // Kill WITH grace (silent, but NOT skipFlush) — give the agent its commit window
    // before respawn (owner 2026-06-05). handleRosterKill only flushes a RUNNING agent,
    // so a crashed/stopped agent respawn stays fast (nothing to commit).
    await handleRosterKill(body.channelId, body.agentId, now, true, false);

    // Small delay for cleanup
    await new Promise(r => setTimeout(r, 1000));

    // Then spawn (pass rehydrate flag for context recovery injection)
    return await handleRosterSpawn(body.channelId, body.agentId, now, false, body.rehydrate, undefined, true);
  } finally {
    activeSpawnOps.delete(respawnKey);
  }
}

/**
 * Model-switch restart: allow the old agent its handoff window, stop it, then
 * spawn the replacement and deliver the continuation primer. The legacy overlap
 * request field is retained, but two wrappers must never consume the same channel.
 *
 * Falls through to the standard kill→spawn path for agents without a tmux session
 * (poll-only wrappers like grok/antigravity have nothing to overlap).
 */
async function handleRosterRespawnWithOverlap(
  body: PtyActionRequest,
  now: string,
  keepAliveMs: number
): Promise<NextResponse<PtyActionResponse>> {
  const channelId = body.channelId!;
  const agentId = body.agentId!;

  // 1. Read current state
  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === channelId);
  const agent = channel?.roster?.agents.find(a => a.id === agentId);

  if (!agent) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent not found' }, { status: 404 });
  }

  // No tmux session → standard kill→spawn (poll-only wrappers)
  if (!agent.tmuxSessionName) {
    activeSpawnOps.add(agentOpKey(channelId, agentId));
    try {
      await handleRosterKill(channelId, agentId, now, true, false);
      await new Promise(r => setTimeout(r, 1000));
      return await handleRosterSpawn(channelId, agentId, now, false, body.rehydrate, undefined, true);
    } finally {
      activeSpawnOps.delete(agentOpKey(channelId, agentId));
    }
  }

  const oldTmuxSession = agent.tmuxSessionName;
  const oldPid = agent.pid;
  const oldParticipantId = agent.participantId;
  const workDir = agent.effectiveWorkingDirectory ?? agent.workingDirectory ?? '';

  // 2. Old agent is already writing Model-Switch-Handoff.md (SUMMARIZE_PROMPT
  //    injected by switchModel before calling roster_respawn). Do NOT call
  //    flushAgentMemory here — it fires a second C-c + conflicting prompt that
  //    interrupts the handoff write. The old agent gets keepAliveMs undisturbed;
  //    overlapCleanup reads the handoff at the end of the window.
  //    (an agent 2026-06-06 — the owner watched this fail 8×: flushAgentMemory C-c'd
  //    the agent out of writing the handoff, then injected a "save your memory"
  //    prompt instead. The handoff write never finished → fallback primer.)

  // 3. Block concurrent spawn/respawn of this agent through the dedup set
  const spawnKey = agentOpKey(channelId, agentId);
  if (activeSpawnOps.has(spawnKey)) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'Agent spawn already in progress',
    }, { status: 409 });
  }
  activeSpawnOps.add(spawnKey);

  // Keep the handoff-writing window, but never run two channel consumers.
  try {
    await new Promise(r => setTimeout(r, keepAliveMs));
    await forceKillByTmuxName(oldTmuxSession, oldPid);
    if (await tmuxSessionExists(oldTmuxSession)) throw new Error("Old agent session did not stop");
  } catch (err) {
    activeSpawnOps.delete(spawnKey);
    throw err;
  }

  // 4. Clear the stopped session before starting the replacement.
  await mutateChannels('pty-respawn:clear-stopped-session', async data => {
    const ch = data.channels.find(c => c.id === channelId);
    const a = ch?.roster?.agents.find(a => a.id === agentId);
    if (a) {
      a.tmuxSessionName = undefined;
      a.pid = undefined;
      a.status = 'stopped';
    }
    if (ch?.roster) ch.roster.lastUpdated = now;
    await saveChannels(data);
  });

  // 5. Spawn only after the old session has stopped.
  let spawnResult: NextResponse<PtyActionResponse>;
  try {
    spawnResult = await handleRosterSpawn(channelId, agentId, now, false, body.rehydrate, oldPid, true);
  } finally {
    activeSpawnOps.delete(spawnKey);
  }

  const spawnSucceeded = spawnResult.status === 200;

  if (spawnSucceeded && oldTmuxSession) {
    // 6. Deliver the completed handoff to the replacement.
    //    .unref() so the timer doesn't keep the Next.js process alive.
    setTimeout(() => {
      overlapCleanup(channelId, agentId, workDir, oldParticipantId).catch(err => {
        console.error('[roster_respawn.overlap] cleanup failed:', err);
      });
    }, 0).unref();

    logEvent('agent', 'low',
      `respawn-overlap ${agent.name}: new session spawned, old=${oldTmuxSession} stopped after ${keepAliveMs}ms handoff window`,
      { event: 'respawn-overlap', agentName: agent.name, channelId, oldTmuxSession, keepAliveMs },
    ).catch(() => {});

    return spawnResult;
  }


  return spawnResult;
}

/**
 * Delayed cleanup after overlap window: read the old agent's handoff file, inject a
 * continuation primer into the new agent, and kill the old tmux session.
 */
async function overlapCleanup(
  channelId: string,
  agentId: string,
  workDir: string,
  oldParticipantId: string | undefined,
): Promise<void> {
  // 1. Read handoff file from old agent's working directory
  let handoffContent: string | null = null;
  const handoffPath = path.join(workDir, HANDOFF_FILENAME);
  try {
    const s = await fs.stat(handoffPath);
    if (s.size > 0 && Date.now() - s.mtimeMs < HANDOFF_FRESHNESS_MS) {
      const content = await fs.readFile(handoffPath, 'utf-8');
      if (content.trim()) handoffContent = content.trim();
    }
  } catch { /* no handoff file written */ }

  // 2. Build continuation primer
  let primer: string;
  if (handoffContent) {
    primer = `[System — Model Switch Continuation]
You're continuing an in-progress conversation — ${HUMAN_ROUTING_NAME} just switched this chat to your model mid-task. A handover brief from the previous model is below. Read it, then pick up exactly where it left off: continue the task, don't restart, don't re-introduce yourself, act as if you'd been here the whole time. If the context leaves something genuinely unclear, ask ${HUMAN_ROUTING_NAME} one tight question before proceeding.

--- HANDOVER BRIEF ---
${handoffContent}
--- END HANDOVER ---`;
  } else {
    // No handoff — build conversation context from channel history.
    // Priority: agent↔the owner conversation threads → agent's recent messages → channel context.
    // Must reconstruct the ACTIVE task conversation, not stale broadcasts from a prior task.
    let recentContext = '(no recent channel messages available)';
    try {
      const data = await readChannelMessages(channelId);
      const allMsgs = data.messages.filter(m => !m.system);

      // Resolve participant metadata once for all tiers.
      let humanIds = new Set<string>();
      let agentName: string | undefined;
      try {
        const channelsData = await readChannelsData();
        const ch = channelsData.channels.find(c => c.id === channelId);
        // The account owner's records (their canonical id and any browser id), not every `user`
        // participant: Slack, Teams and hearing participants are type `user` too.
        humanIds = new Set(humanParticipants(ch?.participants).map(p => p.id));
        agentName = ch?.participants?.find(p => p.id === oldParticipantId)?.name;
      } catch { /* fall through to participant-ID-only fallback */ }

      // Tier 1: agent↔the owner conversation threads.
      // Find agent messages directed at the owner (mentions) where the owner replied.
      // This captures active task context — stale broadcasts get filtered out.
      if (oldParticipantId && humanIds.size > 0) {
        const agentMsgs = allMsgs.filter(m => m.from.id === oldParticipantId);
        if (agentMsgs.length > 0) {
          // Build conversation pairs: agent message + the owner's immediate reply.
          // Only include messages where the owner engaged (replied within 30 min).
          const REPLY_WINDOW_MS = 30 * 60 * 1000;
          const pairs: string[] = [];
          for (const agentMsg of agentMsgs.slice(-10).reverse()) {
            const agentTime = new Date(agentMsg.timestamp).getTime();
            const liamReply = allMsgs.find(m =>
              humanIds.has(m.from.id) &&
              new Date(m.timestamp).getTime() > agentTime &&
              new Date(m.timestamp).getTime() - agentTime < REPLY_WINDOW_MS
            );
            if (liamReply) {
              pairs.unshift(`[${liamReply.timestamp}] ${liamReply.from.name}: ${liamReply.content}`);
              pairs.unshift(`[${agentMsg.timestamp}] ${agentMsg.from.name}: ${agentMsg.content}`);
              if (pairs.length >= 12) break; // ~6 conversation pairs max
            }
          }
          if (pairs.length > 0) {
            recentContext = pairs.join('\n\n');
          }
        }
      }

      // Tier 2: agent's last messages + messages @mentioning the agent.
      // Include task assignments (others mentioning the agent) alongside the
      // agent's own replies so the new model sees what it was asked to do.
      if (recentContext === '(no recent channel messages available)' && oldParticipantId) {
        const agentMsgs = allMsgs.filter(m => m.from.id === oldParticipantId);
        const mentionsOfAgent = agentName
          ? allMsgs.filter(m => m.from.id !== oldParticipantId && m.content.includes(`@${agentName}`))
          : [];
        const combined = [...agentMsgs, ...mentionsOfAgent]
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
          .slice(-8);
        if (combined.length > 0) {
          recentContext = combined
            .map(m => `[${m.timestamp}] ${m.from.name}: ${m.content}`)
            .join('\n\n');
        }
      }
      // No Tier 3 — a generic fallback to anyone's messages injects noise,
      // not context. If Tiers 1+2 are empty, the agent gets a clean slate.
    } catch (err) {
      console.error('[overlapCleanup] failed to read channel messages:', err);
    }

    primer = `[System — Model Switch Continuation]
You're continuing an in-progress conversation — ${HUMAN_ROUTING_NAME} just switched this chat to your model mid-task. The previous model didn't leave a handover brief, so below is the conversation thread between it and ${HUMAN_ROUTING_NAME}. Infer the task from this exchange and pick up exactly where it left off: continue the task, don't restart, don't re-introduce yourself, act as if you'd been here the whole time. If the context leaves something genuinely unclear, ask ${HUMAN_ROUTING_NAME} one tight question before proceeding.

--- CONVERSATION CONTEXT ---
${recentContext}
--- END CONTEXT ---`;
  }

  // 3. Inject primer into new agent's tmux
  try {
    const freshData = await readChannelsData();
    const freshAgent = freshData.channels
      .find(c => c.id === channelId)
      ?.roster?.agents.find(a => a.id === agentId);

    if (freshAgent?.tmuxSessionName) {
      // Only interrupt if the agent is mid-generation — never C-c / ESC an
      // idle TUI. Sending ESC to an idle Claude Code agent opens the Ink
      // escape menu, breaking the injection (primer typed into menu state,
      // Enter ignored). Mirror the summarize-inject isBusy check: require
      // fresh activity signal with a working/typing status.
      let isBusy = false;
      try {
        const p = freshData.channels
          .find(c => c.id === channelId)
          ?.participants?.find(pp => pp.id === freshAgent?.participantId);
        const fresh = p?.activityUpdatedAt ? (Date.now() - Date.parse(p.activityUpdatedAt) < 15_000) : false;
        isBusy = fresh && (p?.activityStatus === 'working' || p?.activityStatus === 'typing');
      } catch { /* default: treat as not busy → skip interrupt */ }

      if (isBusy) {
        // C-c returns the agent to a clean prompt — never send ESC here.
        // ESC opens the Ink escape menu, swallowing the subsequent primer
        // injection (typed into menu state, Enter ignored).
        // (an agent/Jack 2026-06-08 — ESC×3 path removed; C-c already does the job.)
        await tmuxRun(['send-keys', '-t', freshAgent.tmuxSessionName, 'C-c']);
        await new Promise(r => setTimeout(r, 2000));
      }

      // Inject primer + Enter via load-buffer + paste-buffer.
      // send-keys -l types character-by-character — for long text, the
      // Enter sent in a separate call can race ahead. load-buffer loads the
      // entire primer into tmux's paste buffer in one shot, paste-buffer
      // pastes it atomically, then Enter submits. No character-by-character
      // delay, no race.
      await pasteRun(freshAgent.tmuxSessionName, primer, true);
    }
  } catch (err) {
    console.error('[overlapCleanup] primer inject failed:', err);
  }


}

// ---------------------------------------------------------------------------
// roster_launch_all
// ---------------------------------------------------------------------------

export async function handleRosterLaunchAll(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'channelId is required',
    }, { status: 400 });
  }

  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === body.channelId);
  if (!channel?.roster?.agents?.length) {
    return NextResponse.json<PtyActionResponse>({
      success: true,
      launched: 0,
      failed: 0,
      errors: [],
    });
  }

  // Grace window for running agents BEFORE killing — one shared ~20s window (parallel,
  // mirrors kill_all), so a 'Launch all' that bounces working agents still gives each
  // its commit window (owner 2026-06-05: ALL restart paths must grace). Kill below then
  // uses skipFlush=true since the flush already ran here.
  const runningAgents = channel.roster.agents.filter(a => a.status === 'running' || a.status === 'restarting');
  await Promise.allSettled(
    runningAgents.map(agent => flushAgentMemory(body.channelId as string, agent).catch(() => {}))
  );
  for (const agent of runningAgents) {
    try {
      await handleRosterKill(body.channelId, agent.id, now, true, true);
      await new Promise(r => setTimeout(r, 500));
    } catch {
      // best-effort kill — proceed to spawn regardless
    }
  }
  if (runningAgents.length > 0) {
    await new Promise(r => setTimeout(r, 1500));
  }

  // restartOnly (graceful-restart button): relaunch ONLY the agents that were
  // already running — never wake offline agents. A plain 'Launch all' (Rocket
  // button) leaves restartOnly unset and spawns the full roster as before.
  // Note: prepareRestart flips running→'restarting' before this fires, so the
  // runningAgents filter above (running|restarting) captures exactly that set.
  const toSpawn = body.restartOnly ? runningAgents : channel.roster.agents;
  let launched = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const agent of toSpawn) {
    try {
      await handleRosterSpawn(body.channelId, agent.id, now, true);
      launched++;
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      failed++;
      errors.push(`${agent.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  return NextResponse.json<PtyActionResponse>({
    success: true,
    launched,
    failed,
    errors,
  });
}

// ---------------------------------------------------------------------------
// roster_kill_all
// ---------------------------------------------------------------------------

export async function handleRosterKillAll(
  body: PtyActionRequest,
  now: string
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'channelId is required',
    }, { status: 400 });
  }

  const killAllData = await readChannelsData();
  const killAllChannel = killAllData.channels.find(c => c.id === body.channelId);
  const runningAgents = killAllChannel?.roster?.agents?.filter(
    a => a.status === 'running' || a.status === 'restarting' || a.status === 'shutting-down'
  ) ?? [];

  // Flush all agents in parallel BEFORE killing — one shared ~20s grace window total (not 20s×N)
  await Promise.allSettled(
    runningAgents.map(agent => flushAgentMemory(body.channelId as string, agent, { prompt: SHUTDOWN_FLUSH_PROMPT }).catch(() => {}))
  );

  let killed = 0;
  const killErrors: string[] = [];
  for (const agent of runningAgents) {
    try {
      await handleRosterKill(body.channelId, agent.id, now, true, true);
      killed++;
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      killErrors.push(`${agent.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  return NextResponse.json<PtyActionResponse>({
    success: true,
    killed,
    errors: killErrors,
  });
}

// ---------------------------------------------------------------------------
// roster_compact: type the harness's compact command into the agent's terminal
// ---------------------------------------------------------------------------

export async function handleRosterCompact(
  body: PtyActionRequest
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.agentId) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'channelId and agentId are required' }, { status: 400 });
  }
  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === body.channelId);
  const agent = channel?.roster?.agents.find(a => a.id === body.agentId);
  if (!agent) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent not found in roster' }, { status: 404 });
  }
  if (agent.status !== 'running') {
    return NextResponse.json<PtyActionResponse>({ success: false, error: `${agent.name} is not running` }, { status: 400 });
  }
  if (isWindowsPerMessageAgent(agent)) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: `${agent.name} runs in Windows per-message mode: it has no persistent session to compact.` }, { status: 400 });
  }
  const command = compactCommandFor(agent.agentType);
  if (!command) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: `${agent.agentType} agents have no compact command we can send.` }, { status: 400 });
  }
  if (!agent.tmuxSessionName) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: `${agent.name} has no terminal session to send ${command} to` }, { status: 400 });
  }
  try {
    await tmuxSendKeys(agent.tmuxSessionName, command);
  } catch (err) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: `Could not send ${command} to ${agent.name}: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
  logEvent('agent', 'info', `${command} sent to ${agent.name} from the roster menu`, { event: 'roster-compact', agentName: agent.name, channelId: body.channelId, command }).catch(() => {});
  return NextResponse.json<PtyActionResponse>({ success: true, command, agentName: agent.name } as PtyActionResponse);
}

// ---------------------------------------------------------------------------
// roster_open_terminal
// ---------------------------------------------------------------------------

export async function handleRosterOpenTerminal(
  body: PtyActionRequest
): Promise<NextResponse<PtyActionResponse>> {
  if (!body.channelId || !body.agentId) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'channelId and agentId are required',
    }, { status: 400 });
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

  // Powershell agents have no tmux session to open.
  if (isWindowsPerMessageAgent(agent)) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: 'This agent uses Windows per-message mode — no persistent terminal. Interact with it via the channel.',
    }, { status: 400 });
  }

  let tmuxSession = agent.tmuxSessionName;
  if (!tmuxSession && agent.pid) {
    try {
      const { stdout: tmuxListOut } = await tmuxRun(['list-sessions', '-F', '#{session_name}'], { timeout: 5000, encoding: 'utf-8' });
      for (const sessionName of tmuxListOut.trim().split('\n').filter(Boolean)) {
        try {
          const { stdout: panesOut } = await tmuxRun(['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], { timeout: 5000, encoding: 'utf-8' });
          for (const panePid of panesOut.trim().split('\n').filter(Boolean)) {
            try {
              const { stdout: childrenOut } = await execFileAsync('pgrep', ['-P', panePid], { timeout: 3000, encoding: 'utf-8' });
              if (childrenOut.trim().split('\n').includes(String(agent.pid)) || panePid === String(agent.pid)) {
                tmuxSession = sessionName;
                break;
              }
            } catch { /* no children */ }
          }
          if (tmuxSession) break;
        } catch { /* skip session */ }
      }
      if (tmuxSession) {
        agent.tmuxSessionName = tmuxSession;
        // The discovery above took seconds outside the lock, so record the session on the
        // current file, not on the snapshot read before it.
        const discoveredSession = tmuxSession;
        await mutateChannels('pty-open-terminal:record-tmux-session', async freshData => {
          const freshAgent = freshData.channels.find(c => c.id === body.channelId)
            ?.roster?.agents.find(a => a.id === body.agentId);
          if (freshAgent && !freshAgent.tmuxSessionName) {
            freshAgent.tmuxSessionName = discoveredSession;
            await saveChannels(freshData);
          }
        });
      }
    } catch { /* tmux discovery failed */ }
  }

  if (!tmuxSession) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent has no active tmux session' }, { status: 400 });
  }

  const safeTmuxName = /^[a-zA-Z0-9_\-:.]+$/;
  if (!safeTmuxName.test(tmuxSession)) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Invalid tmux session name' }, { status: 400 });
  }

  try {
    try {
      await tmuxRun(['set-option', '-t', tmuxSession, 'mouse', 'on']);
      await tmuxRun(['set-option', '-t', tmuxSession, 'history-limit', '50000']);
    } catch { /* non-fatal — options may already be set */ }

    // The WindowsApps `wt.exe` alias can return success without ever creating
    // a terminal when invoked from WSL. The launcher resolves the installed
    // Windows package executable and verifies a WindowsTerminal process exists.
    const tabTitle = `${agent.name} — ${channel.name}`;
    const route = openTerminalRoute(agent);
    if (route.kind === 'unavailable') {
      return NextResponse.json<PtyActionResponse>({ success: false, error: route.reason }, { status: 409 });
    }
    if (route.kind === 'agent-host') {
      await hostCall(route.host, 'open-terminal', { session: tmuxSession, title: tabTitle }, 25_000);
      return NextResponse.json<PtyActionResponse>({ success: true, command: `tmux attach -t ${tmuxSession}` });
    }
    if (route.kind === 'desktop-to-server') {
      // The agent's tmux session is on THIS machine. The window opens on the desktop and ssh-es back here (key-only, desktop to server).
      await hostCall(route.host, 'open-terminal', { session: tmuxSession, title: tabTitle, via: 'server' }, 25_000);
      return NextResponse.json<PtyActionResponse>({ success: true, command: `ssh <server> tmux attach -t ${tmuxSession}` });
    }
    const launch = buildWindowsTerminalAttachLaunch({ title: tabTitle, tmuxSession });
    // PM2 can inherit a WSL_INTEROP socket from a prior WSL lifetime. Resolve
    // and probe a live endpoint before reporting success; otherwise Windows
    // executables fail with EINVAL while the UI appears to do nothing.
    const wslInterop = await resolveWorkingWslInterop();
    // Await the host-side process assertion. A detached spawn only proves that
    // PowerShell started; it would still report success for a failed terminal
    // handoff, which is the failure mode this endpoint must surface to the UI.
    await execFileAsync(launch.file, launch.args, {
      cwd: '/mnt/c',
      env: { ...process.env, WSL_INTEROP: wslInterop },
      timeout: 5_000,
      encoding: 'utf-8',
    });
  } catch (err) {
    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: `Failed to open Windows Terminal tab: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 500 });
  }

  return NextResponse.json<PtyActionResponse>({
    success: true,
    command: `tmux attach -t ${tmuxSession}`,
  });
}

// ---------------------------------------------------------------------------
// Agent workspace setup
// ---------------------------------------------------------------------------

async function ensureIdentityPointer(
  filePath: string,
  pointer: string | null,
  canonicalContent: string | null,
  fallback: string,
): Promise<'created' | 'updated' | 'preserved'> {
  const desired = pointer ? `@${pointer}\n` : fallback;
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, 'utf-8');
  } catch { /* missing is handled below */ }

  if (existing === null) {
    await fs.writeFile(filePath, desired, 'utf-8');
    return 'created';
  }

  const trimmed = existing.trim();
  const replaceable =
    trimmed === desired.trim() ||
    trimmed.startsWith('@' + appPath('data', 'roles')) ||
    /No (?:role-specific directives|directives|personality) configured/i.test(trimmed) ||
    (!!canonicalContent && trimmed === canonicalContent.trim());
  if (!replaceable) return 'preserved';
  if (existing === desired) return 'preserved';
  await fs.writeFile(filePath, desired, 'utf-8');
  return 'updated';
}

const HARNESS_REQUIRED_LOADERS: Record<string, string[]> = {
  // Claude loads CLAUDE.md and its rules directory natively. Validate the
  // durable bootstrap, shared agreement, and runtime alignment explicitly.
  claude: [
    'CLAUDE.md',
    '.claude/rules/startup.md',
    '.claude/rules/base-role-boilerplate.md',
    '.claude/rules/alignment-claude.md',
  ],
  gemini: ['GEMINI.md', 'alignment-gemini.md'],
  grok: ['GROK.md', 'alignment-grok.md'],
  codex: ['AGENTS.md', 'alignment-codex.md'],
  antigravity: ['GEMINI.md', 'alignment-antigravity.md'],
};

/** Normalize legacy/missing harness data to the Claude runtime. */
export function normalizeSpawnAgentType(agentType?: string): string {
  const candidate = agentType?.trim().toLowerCase();
  return candidate && HARNESS_REQUIRED_LOADERS[candidate] ? candidate : 'claude';
}

/**
 * Grok's ACP harness is the Grok Build CLI, not a transport for every xAI
 * model. Sending a grok-4.x roster model through it silently falls back to the
 * CLI's `grok-build` model and can fail after the agent has already joined.
 */
export function shouldUseGrokAcp(model?: string, disableAcp?: boolean): boolean {
  if (disableAcp) return false;
  const candidate = model?.trim().toLowerCase();
  return candidate === 'grok-build' || candidate === 'grok-build-0.1';
}

/**
 * Verify that the harness will be able to load its entry point and every
 * workspace-local `@./` import it reaches.  Sync succeeding is not enough:
 * a stale or incomplete rendered entry point otherwise lets an agent start
 * without its intended rules.
 */
export async function validateHarnessScaffold(
  agentWorkDir: string,
  agentType?: string,
): Promise<void> {
  const runtime = normalizeSpawnAgentType(agentType);
  const workspaceRoot = path.resolve(agentWorkDir);
  const requiredLoaders = HARNESS_REQUIRED_LOADERS[runtime];
  const pending: Array<{ filePath: string; chain: string[] }> = requiredLoaders.map(loader => ({
    filePath: path.resolve(workspaceRoot, loader),
    chain: [loader],
  }));
  const visited = new Set<string>();

  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current.filePath)) continue;
    visited.add(current.filePath);

    let content: string;
    try {
      content = await fs.readFile(current.filePath, 'utf-8');
    } catch (error) {
      throw new Error(
        `missing ${path.relative(workspaceRoot, current.filePath) || current.chain[0]} ` +
        `(required by ${current.chain.join(' -> ')}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const rawLine of content.split(/\r?\n/)) {
      const match = rawLine.trim().match(/^@\.\/([^\s]+)\s*$/);
      if (!match) continue;

      const importedPath = path.resolve(path.dirname(current.filePath), match[1]);
      const relativeImport = path.relative(workspaceRoot, importedPath);
      if (relativeImport === '..' || relativeImport.startsWith(`..${path.sep}`) || path.isAbsolute(relativeImport)) {
        throw new Error(
          `local import @./${match[1]} escapes the agent workspace ` +
          `(from ${current.chain.join(' -> ')})`,
        );
      }
      pending.push({
        filePath: importedPath,
        chain: [...current.chain, relativeImport],
      });
    }
  }
}

export async function setupAgentWorkspace(
  baseWorkDir: string,
  agentName: string,
  roleId?: string,
  personality?: string,
  agentType?: string,
  replacePersonality = false,
  host: string | null = null,
): Promise<string> {
  const safeName = agentName
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'agent';
  const baseNormalized = baseWorkDir.replace(/\/+$/, '');
  const alreadyAgentDir =
    baseNormalized.endsWith(`/Team/${safeName}`) || baseNormalized.endsWith(`/${safeName}`);
  const agentWorkDir = alreadyAgentDir ? baseNormalized : path.join(baseWorkDir, 'Team', safeName);
  const rulesDir = path.join(agentWorkDir, '.claude', 'rules');

  if (host) {
    // Workspace lives on the agent's host: let its caretaker run the scaffolding sync there.
    await hostCall(host, 'sync', { agent: safeName, dir: agentWorkDir, agentType: normalizeSpawnAgentType(agentType) }, 120000);
    return agentWorkDir;
  }

  await fs.mkdir(rulesDir, { recursive: true });

  // Custom display names still need a canonical registry entry for sync.py.
  // Use the dedicated directory name consistently, including later spawns.
  const registryPath = DataPaths.scaffolding.agents;
  // A fresh install has no team list yet; sync.py needs the team 'sg1' to render the agent's files.
  await withFileLock(DataPaths.scaffolding.teams, async () => {
    const existing = await readJsonFile<{ teams?: Array<Record<string, unknown>> } | null>(DataPaths.scaffolding.teams, null);
    if (existing && Array.isArray(existing.teams) && existing.teams.length > 0) return;
    await fs.mkdir(path.dirname(DataPaths.scaffolding.teams), { recursive: true });
    await writeJsonFile(DataPaths.scaffolding.teams, {
      teams: [{ id: 'sg1', name: 'sg1', projectDir: path.dirname(path.dirname(agentWorkDir)), teamDir: path.dirname(agentWorkDir) }],
    });
  });
  await withFileLock(registryPath, async () => {
    const registry = structuredClone(await readJsonFile<{ agents: Array<Record<string, unknown>> }>(registryPath, { agents: [] }));
    if (!registry.agents.some(entry => typeof entry.name === 'string' && entry.name.toLowerCase() === safeName.toLowerCase())) {
      registry.agents.push({
        name: safeName, teamId: 'sg1', role: 'Agent', domain: '',
        models: [normalizeSpawnAgentType(agentType)], agentType: normalizeSpawnAgentType(agentType),
        agentDir: agentWorkDir, teamDir: agentWorkDir,
        projectDir: path.dirname(path.dirname(agentWorkDir)),
      });
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await writeJsonFile(registryPath, registry);
    }
  });

  let roleSlug = '';
  if (roleId) {
    try {
      const rolesJsonPath = appPath('data', 'roles', 'roles.json');
      const rolesRaw = await fs.readFile(rolesJsonPath, 'utf-8');
      const rolesData = JSON.parse(rolesRaw);
      const role = rolesData.roles?.find((r: { id: string }) => r.id === roleId);
      if (role?.slug) roleSlug = role.slug;
    } catch { /* role data optional */ }
  }

  // Identity is not a static manifest file: role and personality vary by
  // roster presence. Keep tiny live pointers so canonical corrections take
  // effect at the next session. Replace only missing/placeholders, existing
  // managed pointers, or an exact canonical frozen copy; preserve ambiguous
  // project-owned prose rather than overwriting it silently.
  const personalityFilePath = await findPersonalityFile(personality || agentName);
  const directivesPath = roleSlug
    ? appPath('data', 'roles', `${roleSlug}.md`)
    : null;
  const [personalityCanonical, directivesCanonical] = await Promise.all([
    personalityFilePath ? readTemplateFile(personalityFilePath) : Promise.resolve(null),
    directivesPath ? readTemplateFile(directivesPath) : Promise.resolve(null),
  ]);
  if (replacePersonality && personalityFilePath) {
    const personalityPath = path.join(rulesDir, 'Personality.md');
    const desired = `@${personalityFilePath}\n`;
    const previous = await fs.readFile(personalityPath, 'utf-8').catch(() => null);
    if (previous !== null && previous !== desired) {
      const historyDir = path.join(agentWorkDir, '.identity-history', randomUUID());
      await fs.mkdir(historyDir, { recursive: true });
      await fs.copyFile(personalityPath, path.join(historyDir, 'Personality.md'));
    }
    await fs.writeFile(personalityPath, desired, 'utf-8');
  }
  await Promise.all([
    ensureIdentityPointer(
      path.join(rulesDir, 'Personality.md'),
      personalityFilePath,
      personalityCanonical,
      `# Personality\n\nNo personality configured yet. Be professional, plain-spoken and helpful.\n`,
    ),
    ensureIdentityPointer(
      path.join(rulesDir, 'Directives.md'),
      directivesCanonical ? directivesPath : null,
      directivesCanonical,
      `# Directives\n\nNo role-specific directives configured. Follow the shared operating agreement.\n`,
    ),
  ]);

  // Provisioning Hardening P1.2 — single-source-of-truth scaffolding. Render the
  // FULL manifest via sync.py (from the masters) instead of the hand-written
  // historical handwritten subset. Runs each (re)spawn; sync only writes on
  // drift, so the re-run I/O is near-zero. If required output is still absent,
  // fail this spawn with one actionable error instead of generating a second,
  // contradictory scaffold.
  try {
    const syncPy = appPath('data', 'scaffolding', 'sync.py');
    const scaffoldRuntime = normalizeSpawnAgentType(agentType);
    try {
      await execFileAsync(
        'python3',
        [
          syncPy,
          '--agent', safeName,
          '--target-dir', agentWorkDir,
          '--agent-type', scaffoldRuntime,
        ],
        { timeout: 30_000 },
      );
    } catch { /* non-zero exit may be benign drift — the outcome check below decides */ }
    // Re-rostering a dormant workspace must not revive historical mandatory
    // logging, session-end writers, or broad completion gates.
    const patchHooksPy = appPath('scripts', 'patch-hooks.py');
    await execFileAsync(
      'python3',
      [patchHooksPy, '--workspace', agentWorkDir, '--agent', agentName],
      { timeout: 30_000 },
    );
    // Identity preparation happens before the roster commit. Targeted sync can
    // therefore reread the old identity for this same directory and restore its
    // managed pointer. The explicitly selected preset wins after that sync.
    // Any original project-owned prose was backed up above before either write.
    if (replacePersonality && personalityFilePath) {
      await fs.writeFile(path.join(rulesDir, 'Personality.md'), `@${personalityFilePath}\n`, 'utf-8');
    }
    // Verify the actual selected harness loader, not merely a generic rule.
    // This walks all local @./ imports recursively, so a missing alignment or
    // global rule stops the spawn with the dependency chain that needs repair.
    await validateHarnessScaffold(agentWorkDir, scaffoldRuntime);
    // sync owns the rendered scaffolding, including the thin CLAUDE.md. PROJECT.md
    // remains project-owned, so expose it through an idempotent symlink.
    for (const docFile of ['PROJECT.md']) {
      const source = path.join(baseWorkDir, docFile);
      const target = path.join(agentWorkDir, docFile);
      try {
        await fs.access(source);
        try {
          await fs.lstat(target);
        } catch {
          await fs.symlink(`../../${docFile}`, target);
        }
      } catch { /* source doesn't exist — skip silently */ }
    }
    return agentWorkDir;
  } catch (syncErr) {
    throw new Error(
      `Canonical scaffolding could not be prepared for "${agentName}" ` +
      `(dir=${agentWorkDir}): ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// flushAgentMemory
// ---------------------------------------------------------------------------

// A genuine restart/shutdown is a continuity boundary, but it must not force a
// write when there is no material state to preserve.
const RESTART_GRACE_PROMPT = `[System] This session restarts in about 20 seconds. If material work is not already preserved, record only the exact resume state/blocker in handoff or a genuinely durable reusable fact in its canonical store. Do not copy routine investigation or the transcript. If nothing material is at risk, no write is required; finish cleanly.`;

const SHUTDOWN_FLUSH_PROMPT = `[System] All agent sessions end in about 20 seconds. Preserve only material unrecorded resume state or a durable reusable fact in its canonical store. Do not create routine journal, memory, or expertise entries merely because shutdown was requested.`;

const GRACE_WINDOW_MS = 20000; // owner 2026-06-05: 20s commit window before kill/respawn

/**
 * Graceful pre-kill flush. Interrupts the agent (only if mid-response), tells it to
 * save the most important context wherever it chooses, then gives it a grace window —
 * returning early once a save completes, else waiting the full cap.
 *
 * Refinements (Reynolds, 2026-06-05):
 *  - C-c ONLY when the agent is actively working/typing (participant.activityStatus).
 *    C-c on an idle TUI does nothing useful and can clear a half-typed buffer / leave
 *    a stray ^C. An idle agent still processes the Enter-submitted prompt like any message.
 *  - Watch a SET of candidate save locations; return on write-COMPLETE (mtime settled),
 *    so a fast saver isn't forced to wait the full 20s, and a cold/large-context agent
 *    that needs the time still gets it (cap).
 *  - Poll-only wrappers (grok/antigravity, no tmux) get the warning via channel message
 *    and we continue — their poll cadence may not deliver within the window (best-effort).
 */
export async function flushAgentMemory(
  channelId: string,
  agent: AgentRosterEntry,
  opts: { prompt?: string; graceMs?: number } = {}
): Promise<void> {
  // Edge / BrowserDev agents (claudeFlags includes '--chrome' — the canonical
  // discriminator, the retired BrowserDev signal) exist for
  // testing + browser-driving only. They have no today.md/journal/MEMORY worth
  // preserving, and being no-tmux their grace prompt would post visibly to the
  // channel as noise (see the else-branch appendMessage below). Skip the grace
  // entirely so they restart instantly and silently. (owner 2026-06-05.)
  if (agent.claudeFlags?.includes('--chrome')) {
    logEvent('agent', 'low', `restart-grace ${agent.name}: skipped (Edge/browser agent — no context to flush)`,
      { event: 'restart-grace', agentName: agent.name, channelId, outcome: 'skipped-edge' }).catch(() => {});
    return;
  }

  const prompt = opts.prompt ?? RESTART_GRACE_PROMPT;
  const graceMs = opts.graceMs ?? GRACE_WINDOW_MS;
  const agentType = agent.agentType || 'claude';
  const agentWorkDir = agent.effectiveWorkingDirectory ?? agent.workingDirectory;

  // Free-choice save locations watched for early-exit. Includes the agent's REAL
  // auto-memory MEMORY.md under ~/.claude/projects/<encoded-workdir>/memory/ (the
  // path Claude Code derives by replacing '/' with '-' in the launch cwd), so a save
  // there triggers early-exit too. The 20s cap still covers any other location.
  const memoryMd = path.join(homedir(), '.claude', 'projects', agentWorkDir.replace(/\//g, '-'), 'memory', 'MEMORY.md');
  const candidatePaths = [
    path.join(agentWorkDir, 'logs', 'today.md'),
    path.join(agentWorkDir, 'logs', 'handoff.md'),
    path.join(agentWorkDir, 'handoff.md'),
    path.join(agentWorkDir, 'MEMORY.md'),
    path.join(agentWorkDir, 'Expertise.md'),
    path.join(agentWorkDir, '.session-scratch', 'journal.md'),
    memoryMd,
  ];
  // An agent whose folders are on the agent host saves there, not on this machine: ask the host (same file names, its own home).
  const filesHost = filesHostFor(agent);
  const snapshot = async (): Promise<Map<string, number>> => {
    if (filesHost) {
      try {
        const r = await hostCall<{ mtimes?: Record<string, number> }>(filesHost, 'save-mtimes', { dir: agentWorkDir }, 8_000);
        return new Map(Object.entries(r?.mtimes ?? {}));
      } catch { return new Map(); }                         // host not answering: no early exit, the full cap still applies
    }
    const m = new Map<string, number>();
    for (const p of candidatePaths) {
      try { m.set(p, (await fs.stat(p)).mtimeMs); } catch { m.set(p, 0); }
    }
    return m;
  };

  const hasTmux = !!agent.tmuxSessionName && agentType !== 'grok' && agentType !== 'antigravity';

  // ccDecision is recorded for observability (see the restart-grace log at the end).
  let ccDecision: 'fired' | 'skipped-stale-or-idle' | 'n/a-poll-only' = 'n/a-poll-only';

  if (hasTmux) {
    // Only interrupt if the agent is mid-response — never C-c an idle TUI.
    // Require the activity signal to be FRESH: a stale 'working' status (no recent
    // heartbeat) means the agent has actually gone idle since, and C-c'ing it would
    // clear a half-typed buffer / leave a stray ^C. Active agents heartbeat every 5s
    // (idle every 30s), so a 15s window reliably catches a genuinely-busy agent while
    // rejecting a stale-'working' idle one. Erring toward NOT-C-c is the safe direction
    // — a busy agent we don't interrupt just has the prompt queued behind its turn.
    // (CJack 2026-06-05, after a 2h-stale 'working' status on a test agent.)
    let isBusy = false;
    try {
      const data = await readChannelsData();
      const ch = data.channels.find(c => c.id === channelId);
      const p = ch?.participants.find(pp => pp.id === agent.participantId);
      const fresh = p?.activityUpdatedAt ? (Date.now() - Date.parse(p.activityUpdatedAt) < 15_000) : false;
      isBusy = fresh && (p?.activityStatus === 'working' || p?.activityStatus === 'typing');
    } catch { /* default: treat as not busy → skip C-c */ }
    if (isBusy) {
      ccDecision = 'fired';
      try { await tmuxRun(['send-keys', '-t', agent.tmuxSessionName!, 'C-c']); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 2000)); // settle: let agent return to prompt
    } else {
      ccDecision = 'skipped-stale-or-idle';
    }
    // Enter-submit so an idle agent processes the prompt like any injected message.
    // Text and Enter as separate steps: one burst is read as a paste and never submits.
    try { await tmuxSendKeys(agent.tmuxSessionName!, prompt); } catch { /* ignore */ }
  } else {
    // Poll-only / no-tmux wrapper — deliver via channel message and continue (best-effort).
    try {
      const ts = new Date().toISOString();
      await appendMessage(channelId, {
        id: randomUUID(),
        channelId,
        from: { id: 'system', type: 'user', name: 'System', source: 'DevFlow', joinedAt: ts, lastSeen: ts },
        content: prompt,
        timestamp: ts,
        mentions: [agent.participantId],
        system: true,
        metadata: { isHidden: true },
      });
    } catch { /* ignore */ }
  }

  // Grace window: return once a save completes (mtime bumped then settled ~1s),
  // else wait the full cap so a save to any location finishes before the kill.
  const start = Date.now();
  let prev = await snapshot();
  let lastChangeAt = 0;
  let savedFile: string | null = null;
  const logOutcome = (outcome: 'early-exit' | 'cap') => {
    logEvent('agent', 'low',
      `restart-grace ${agent.name}: cc=${ccDecision} outcome=${outcome}${savedFile ? ' saved=' + savedFile : ''} ${Date.now() - start}ms`,
      { event: 'restart-grace', agentName: agent.name, channelId, agentType, cc: ccDecision, outcome, savedFile, durationMs: Date.now() - start },
    ).catch(() => {});
  };
  while (Date.now() - start < graceMs) {
    await new Promise(r => setTimeout(r, 500));
    const cur = await snapshot();
    let changed = false;
    for (const [p, mtime] of cur) {
      if (mtime > (prev.get(p) ?? 0)) { changed = true; if (!savedFile) savedFile = path.basename(p); break; }
    }
    if (changed) { lastChangeAt = Date.now(); prev = cur; }
    if (lastChangeAt && Date.now() - lastChangeAt >= 1000) { logOutcome('early-exit'); return; } // write settled
  }
  logOutcome('cap');
}

// ---------------------------------------------------------------------------
// handleRosterSpawn (internal)
// ---------------------------------------------------------------------------

export async function handleRosterSpawn(
  channelId: string,
  agentId: string,
  now: string,
  skipResponse = false,
  rehydrate?: boolean,
  excludePid?: number,
  replace = false
): Promise<NextResponse<PtyActionResponse>> {
  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === channelId);
  if (!channel?.roster) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Channel or roster not found' }, { status: 404 });
  }

  const agent = channel.roster.agents.find(a => a.id === agentId);
  if (!agent) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent not found in roster' }, { status: 404 });
  }

  if (agent.status === 'running' || agent.status === 'starting') {
    if (agent.tmuxSessionName) {
      const alive = await tmuxSessionExists(agent.tmuxSessionName);
      if (!alive) {
        agent.status = 'stopped';
      } else {
        return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent is already running' }, { status: 400 });
      }
    } else if (agent.status === 'starting') {
      // Stale 'starting' with no tmux session — reset and allow respawn
      agent.status = 'stopped';
    } else if (isWindowsPerMessageAgent(agent) && agent.ptySessionId && !isPtySessionActive(agent.ptySessionId)) {
      // Powershell (per-message) agent marked running but session not in activeSessions —
      // in-memory state was lost on DevFlow restart. Reset so respawn can proceed.
      agent.status = 'stopped';
    } else {
      return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent is already running' }, { status: 400 });
    }
  }

  if (isWindowsPerMessageAgent(agent) && !(await windowsSpawnAvailable())) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: WINDOWS_SPAWN_UNAVAILABLE }, { status: 400 });
  }

  const channelName = channel.name;
  agent.status = 'starting';
  agent.lastStartedAt = now;

  let alreadyStarting = false;
  await mutateChannels('pty-spawn:pre-launch', async freshData => {
    const freshChannel = freshData.channels.find(c => c.id === channelId);
    if (freshChannel?.roster) {
      const freshAgent = freshChannel.roster.agents.find(a => a.id === agentId);
      if (freshAgent) {
        if (freshAgent.status === 'starting' || freshAgent.status === 'running') {
          if (freshAgent.tmuxSessionName) {
            const alive = await tmuxSessionExists(freshAgent.tmuxSessionName);
            if (alive) { alreadyStarting = true; return; }
          } else if (freshAgent.status === 'running') {
            // Powershell agents: in-memory session may be lost after restart — check before blocking
            if (isWindowsPerMessageAgent(freshAgent) && freshAgent.ptySessionId && !isPtySessionActive(freshAgent.ptySessionId)) {
              // Session lost (DevFlow restart) — allow respawn
            } else {
              alreadyStarting = true;
              return;
            }
          }
          // status === 'starting' with no tmux session — stale, allow respawn
        }
        freshAgent.status = 'starting';
        freshAgent.lastStartedAt = now;
      }
      freshChannel.roster.lastUpdated = now;

      if (freshChannel.blockedParticipantIds?.length) {
        const effectiveDir = agent!.effectiveWorkingDirectory || agent!.workingDirectory || '';
        const identityString = [agent!.name, 'claude-terminal', effectiveDir].join(':');
        const hash = createHash('sha256').update(identityString).digest('hex');
        const stableId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
        const nameBlock = `name:${agent!.name}`;
        freshChannel.blockedParticipantIds = freshChannel.blockedParticipantIds.filter(
          id => id !== agent!.participantId && id !== stableId && id !== nameBlock
        );
      }

      const existingIdx = freshChannel.participants.findIndex(p => p.id === agent!.participantId);
      if (existingIdx >= 0) {
        freshChannel.participants[existingIdx].lastSeen = now;
        freshChannel.participants[existingIdx].name = agent!.name;
        reconcileParticipantWithRoster(freshChannel, freshChannel.participants[existingIdx]);
      } else {
        // The roster entry decides the runtime: a Codex seat created as a
        // Claude terminal is refused every durable claim.
        freshChannel.participants.push(buildSeatParticipant(agent!, now));
      }

      await saveChannels(freshData);
    }
  });

  if (alreadyStarting) {
    return NextResponse.json<PtyActionResponse>({ success: false, error: 'Agent is already starting (concurrent request)' }, { status: 409 });
  }

  try {
    const orphansKilled = await killOrphanedWrapperProcesses(agent.name, channelId, excludePid);
    if (orphansKilled > 0) {
      await new Promise(r => setTimeout(r, 500));
    }

    const availableMB = await getAvailableMemoryMB();
    if (availableMB !== null && availableMB < MIN_MEMORY_FOR_SPAWN_MB) {
      await mutateChannels('pty-spawn:low-memory-stop', async freshData => {
        const freshChannel = freshData.channels.find(c => c.id === channelId);
        if (freshChannel?.roster) {
          const freshAgent = freshChannel.roster.agents.find(a => a.id === agentId);
          if (freshAgent) freshAgent.status = 'stopped';
          freshChannel.roster.lastUpdated = new Date().toISOString();
          await saveChannels(freshData);
        }
      });

      await appendMessage(channelId, {
        id: randomUUID(),
        channelId,
        from: { id: 'system', type: 'user' as const, name: 'System', source: 'DevFlow', joinedAt: new Date().toISOString(), lastSeen: new Date().toISOString() },
        content: `Cannot start agent "${agent.name}" — insufficient memory. Only ${availableMB}MB available, need at least ${MIN_MEMORY_FOR_SPAWN_MB}MB. Close other agents or free memory first.`,
        timestamp: new Date().toISOString(),
      });

      logEvent('agent', 'critical', `Spawn blocked for ${agent.name} — low memory (${availableMB}MB available)`, {
        event: 'spawn-blocked', agentName: agent.name, channelId, channelName,
        availableMemoryMB: availableMB, thresholdMB: MIN_MEMORY_FOR_SPAWN_MB,
      }).catch(() => {});

      return NextResponse.json<PtyActionResponse>({
        success: false,
        error: `Insufficient memory to spawn agent. Only ${availableMB}MB available, need ${MIN_MEMORY_FOR_SPAWN_MB}MB.`,
      }, { status: 503 });
    }

    let resumeId = agent.autoResume && agent.lastClaudeSessionId ? agent.lastClaudeSessionId : undefined;
    if (resumeId) {
      const checkData = await readChannelsData();
      outer: for (const ch of checkData.channels) {
        for (const ag of ch.roster?.agents || []) {
          if (ag.id !== agentId && ag.lastClaudeSessionId === resumeId && ag.status === 'running') {
            resumeId = undefined;
            break outer;
          }
        }
      }
    }

    // Legacy roster records may not have a harness value. Treat that as Claude
    // consistently for both scaffold validation and the launcher below.
    const spawnAgentType = normalizeSpawnAgentType(agent.agentType);
    const effectiveWorkDir = await setupAgentWorkspace(
      agent.workingDirectory, agent.name, agent.roleId, agent.personality, spawnAgentType,
      false, filesHostFor(agent),
    );

    const preSpawnFiles = await snapshotSessionFiles(effectiveWorkDir, agent.model, spawnAgentType);

    const effectiveFlags = [...(agent.claudeFlags || [])];
    // Resolve the short id (sonnet/opus/haiku) to its canonical apiId so the
    // CLI routes to the 1M-context variant (sonnet → claude-sonnet-4-6[1m]).
    const effectiveModel = agent.model ? resolveApiIdForModel(agent.model) : undefined;
    if (effectiveModel && !effectiveFlags.includes('--model')) {
      effectiveFlags.push('--model', effectiveModel);
    }
    // Claude Code's automatic model-capability lookup can lag newly released
    // 1M aliases. In that state it assumes a 200K window and auto-compacts at
    // ~168K even though DevFlow selected a registry-declared 1M model. Pin a
    // conservative 800K compaction boundary for Claude harnesses so a fresh
    // Fable/Mythos/Opus/Sonnet session does not compact after one tool-heavy
    // turn. Explicit roster flags still win.
    const configuredContextWindow = agent.model
      ? resolveContextWindowForModel(agent.model)
      : null;
    if (
      spawnAgentType === 'claude' &&
      configuredContextWindow !== null &&
      configuredContextWindow >= 1_000_000 &&
      !effectiveFlags.includes('--autocompact')
    ) {
      effectiveFlags.push('--autocompact', '800k');
    }
    // 2026-05-22: per-session reasoning effort. `claude --effort <level>` accepts
    // low | medium | high | xhigh | max. Set on the roster, picked up at spawn —
    // changes take effect on next respawn, not mid-session (matches how
    // --model + spawnMode propagate). Whitelisted to prevent shell injection
    // even though execFile would already block it.
    const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
    const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    if (
      agent.effort &&
      (CLAUDE_EFFORTS as readonly string[]).includes(agent.effort) &&
      !effectiveFlags.includes('--effort')
    ) {
      effectiveFlags.push('--effort', agent.effort);
    }

    let roleTempFile: string | undefined;
    if (agent.roleId) {
      try {
        const rolesJsonPath = appPath('data', 'roles', 'roles.json');
        const rolesRaw = await fs.readFile(rolesJsonPath, 'utf-8');
        const rolesData = JSON.parse(rolesRaw);
        type RoleDef = { id: string; slug?: string; mdPath?: string; spawnMode?: string; claudeFlags?: string[] };
        const role = rolesData.roles?.find((r: RoleDef) => r.id === agent!.roleId) as RoleDef | undefined;

        // Heal missing spawnMode / claudeFlags from role defaults.
        // Old agent records provisioned before role defaults existed may lack these fields,
        // causing WSL tmux fallback instead of the correct powershell/chrome spawn.
        if (role) {
          let healed = false;
          if (!agent.spawnMode && role.spawnMode) { agent.spawnMode = role.spawnMode as 'wsl' | 'powershell'; healed = true; }
          if ((!agent.claudeFlags || !agent.claudeFlags.length) && role.claudeFlags?.length) {
            agent.claudeFlags = role.claudeFlags; healed = true;
          }
          if (healed) {
            await mutateChannels('pty-spawn:heal-role-defaults', async freshData => {
              const freshCh = freshData.channels.find(c => c.id === channelId);
              const freshAg = freshCh?.roster?.agents.find(a => a.id === agentId);
              if (freshAg) {
                if (!freshAg.spawnMode && role!.spawnMode) freshAg.spawnMode = role!.spawnMode as 'wsl' | 'powershell';
                if ((!freshAg.claudeFlags || !freshAg.claudeFlags.length) && role!.claudeFlags?.length) {
                  freshAg.claudeFlags = role!.claudeFlags;
                }
                if (freshCh?.roster) freshCh.roster.lastUpdated = now;
                await saveChannels(freshData);
              }
            });
          }
        }

        if (role?.slug) {
          const roleMdPath = role.mdPath
            ? appPath(role.mdPath)
            : appPath('data', 'roles', `${role.slug}.md`);
          const roleMdContent = await fs.readFile(roleMdPath, 'utf-8');
          if (roleMdContent.trim()) {
            // The canonical role is already loaded through the local
            // Directives.md pointer created by setupAgentWorkspace. Do not append
            // the same body as a second system prompt. Frontmatter remains useful
            // to the Claude harness as a capability guard.
            const allowedTools = getEffectiveToolsForRole(roleMdContent);
            if (allowedTools && allowedTools.length > 0 && !effectiveFlags.includes('--allowedTools')) {
              effectiveFlags.push('--allowedTools', buildAllowedToolsFlag(allowedTools));
            }
          }
        }
      } catch { /* role load optional */ }
    }

    try {
      const tasksRaw = await readJsonFile<{ tasks: { channelId: string; assigneeId?: string; status: string; id: string; title: string; description?: string }[]; lastUpdated: string }>(DataPaths.collabTasks, { tasks: [], lastUpdated: '' });
      const activeTasks = tasksRaw.tasks.filter(
        t => t.channelId === channelId && t.assigneeId === agent!.participantId && t.status === 'in_progress'
      );
      if (activeTasks.length > 0) {
        const taskLines = buildActiveTaskLines(activeTasks);
        const taskBlock = buildActiveTaskContext(taskLines);
        const spawnTempFile = `/tmp/role-prompt-${agentId}.md`;
        if (roleTempFile) {
          const existing = await fs.readFile(roleTempFile, 'utf-8');
          await fs.writeFile(roleTempFile, existing + taskBlock, 'utf-8');
        } else {
          await fs.writeFile(spawnTempFile, taskBlock.trimStart(), 'utf-8');
          roleTempFile = spawnTempFile;
        }
      }
    } catch { /* task injection optional */ }

    // Sprint 40: rehydrate context injection
    const rehydrateContent = buildRehydrateBlock(rehydrate);
    if (rehydrateContent) {
      try {
        const rehydrateTempFile = `/tmp/role-prompt-${agentId}.md`;
        if (roleTempFile) {
          const existing = await fs.readFile(roleTempFile, 'utf-8');
          await fs.writeFile(roleTempFile, existing + '\n' + rehydrateContent, 'utf-8');
        } else {
          await fs.writeFile(rehydrateTempFile, rehydrateContent.trimStart(), 'utf-8');
          roleTempFile = rehydrateTempFile;
        }
      } catch { /* rehydrate injection optional */ }
    }

    // The normalized harness value is the single selector for both scaffold
    // loading and process launch. In particular, a missing legacy value means
    // Claude rather than guessing a different launcher from the model name.
    const isAntigravity = spawnAgentType === 'antigravity';
    const isCodex = spawnAgentType === 'codex';
    const isGrok = spawnAgentType === 'grok';
    const isGemini = spawnAgentType === 'gemini';
    let customCommand: string | undefined;
    let preGeneratedSessionId: string | undefined;
    let alreadyCreatesSession = false;
    let codexPsLaunchCwd: string | undefined;
    if (isGemini) {
      const geminiArgs = [
        'python3', `${getDevflowHome()}/scripts/collab-agent.py`,
        `--name "${agent.name}"`, `--channel "${channelId}"`, 'gemini', '--yolo',
      ];
      if (agent.model) geminiArgs.push(`--model "${agent.model}"`);
      customCommand = geminiArgs.join(' ');
    } else if (isGrok) {
      // ACP belongs only to the Grok Build model family. Grok 4.x models use
      // the direct xAI API wrapper and reach model-neutral capabilities through
      // documented CLI fallbacks.
      const useAcp = shouldUseGrokAcp(agent.model, agent.disableAcp);
      const grokBin = useAcp
        ? `${getDevflowHome()}/scripts/collab-grok-acp.py`
        : `${getDevflowHome()}/scripts/collab-grok.py`;
      const grokArgs = [
        'python3', grokBin,
        `--name "${agent.name}"`, `--channel "${channelId}"`,
      ];
      if (agent.model) grokArgs.push(`--model "${agent.model}"`);
      if (roleTempFile) grokArgs.push(`--system-prompt-file "${roleTempFile}"`);
      customCommand = grokArgs.join(' ');
    } else if (isCodex) {
      if (agent.spawnMode === 'powershell') {
        // Codex on Windows (parity build): a persistent WSL/tmux session supervises
        // a Windows pwsh.exe process that boots the Windows-native Codex app-server
        // wrapper. Deliberately NOT the Claude per-message windows path — the tmux
        // session is the lifecycle handle, so isWindowsPerMessageAgent() stays
        // Claude-only and every lifecycle branch treats codex+ps like a tmux agent.
        //
        // Verified launch constraints (canary battery, 2026-09-07 — evidence doc
        // SG-1/plans/evidence/codex-powershell/findings.md):
        //  * A Windows .exe launched from a non-/mnt WSL cwd dies with "Invalid
        //    argument", so the tmux launch cwd MUST be a /mnt path. We override the
        //    spawn workingDirectory to the /mnt drive root below; the ps1 itself
        //    Set-Location's to the real Windows agent dir ($Cwd).
        //  * pwsh cannot -File a \\wsl$ UNC path (the WSL share is invisible to the
        //    interop-launched process — Test-Path returns False), so the wrapper
        //    scripts must live on a Windows drive. DEVFLOW_WIN_SCRIPTS_DIR names it.
        //  * Values pass as plain single-quoted tokens; WSL interop re-quotes any
        //    spaces on the Windows side. Inner double-quoting breaks the interop.
        const winScriptsDir = process.env.DEVFLOW_WIN_SCRIPTS_DIR || 'C:\\DevFlow\\scripts';
        const ps1Path = `${winScriptsDir}\\collab-codex-win.ps1`;
        const psCwd = agent.psWorkingDirectory || getDefaultPsWorkingDirectory(agent.name);
        // Stage the canonical launch package to the Windows drive before building
        // the command — atomic, content-compared, hash-verified. Throws (→ the
        // spawn fails) rather than launch pwsh against drifted or partial scripts.
        await stageCodexWindowsPackage(winScriptsDir);
        const codexPsEffort = agent.effort && (VALID_EFFORTS as readonly string[]).includes(agent.effort)
          ? agent.effort
          : 'medium';
        const q = (v: string) => `'${v}'`;
        const codexPsArgs = [
          'pwsh.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', q(ps1Path),
          '-Channel', q(channelId),
          '-Name', q(agent.name),
          '-Cwd', q(psCwd),
          '-AgentName', q(agent.name),
          '-AgentDir', q(psCwd),
          '-Effort', codexPsEffort,
          '-FastMode', agent.fastMode === true ? 'enabled' : 'disabled',
          '-PermissionMode', 'full-access',
        ];
        if (agent.model) codexPsArgs.push('-Model', q(agent.model));
        customCommand = codexPsArgs.join(' ');
        // Launch cwd must resolve to a valid Windows path or the interop launch
        // fails; the drive root always exists and the ps1 relocates to $Cwd.
        const psDrive = /^([A-Za-z]):/.exec(psCwd)?.[1]?.toLowerCase() ?? 'c';
        codexPsLaunchCwd = `/mnt/${psDrive}`;
      } else {
        // Codex reads system prompt from AGENTS.md in cwd (deployed by scaffolding sync.py
        // when 'codex' is in agents.json[].models). No --system-prompt-file flag.
        // --profile agentchat selects compatibility defaults; the wrapper passes
        // the roster model, effort, sandbox, and approval mode explicitly.
        const codexArgs = [
          'python3', `${getDevflowHome()}/scripts/collab-codex.py`,
          `--name "${agent.name}"`, `--channel "${channelId}"`,
          `--agent-name "${agent.name}"`, `--agent-dir "${effectiveWorkDir}"`,
          '--profile', 'agentchat',
        ];
        // Resolve through the registry so a retired id kept as an alias
        // (e.g. gpt-6-sol -> gpt-6.1-sol) launches its replacement.
        if (agent.model) codexArgs.push(`--model "${resolveApiIdForModel(agent.model)}"`);
        // Always pin both controls for Codex. The `agentchat` profile is shared;
        // leaving either implicit would let another agent's persisted /model or
        // /fast choice leak into this session on restart.
        const codexEffort = agent.effort && (VALID_EFFORTS as readonly string[]).includes(agent.effort)
          ? agent.effort
          : 'medium';
        codexArgs.push(`--effort "${codexEffort}"`);
        codexArgs.push('--fast-mode', agent.fastMode === true ? 'enabled' : 'disabled');
        customCommand = codexArgs.join(' ');
      }
    } else if (isAntigravity) {
      // Two-pane interactive spawn via agy-launch.sh.
      // Pane 0: agy -i (interactive, the owner-facing — the terminal-button lands here)
      // Pane 1: collab-antigravity.py wrapper daemon (background @mention automation)
      // The launch script creates its own tmux session, so we pre-generate the
      // session ID and pass it to both the script and collab-pty.ts.
      preGeneratedSessionId = randomUUID();
      const tmuxSessionName = `collab-agent-${preGeneratedSessionId.slice(0, 8)}`;
      const launchScript = `${getDevflowHome()}/scripts/agy-launch.sh`;
      const agyArgs = agyLaunchArgs({
        launchScript, name: agent.name, channelId, workDir: effectiveWorkDir, tmuxSession: tmuxSessionName,
        model: agent.model, effort: agent.effort,
      });
      customCommand = agyArgs.join(' ');
      alreadyCreatesSession = true;
    }

    const isNonClaude = isGemini || isGrok || isCodex || isAntigravity;
    const useWindowsSpawn = agent.spawnMode === 'powershell' && !isNonClaude;

    const spawnOptions = {
      channelId, channelName,
      participantName: agent.name,
      workingDirectory: codexPsLaunchCwd ?? effectiveWorkDir,
      useCollabWrapper: isNonClaude ? false : (useWindowsSpawn ? false : agent.useCollabWrapper),
      dangerouslySkipPermissions: true,
      claudeFlags: isNonClaude ? [] : effectiveFlags,
      appendSystemPromptFile: isNonClaude ? undefined : roleTempFile,
      resumeSessionId: isNonClaude ? undefined : resumeId,
      rosterAgentId: agentId,
      participantId: agent.participantId,
      participantColor: agent.color,
      customCommand,
      spawnMode: agent.spawnMode,
      runLocation: agent.runLocation,
      host: (agent as { host?: string }).host,
      sessionId: preGeneratedSessionId,
      alreadyCreatesSession,
      replace,
      onData: async () => {},
      onEnd: async () => {},
      onError: async (error: Error) => { console.error(`[PTY API] Roster agent "${agent!.name}" error:`, error); },
      onStatusChange: async () => {},
    };

    const { session, participant } = useWindowsSpawn
        ? await spawnWindowsPtySession(spawnOptions)
        : await spawnCollabPtySession(spawnOptions);

    await mutateChannels('pty-spawn:post-launch', async freshData => {
      const freshChannel = freshData.channels.find(c => c.id === channelId);
      if (freshChannel?.roster) {
        const freshAgent = freshChannel.roster.agents.find(a => a.id === agentId);
        if (freshAgent) {
          freshAgent.status = 'running';
          freshAgent.pid = session.pid;
          // Non-Claude harnesses use WSL/tmux. Self-heal a legacy roster record
          // that retained PowerShell mode across a harness switch — EXCEPT Codex,
          // whose powershell mode is the intentional Windows-native parity path
          // (a tmux-supervised pwsh.exe, not the Claude per-message spawn).
          if (!useWindowsSpawn && freshAgent.spawnMode === 'powershell' && freshAgent.agentType !== 'codex') {
            freshAgent.spawnMode = undefined;
          }
          // Powershell agents don't have tmux sessions — don't set tmuxSessionName
          // to avoid confusing the UI's "Open Terminal" button into trying to attach
          if (!useWindowsSpawn) {
            freshAgent.tmuxSessionName = `collab-agent-${session.id.slice(0, 8)}`;
          }
          freshAgent.ptySessionId = session.id;
          freshAgent.effectiveWorkingDirectory = effectiveWorkDir;
          freshAgent.crashCount = 0;
        }
        freshChannel.roster.lastUpdated = now;

        // Determine the effective participant ID to use for delivery routing.
        // For windows-pm agents: use pty-{sessionId} so collab-delivery.ts routes
        // channel messages through sendToPty() instead of the file-based inbox.
        const isWindowsPm = useWindowsSpawn;
        const effectiveParticipantId = isWindowsPm ? `pty-${session.id}` : agent!.participantId;

        if (isWindowsPm && freshAgent) {
          // Re-key the participant entry and update the roster reference
          const oldIdx = freshChannel.participants.findIndex(p => p.id === freshAgent!.participantId);
          if (oldIdx >= 0) {
            freshChannel.participants[oldIdx].id = effectiveParticipantId;
            freshChannel.participants[oldIdx].lastSeen = now;
            freshChannel.participants[oldIdx].pid = session.pid;
          } else {
            freshChannel.participants.push({
              id: effectiveParticipantId,
              type: 'claude-terminal',
              name: freshAgent.name,
              source: 'DevFlow PTY',
              joinedAt: now,
              lastSeen: now,
              color: freshAgent.color,
              pid: session.pid,
            });
          }
          freshAgent.participantId = effectiveParticipantId;
        } else {
          const existingIdx = freshChannel.participants.findIndex(p => p.id === agent!.participantId);
          if (existingIdx >= 0) {
            freshChannel.participants[existingIdx].lastSeen = now;
            freshChannel.participants[existingIdx].pid = session.pid;
          }
        }

        freshChannel.messages.push({
          id: randomUUID(), channelId,
          from: { id: 'system', type: 'user', name: 'System', source: 'DevFlow', joinedAt: now, lastSeen: now },
          content: resumeId
            ? `Agent "${agent!.name}" respawned (resuming session)${agent!.model ? ` [${agent!.model}]` : ''}`
            : `Agent "${agent!.name}" spawned in ${effectiveWorkDir}${agent!.model ? ` [${agent!.model}]` : ''}`,
          timestamp: now,
        });
        freshChannel.lastActivity = now;
        await saveChannels(freshData);
      }
    });

    const captureSessionId = async (delayMs: number) => {
      await new Promise(r => setTimeout(r, delayMs));
      try {
        const excludeIds = new Set<string>();
        const freshForExclude = await readChannelsData();
        for (const ch of freshForExclude.channels) {
          for (const ag of ch.roster?.agents || []) {
            if (ag.id !== agentId && ag.lastClaudeSessionId) excludeIds.add(ag.lastClaudeSessionId);
          }
        }
        const capturedId = await captureClaudeSessionId(effectiveWorkDir, session.pid, preSpawnFiles, excludeIds, agent!.model, agent!.agentType);
        if (capturedId) {
          await mutateChannels('pty-spawn:capture-session-id', async freshData => {
            const freshChannel = freshData.channels.find(c => c.id === channelId);
            const freshAgent = freshChannel?.roster?.agents.find(a => a.id === agentId);
            if (freshAgent?.ptySessionId === session.id) {
              freshAgent.lastClaudeSessionId = capturedId;
              await saveChannels(freshData);
            }
            if (freshChannel?.teamId) {
              syncSessionIdsToTeam(freshChannel.teamId, channelId).catch(console.error);
            }
          });
          return true;
        }
        return false;
      } catch { return false; }
    };

    captureSessionId(8000).then(success => { if (!success) captureSessionId(12000); });

    logEvent('agent', 'info', `${agent.name} spawned`, {
      event: 'spawn', agentName: agent.name, channelId, channelName,
      tmuxSession: `collab-agent-${session.id.slice(0, 8)}`, pid: session.pid, trigger: 'manual',
    }).catch(() => {});

    return NextResponse.json<PtyActionResponse>({ success: true, session, participant });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Failed to spawn agent';
    await mutateChannels('pty-spawn:failed', async freshData => {
      const freshChannel = freshData.channels.find(c => c.id === channelId);
      const freshAgent = freshChannel?.roster?.agents.find(a => a.id === agentId);
      if (freshAgent) {
        freshAgent.status = 'stopped';
        freshAgent.pid = undefined;
        freshAgent.tmuxSessionName = undefined;
        freshAgent.ptySessionId = undefined;
        const participant = freshChannel?.participants.find(p => p.id === freshAgent.participantId);
        if (participant) { participant.activityStatus = 'idle'; participant.activityUpdatedAt = now; }
      }
      if (freshChannel?.roster) freshChannel.roster.lastUpdated = now;
      await saveChannels(freshData);
    });

    // Chrome circuit-breaker: --chrome agents failing with empty stderr (= extension
    // unavailable) produce identical error messages on every retry. After 3 consecutive
    // failures, suppress further duplicates and post a single "paused" notice instead.
    let freshCrashCount = 0;
    try {
      const peekData = await readChannelsData();
      const peekAgent = peekData.channels.find(c => c.id === channelId)
        ?.roster?.agents.find(a => a.id === agentId);
      freshCrashCount = peekAgent?.crashCount || 0;
    } catch { /* non-fatal */ }

    const CHROME_CIRCUIT_BREAK = 3;
    const hasChrome = (agent?.claudeFlags || []).includes('--chrome');
    const isExtensionUnavailable = errMsg.includes('empty stderr');

    if (hasChrome && isExtensionUnavailable) {
      if (freshCrashCount < CHROME_CIRCUIT_BREAK) {
        appendMessage(channelId, {
          id: randomUUID(), channelId,
          from: { id: 'system', type: 'user' as const, name: 'System', source: 'DevFlow', joinedAt: now, lastSeen: now },
          content: `⚠️ Failed to spawn agent "${agent?.name || agentId}": ${errMsg}`,
          timestamp: now,
        }).catch(() => {});
      } else if (freshCrashCount === CHROME_CIRCUIT_BREAK) {
        // One-time "paused" notice — go quiet after this
        appendMessage(channelId, {
          id: randomUUID(), channelId,
          from: { id: 'system', type: 'user' as const, name: 'System', source: 'DevFlow', joinedAt: now, lastSeen: now },
          content: `⏸️ Agent "${agent?.name || agentId}" paused — Chrome/Edge extension unavailable after ${CHROME_CIRCUIT_BREAK} consecutive timeouts. Start Edge with the Claude extension active, then call roster.spawn to retry. No further error messages will be posted.`,
          timestamp: now,
        }).catch(() => {});
      }
      // Above threshold: suppress — channel already has the paused notice
    } else {
      // Non-chrome or chrome with a real error — always post
      appendMessage(channelId, {
        id: randomUUID(),
        channelId,
        from: { id: 'system', type: 'user' as const, name: 'System', source: 'DevFlow', joinedAt: now, lastSeen: now },
        content: `⚠️ Failed to spawn agent "${agent?.name || agentId}": ${errMsg}`,
        timestamp: now,
      }).catch(() => {});
    }

    return NextResponse.json<PtyActionResponse>({
      success: false,
      error: errMsg,
    }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// handleRosterKill (internal, exported for roster_respawn + roster_launch_all)
// ---------------------------------------------------------------------------

export async function stopRosterAgentRuntime(
  agent: Pick<AgentRosterEntry, 'spawnMode' | 'ptySessionId' | 'tmuxSessionName' | 'pid' | 'agentType'>
): Promise<void> {
  if (isWindowsPerMessageAgent(agent) && agent.ptySessionId) {
    await forceKillPtySession(agent.ptySessionId);
  } else if (agent.tmuxSessionName) {
    await forceKillByTmuxName(agent.tmuxSessionName, agent.pid);
  } else if (agent.pid) {
    await safeKillProcess(agent.pid);
    await cleanupTempFiles(agent.pid);
  }
}

export async function handleRosterKill(
  channelId: string,
  agentId: string,
  now: string,
  silent = false,
  skipFlush = false
): Promise<NextResponse<PtyActionResponse>> {
  let killedAgentName: string | undefined;

  if (!skipFlush) {
    try {
      const channelsData = await readChannelsData();
      const channel = channelsData.channels.find(c => c.id === channelId);
      const agent = channel?.roster?.agents.find(a => a.id === agentId);
      // Flush ONLY if the session is actually ALIVE — not merely status==='running'.
      // A startup-recovery respawn (instrumentation.ts) targets agents that are
      // 'running' in the roster but whose real session was LOST on the server
      // restart (powershell pty sessions live in-memory; tmux sessions are checked
      // directly). A dead/zombie-running session has nothing to save, so gracing it
      // would just spam the channel (poll-only agents) on every rebuild. This keeps
      // grace for genuine live-session restarts without a user-reachable skipGrace
      // flag. (CJack 2026-06-05, after Reynolds flagged the rebuild over-fire.)
      let sessionLive = false;
      if (agent && agent.status === 'running') {
        if (agent.tmuxSessionName) {
          // tmux agent (claude/codex/gemini) — session is OS-level, survives a server
          // restart; check it directly.
          sessionLive = await tmuxSessionExists(agent.tmuxSessionName);
        } else if (isWindowsPerMessageAgent(agent) && agent.ptySessionId) {
          // powershell/Edge — pty session lives in-memory, LOST on server restart.
          // This is the case that caused the rebuild mis-fire; isPtySessionActive
          // returns false for a startup-recovered Edge → skip flush.
          sessionLive = isPtySessionActive(agent.ptySessionId);
        } else {
          // Poll-only agent (grok/antigravity — no tmux, no pty handle). These are
          // NEVER startup-auto-respawned (only powershell is), so a restart here is
          // intentional and a LIVE one must still get its channel-message grace
          // (Reynolds, 2026-06-05: don't blanket-deafen live poll-only agents).
          // Use recent heartbeat as the liveness signal; if there's no heartbeat
          // info at all, default to live so a genuine agent isn't silently skipped.
          const participant = channel?.participants.find(p => p.id === agent.participantId);
          const updatedAt = participant?.activityUpdatedAt ? Date.parse(participant.activityUpdatedAt) : 0;
          sessionLive = updatedAt ? (Date.now() - updatedAt < 60_000) : true;
        }
      }
      if (agent && sessionLive) {
        await flushAgentMemory(channelId, agent);
      }
    } catch { /* best-effort */ }
  }

  await mutateChannels('pty-kill', async channelsData => {
    const channel = channelsData.channels.find(c => c.id === channelId);
    if (!channel?.roster) throw Object.assign(new Error('Channel or roster not found'), { statusCode: 404 });

    const agent = channel.roster.agents.find(a => a.id === agentId);
    if (!agent) throw Object.assign(new Error('Agent not found in roster'), { statusCode: 404 });

    killedAgentName = agent.name;

    await stopRosterAgentRuntime(agent);

    agent.status = 'stopped';
    agent.pid = undefined;
    agent.tmuxSessionName = undefined;
    agent.ptySessionId = undefined;
    agent.lastClaudeSessionId = undefined;
    agent.lastStoppedAt = now;
    // Cascade guard (2026-05-16): explicit kill disables autoResume so the
    // agent cannot be revived by a later startup/respawn loop. Without this,
    // a roster.kill returns success but the agent comes back the moment any
    // event triggers the auto-respawn path — producing "ghost" agents that
    // respond to channel traffic minutes after they were "killed." To bring
    // a killed agent back, the caller must explicitly roster.update it with
    // autoResume:true and then roster.respawn.
    //
    // Powershell exception (2026-05-17): BrowserDev / --chrome agents are not
    // subject to the tmux auto-respawn loop that produced the original ghost
    // behaviour, and they ARE expected to be revived by instrumentation.ts'
    // startup auto-respawn (autoResume gate). Zeroing autoResume here meant
    // every transient kill (timeout, restart, manual stop-and-start) left Edge
    // unable to come back without a fresh button click — exactly the "goes
    // offline and stays offline" pattern the owner reported. Skip the guard for
    // powershell agents.
    if (!isWindowsPerMessageAgent(agent)) {
      agent.autoResume = false;
    }
    channel.roster.lastUpdated = now;

    // Sprint Hermes-postmortem Task 4 (Reynolds, 2026-05-27) — remove the
    // participant entry on kill so the UI immediately reflects "no longer
    // online". Without this the participant lingers as a zombie (especially
    // for non-claude wrappers whose SIGKILL bypasses the wrapper's atexit
    // leave). Match by stored roster.participantId AND by name+wrapper-type
    // to catch zombies whose id has drifted from the roster (Task 3 stops
    // future drift but existing entries still need cleanup here).
    //
    // We do NOT add to blockedParticipantIds — kill is recoverable; the
    // agent should be able to respawn via roster.respawn / message-inject.
    // collab.leave's blocking semantics are for user-initiated removal.
    const NON_CLAUDE_WRAPPER_TYPES = new Set(['codex','antigravity','grok','gemini']);
    const isWrapperAgentType = (t?: string): boolean =>
      (t?.includes('terminal') ?? false)
      || t === 'claude' || t === 'agent'
      || (t ? NON_CLAUDE_WRAPPER_TYPES.has(t) : false);
    channel.participants = channel.participants.filter(p => {
      if (p.id === agent.participantId) return false;
      if (p.name === agent.name && isWrapperAgentType(p.type)) return false;
      return true;
    });

    if (!silent) {
      channel.messages.push({
        id: randomUUID(), channelId,
        from: { id: 'system', type: 'user', name: 'System', source: 'DevFlow', joinedAt: now, lastSeen: now },
        content: `Agent "${agent.name}" was stopped`,
        timestamp: now,
      });
    }

    await saveChannels(channelsData);
  });

  if (killedAgentName) {
    await killOrphanedWrapperProcesses(killedAgentName, channelId);
  }
  await sweepStaleCollabFiles();

  if (killedAgentName) {
    logEvent('agent', 'low', `${killedAgentName} stopped`, {
      event: 'exit', agentName: killedAgentName, channelId,
      trigger: silent ? 'system' : 'manual',
    }).catch(() => {});
  }

  return NextResponse.json<PtyActionResponse>({ success: true });
}
