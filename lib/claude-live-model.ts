/**
 * Switch a running Claude Code agent to another model without restarting it
 * (the owner, 1 Oct 2026: changing an agent's model in DevFlow did nothing until the
 * next restart, though `/model` does it live in a terminal).
 *
 * Verified on Claude Code 2.1.280:
 *  - `/model <id>` switches at once on an idle session, but also saves the id
 *    as the machine-wide default in ~/.claude/settings.json; that would retarget
 *    every agent started without --model, so the previous value is restored.
 *  - On a conversation with history it asks "Switch model?" with "❯ 1. Yes"
 *    highlighted; that is confirmed only when Yes is the highlighted option.
 *  - The command is typed only into an empty composer, so it never merges with
 *    a channel message the wrapper has typed but not yet submitted.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { composerVisible, inputHasText } from '@/lib/tui-input';

const execFileAsync = promisify(execFile);
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const WAIT_FOR_EMPTY_MS = 10 * 60_000;
const CONFIRM_WINDOW_MS = 15_000;

export type LiveModelResult = 'applied' | 'not-ready' | 'unconfirmed';

async function capture(session: string): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['capture-pane', '-p', '-t', session]);
  return stdout;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function readDefaultModel(): Promise<{ present: boolean; value?: unknown }> {
  try {
    const data = JSON.parse(await fs.readFile(SETTINGS, 'utf-8'));
    return { present: 'model' in data, value: data.model };
  } catch {
    return { present: false };
  }
}

async function restoreDefaultModel(before: { present: boolean; value?: unknown }): Promise<void> {
  const raw = await fs.readFile(SETTINGS, 'utf-8');
  const data = JSON.parse(raw);
  if (before.present ? data.model === before.value : !('model' in data)) return;
  if (before.present) data.model = before.value;
  else delete data.model;
  const tmp = `${SETTINGS}.devflow-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, SETTINGS);
}

/** Pure check used by the confirm loop (exported for tests). */
export function modelSwitchState(pane: string, apiId: string): 'applied' | 'confirm' | 'waiting' {
  // Claude Code reports known models by display name ("Set model to Opus 5.5")
  // and newer ones by id, so look for the result line after our own command.
  const sent = pane.lastIndexOf(`/model ${apiId}`);
  if (sent >= 0 && pane.indexOf('Set model to ', sent) > sent) return 'applied';
  if (/Switch model\?/.test(pane) && /❯ 1\. Yes/.test(pane)) return 'confirm';
  return 'waiting';
}

export async function applyClaudeModelLive(session: string, apiId: string | null): Promise<LiveModelResult> {
  const target = apiId || 'default';

  // 1. Wait for an empty composer (agent may be mid-turn or mid-inject).
  const deadline = Date.now() + WAIT_FOR_EMPTY_MS;
  for (;;) {
    const pane = await capture(session);
    if (composerVisible(pane) && !inputHasText(pane)) break;
    if (Date.now() > deadline) return 'not-ready';
    await sleep(3_000);
  }

  const before = await readDefaultModel();
  try {
    await execFileAsync('tmux', ['send-keys', '-t', session, '-l', `/model ${target}`]);
    await sleep(400);
    await execFileAsync('tmux', ['send-keys', '-t', session, 'Enter']);

    // 2. Confirm the "Switch model?" dialog if it appears; wait for the result line.
    const confirmBy = Date.now() + CONFIRM_WINDOW_MS;
    let confirmed = false;
    while (Date.now() < confirmBy) {
      await sleep(700);
      const pane = await capture(session);
      const state = modelSwitchState(pane, target);
      if (state === 'applied') return 'applied';
      if (state === 'confirm' && !confirmed) {
        await execFileAsync('tmux', ['send-keys', '-t', session, 'Enter']);
        confirmed = true;
      }
    }
    // A confirmed busy switch may only report after the turn; it is accepted.
    return confirmed ? 'applied' : 'unconfirmed';
  } finally {
    // 3. Never leave the agent's choice as the machine-wide default.
    await sleep(500);
    await restoreDefaultModel(before).catch(() => {});
  }
}
