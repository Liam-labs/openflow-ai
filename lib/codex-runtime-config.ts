/**
 * Live Codex TUI configuration for roster-managed agents.
 *
 * Codex 0.153 exposes reasoning selection through `/model` and Fast mode
 * through the `/fast` toggle. Both commands also persist into the active
 * profile, while AgentChat currently shares the `agentchat` profile. The
 * roster is therefore the source of truth: live changes are verified against
 * the pane, and the shared profile's managed keys are restored afterwards.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { AgentRosterEntry, CollabChannelsData } from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';

import { hostCall, hostForSession, tmuxRun } from '@/lib/host-executor';
const APPLY_LOCKS_KEY = '__devflowCodexRuntimeApplyLocks';
const PROFILE_APPLY_QUEUE_KEY = '__devflowCodexProfileApplyQueue';
const COMMAND_TIMEOUT_MS = 4_000;
const PROFILE_RESTORE_WINDOW_MS = 2_000;
const PROFILE_RESTORE_POLL_MS = 100;
const MANAGED_PROFILE_KEYS = ['model', 'model_reasoning_effort', 'service_tier'] as const;

export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

export interface CodexRuntimeState {
  model?: string;
  effort?: CodexReasoningEffort;
  fastMode?: boolean;
  promptReady: boolean;
}

export interface CodexRuntimeApplyResult {
  state: 'applied' | 'pending' | 'not-running' | 'not-codex' | 'failed';
  message?: string;
}

declare global {
  var __devflowCodexRuntimeApplyLocks: Set<string> | undefined;
  var __devflowCodexProfileApplyQueue: Promise<void> | undefined;
}

function applyLocks(): Set<string> {
  const root = globalThis as typeof globalThis & { [APPLY_LOCKS_KEY]?: Set<string> };
  root[APPLY_LOCKS_KEY] ??= new Set<string>();
  return root[APPLY_LOCKS_KEY]!;
}

async function withProfileApplyLock<T>(action: () => Promise<T>): Promise<T> {
  const root = globalThis as typeof globalThis & { [PROFILE_APPLY_QUEUE_KEY]?: Promise<void> };
  const previous = root[PROFILE_APPLY_QUEUE_KEY] ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  root[PROFILE_APPLY_QUEUE_KEY] = queued;

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (root[PROFILE_APPLY_QUEUE_KEY] === queued) {
      delete root[PROFILE_APPLY_QUEUE_KEY];
    }
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function isEffort(value: string | undefined): value is CodexReasoningEffort {
  return !!value && (CODEX_REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Parse the current effort/Fast labels rendered by the Codex TUI. */
export function parseCodexRuntimeState(rawPane: string): CodexRuntimeState {
  const lines = stripAnsi(rawPane).split(/\r?\n/);
  let model: string | undefined;
  let effort: CodexReasoningEffort | undefined;
  let fastMode: boolean | undefined;

  // The compact footer is authoritative and sits below history. The expanded
  // status card is the startup equivalent. Search bottom-up for the newest one.
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    const compact = line.match(/^\s*(\S+)\s+(low|medium|high|xhigh|max|ultra)\b(.*?)·/i);
    const expanded = line.match(/model:\s*(\S+)\s+(low|medium|high|xhigh|max|ultra)\b(.*?)(?:│|$)/i);
    const match = compact ?? expanded;
    if (!match) continue;
    model = match[1].toLowerCase();
    const candidate = match[2].toLowerCase();
    if (isEffort(candidate)) effort = candidate;
    fastMode = /\bfast\b/i.test(match[3]);
    break;
  }

  // History is a fallback for the brief redraw between command acceptance and
  // footer refresh. Walk forward so the last status event wins.
  for (const line of lines) {
    const modelChange = line.match(/Model changed to (\S+)\s+(low|medium|high|xhigh|max|ultra)\b/i);
    if (!model && modelChange) model = modelChange[1].toLowerCase();
    if (!effort && modelChange) {
      const candidate = modelChange[2].toLowerCase();
      if (isEffort(candidate)) effort = candidate;
    }
    if (fastMode === undefined && /Service tier set to priority/i.test(line)) fastMode = true;
    if (fastMode === undefined && /Service tier set to default/i.test(line)) fastMode = false;
  }

  const nonEmpty = lines.map(line => line.trim()).filter(Boolean);
  const tail = nonEmpty.slice(-5);
  const promptReady = tail.some(line => line.includes('Ask Codex to do anything'))
    && tail.some(line => /^\S+\s+(?:low|medium|high|xhigh|max|ultra)\b.*·/.test(line));

  return { model, effort, fastMode, promptReady };
}

/** Read the numbered model IDs exposed by Codex's `/model` picker. */
export function parseCodexModelMenu(rawPane: string): Map<string, string> {
  const options = new Map<string, string>();
  for (const line of stripAnsi(rawPane).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:›\s*)?(\d+)\.\s+(\S+)/);
    if (match) options.set(match[2].toLowerCase(), match[1]);
  }
  return options;
}

function topLevelTomlLine(content: string, key: string): string | undefined {
  const tableAt = content.search(/^\s*\[/m);
  const root = tableAt >= 0 ? content.slice(0, tableAt) : content;
  return root.split(/\r?\n/).find(line => new RegExp(`^\\s*${key}\\s*=`).test(line));
}

/** Restore only settings the TUI commands mutate, preserving unrelated writes. */
export function restoreManagedCodexProfileSettings(before: string, after: string): string {
  let result = after;
  for (const key of MANAGED_PROFILE_KEYS) {
    const prior = topLevelTomlLine(before, key);
    const current = topLevelTomlLine(result, key);
    if (current && prior) {
      result = result.replace(current, prior);
    } else if (current && !prior) {
      result = result.replace(new RegExp(`^\\s*${key}\\s*=.*(?:\\r?\\n|$)`, 'm'), '');
    } else if (!current && prior) {
      const tableAt = result.search(/^\s*\[/m);
      result = tableAt >= 0
        ? `${result.slice(0, tableAt)}${prior}\n${result.slice(tableAt)}`
        : `${result.replace(/\s*$/, '')}\n${prior}\n`;
    }
  }
  return result;
}

async function capturePane(tmuxSessionName: string): Promise<string> {
  const { stdout } = await tmuxRun(
    ['capture-pane', '-p', '-t', tmuxSessionName, '-S', '-120'],
    { timeout: COMMAND_TIMEOUT_MS },
  );
  return stdout;
}

async function sendLiteral(tmuxSessionName: string, text: string): Promise<void> {
  await tmuxRun(['send-keys', '-t', tmuxSessionName, '-l', text], { timeout: COMMAND_TIMEOUT_MS });
}

async function sendKey(tmuxSessionName: string, key: string): Promise<void> {
  await tmuxRun(['send-keys', '-t', tmuxSessionName, key], { timeout: COMMAND_TIMEOUT_MS });
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPane(
  tmuxSessionName: string,
  predicate: (pane: string) => boolean,
  timeoutMs = 3_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let latest = '';
  while (Date.now() < deadline) {
    latest = await capturePane(tmuxSessionName);
    if (predicate(latest)) return latest;
    await sleep(100);
  }
  throw new Error('Codex did not expose the expected configuration view');
}

async function selectModelAndEffort(
  tmuxSessionName: string,
  model: string | undefined,
  effort: CodexReasoningEffort,
): Promise<void> {
  await sendLiteral(tmuxSessionName, '/model');
  // tmux accepted the bytes, but the TUI still needs one render tick to ingest
  // the literal paste before Enter. Without this, Enter can race ahead and
  // leave `/model` sitting unsubmitted in the composer.
  await sleep(120);
  await sendKey(tmuxSessionName, 'Enter');
  const modelPane = await waitForPane(tmuxSessionName, pane => /Select Model(?: and Effort)?/i.test(stripAnsi(pane)));

  // The current model is initially selected. A numbered shortcut selects a
  // different model without relying on a registry/order coupling.
  if (model) {
    const shortcut = parseCodexModelMenu(modelPane).get(model.toLowerCase());
    if (!shortcut) throw new Error(`Codex model picker does not expose '${model}'`);
    await sendKey(tmuxSessionName, shortcut);
  } else {
    await sendKey(tmuxSessionName, 'Enter');
  }
  await waitForPane(tmuxSessionName, pane => {
    const plain = stripAnsi(pane);
    return /Select Reasoning Level for/i.test(plain)
      && (!model || plain.toLowerCase().includes(`select reasoning level for ${model.toLowerCase()}`));
  });

  const standardKey: Partial<Record<CodexReasoningEffort, string>> = {
    low: '1', medium: '2', high: '3', xhigh: '4',
  };
  const direct = standardKey[effort];
  if (direct) {
    await sendKey(tmuxSessionName, direct);
  } else {
    await sendKey(tmuxSessionName, '5');
    await waitForPane(tmuxSessionName, pane => /For difficult problems|highest usage/i.test(stripAnsi(pane)));
    await sendKey(tmuxSessionName, effort === 'max' ? '1' : '2');
  }

  // In Plan mode Codex asks whether the choice is Plan-only or global. The
  // config panel always represents the global roster setting, so select all modes.
  await sleep(150);
  const pane = await capturePane(tmuxSessionName);
  if (/Choose where to apply|All modes/i.test(stripAnsi(pane))) {
    await sendKey(tmuxSessionName, '2');
  }
}

async function toggleFast(tmuxSessionName: string): Promise<void> {
  await sendLiteral(tmuxSessionName, '/fast');
  await sleep(120);
  await sendKey(tmuxSessionName, 'Enter');
}

async function waitForRuntimeState(
  tmuxSessionName: string,
  expected: { model?: string; effort?: CodexReasoningEffort; fastMode?: boolean },
): Promise<CodexRuntimeState> {
  const pane = await waitForPane(tmuxSessionName, raw => {
    const state = parseCodexRuntimeState(raw);
    return (expected.model === undefined || state.model === expected.model)
      && (expected.effort === undefined || state.effort === expected.effort)
      && (expected.fastMode === undefined || state.fastMode === expected.fastMode)
      && state.promptReady;
  }, 4_000);
  return parseCodexRuntimeState(pane);
}

/** Resolve a wrapper or direct Codex PID to the active profile in its process tree. */
export async function findActiveCodexProfileName(
  pid: number | undefined,
  procRoot = '/proc',
): Promise<string | undefined> {
  if (!pid) return undefined;

  const queue = [pid];
  const seen = new Set<number>();
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift()!;
    if (!Number.isSafeInteger(current) || current <= 0 || seen.has(current)) continue;
    seen.add(current);

    try {
      const cmdline = (await fs.readFile(path.join(procRoot, String(current), 'cmdline'), 'utf8'))
        .split('\0')
        .filter(Boolean);
      const index = cmdline.lastIndexOf('--profile');
      if (index >= 0 && cmdline[index + 1]) return cmdline[index + 1];
    } catch { /* process may have exited between reads */ }

    try {
      const children = await fs.readFile(
        path.join(procRoot, String(current), 'task', String(current), 'children'),
        'utf8',
      );
      for (const child of children.trim().split(/\s+/)) {
        const childPid = Number(child);
        if (Number.isSafeInteger(childPid) && childPid > 0 && !seen.has(childPid)) queue.push(childPid);
      }
    } catch { /* leaf or exited process */ }
  }

  return undefined;
}

async function writeRestoredProfile(profilePath: string, before: string): Promise<void> {
  const after = await fs.readFile(profilePath, 'utf8');
  const restored = restoreManagedCodexProfileSettings(before, after);
  if (restored === after) return;

  const stat = await fs.stat(profilePath);
  const tempPath = `${profilePath}.runtime-restore-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tempPath, restored, { mode: stat.mode });
  await fs.rename(tempPath, profilePath);
}

/**
 * Codex persists slash-command settings asynchronously. Keep restoring only the
 * managed root keys for a bounded window so a delayed write cannot escape.
 */
export async function restoreSharedCodexProfileAfterAction(
  profilePath: string,
  before: string,
  windowMs = PROFILE_RESTORE_WINDOW_MS,
  pollMs = PROFILE_RESTORE_POLL_MS,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  do {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    await writeRestoredProfile(profilePath, before);
  } while (Date.now() < deadline);
}

async function withSharedProfileRestored<T>(session: string, action: () => Promise<T>): Promise<T> {
  const host = hostForSession(session);
  if (host) {
    return withProfileApplyLock(async () => {
      const guard = await hostCall<{ token: string | null }>(host, 'codex-profile', { session, action: 'begin' });
      try {
        return await action();
      } finally {
        if (guard.token) await hostCall(host, 'codex-profile', { session, action: 'finish', token: guard.token });
      }
    });
  }
  // Roster PIDs may be missing or stale. Resolve the actual pane process on its host.
  const { stdout } = await tmuxRun(['display-message', '-p', '-t', session, '#{pane_pid}']);
  if (await findActiveCodexProfileName(Number(stdout.trim())) !== 'agentchat') return action();

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const profilePath = path.join(codexHome, 'agentchat.config.toml');

  return withProfileApplyLock(async () => {
    const before = await fs.readFile(profilePath, 'utf8');
    try {
      return await action();
    } finally {
      try {
        await restoreSharedCodexProfileAfterAction(profilePath, before);
      } catch (error) {
        console.error('[codex-runtime-config] Failed to restore shared AgentChat profile:', error);
        throw error;
      }
    }
  });
}

export async function observeCodexRuntime(agent: AgentRosterEntry): Promise<CodexRuntimeState | undefined> {
  if (agent.agentType !== 'codex' || !agent.tmuxSessionName) return undefined;
  try {
    return parseCodexRuntimeState(await capturePane(agent.tmuxSessionName));
  } catch {
    return undefined;
  }
}

async function clearPendingRevision(channelId: string, agentId: string, revision: string): Promise<void> {
  await mutateChannels('codex-runtime-config:clear-pending-revision', async data => {
    const agent = data.channels.find(channel => channel.id === channelId)?.roster?.agents.find(item => item.id === agentId);
    if (agent?.runtimeConfigPending?.revision !== revision) return;
    agent.runtimeConfigPending = undefined;
    await saveChannels(data);
  });
}

/** Apply one durable pending request, or leave it queued until the prompt is idle. */
export async function applyPendingCodexRuntimeConfig(
  channelId: string,
  agentId: string,
): Promise<CodexRuntimeApplyResult> {
  const lockKey = `${channelId}:${agentId}`;
  const locks = applyLocks();
  if (locks.has(lockKey)) return { state: 'pending', message: 'A live configuration update is already in progress' };
  locks.add(lockKey);
  let pendingRevision: string | undefined;
  let inputChanged = false;

  try {
    const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, { channels: [], lastUpdated: '' });
    const channel = data.channels.find(item => item.id === channelId);
    const agent = channel?.roster?.agents.find(item => item.id === agentId);
    const pending = agent?.runtimeConfigPending;
    pendingRevision = pending?.revision;
    if (!agent || !pending) return { state: 'applied' };

    if (agent.agentType !== 'codex') {
      await clearPendingRevision(channelId, agentId, pending.revision);
      return { state: 'not-codex', message: 'Saved for the next launch; live controls are available only for Codex' };
    }
    if (!['running', 'away'].includes(agent.status) || !agent.tmuxSessionName) {
      await clearPendingRevision(channelId, agentId, pending.revision);
      return { state: 'not-running', message: 'Saved for the next launch' };
    }

    const initial = parseCodexRuntimeState(await capturePane(agent.tmuxSessionName));
    if (!initial.promptReady) {
      return { state: 'pending', message: 'Saved; waiting for the Codex prompt to become ready' };
    }

    await withSharedProfileRestored(agent.tmuxSessionName, async () => {
      let observed = initial;
      if (
        pending.effort !== undefined
        && (observed.model !== pending.model || observed.effort !== pending.effort)
      ) {
        inputChanged = true;
        await selectModelAndEffort(agent.tmuxSessionName!, pending.model, pending.effort);
        observed = await waitForRuntimeState(agent.tmuxSessionName!, {
          model: pending.model,
          effort: pending.effort,
        });
      }
      if (pending.fastMode !== undefined && observed.fastMode !== pending.fastMode) {
        if (!observed.promptReady) {
          observed = await waitForRuntimeState(agent.tmuxSessionName!, {
            model: pending.model,
            effort: pending.effort,
          });
        }
        inputChanged = true;
        await toggleFast(agent.tmuxSessionName!);
        await waitForRuntimeState(agent.tmuxSessionName!, {
          model: pending.model,
          effort: pending.effort,
          fastMode: pending.fastMode,
        });
      }
    });

    await clearPendingRevision(channelId, agentId, pending.revision);
    return { state: 'applied', message: 'Applied to the running Codex session' };
  } catch (error) {
    // Escape any half-open picker before leaving the durable request queued for
    // the monitor's next attempt.
    try {
      const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, { channels: [], lastUpdated: '' });
      const tmux = data.channels.find(item => item.id === channelId)?.roster?.agents.find(item => item.id === agentId)?.tmuxSessionName;
      if (tmux && inputChanged) {
        await sendKey(tmux, 'Escape');
        await sendKey(tmux, 'Escape');
        await sendKey(tmux, 'C-u');
      }
    } catch { /* best effort */ }
    // A fresh-idle attempt that still fails is not helped by hammering the TUI
    // every two seconds. The desired roster settings remain durable and will
    // be applied on restart; report the failed live attempt to the Save caller.
    if (pendingRevision) {
      try { await clearPendingRevision(channelId, agentId, pendingRevision); } catch { /* best effort */ }
    }
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) };
  } finally {
    locks.delete(lockKey);
  }
}

/** Retry every queued Codex config update once. */
export async function applyAllPendingCodexRuntimeConfigs(): Promise<void> {
  const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, { channels: [], lastUpdated: '' });
  const pending = data.channels.flatMap(channel =>
    (channel.roster?.agents ?? [])
      .filter(agent => agent.runtimeConfigPending)
      .map(agent => ({ channelId: channel.id, agentId: agent.id })),
  );
  await Promise.all(pending.map(item => applyPendingCodexRuntimeConfig(item.channelId, item.agentId)));
}
