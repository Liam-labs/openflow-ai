/**
 * Sprint 38 — shared tmux send-keys helper.
 *
 * Wraps `tmux send-keys -t <target> <text> Enter` as a Promise. Used
 * by the Sprint 38 auto-compact orchestrator (T4.3, sprints.complete)
 * and the tasks.complete flush trigger (T4.6). Centralised so both
 * call sites share the same timeout + escaping behaviour.
 *
 * Empirically verified by T4.2: this dispatcher path is
 * indistinguishable from a human typing `/flush-journal` or `/compact`
 * at the prompt. The command is queued by Claude Code's dispatcher
 * behind any in-flight turn and fires once the turn settles.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inputHasText } from '@/lib/tui-input';

const execFileAsync = promisify(execFile);
import { tmuxRun } from '@/lib/host-executor';

const DEFAULT_TIMEOUT_MS = 10_000;
const SUBMIT_DELAY_MS = 400;
const VERIFY_DELAY_MS = 1_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Type `text` into a tmux session's agent prompt and submit it.
 *
 * Text and Enter are sent as separate steps. In one send-keys call the keys
 * arrive as a single burst, which Claude Code treats as a paste: the Enter
 * becomes a newline inside the composer and nothing is submitted (Graceful
 * shutdown prompt left unsent, the owner 1 Oct 2026). If the composer still holds
 * text after Enter, Enter is pressed again (at most twice more).
 * `text` is sent literally (-l), never interpreted as tmux key names.
 */
export async function tmuxSendKeys(
  target: string,
  text: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const opts = { timeout: timeoutMs };
  await tmuxRun(['send-keys', '-t', target, '-l', text], opts);
  await sleep(SUBMIT_DELAY_MS);
  await tmuxRun(['send-keys', '-t', target, 'Enter'], opts);
  for (let retry = 0; retry < 2; retry++) {
    await sleep(VERIFY_DELAY_MS);
    const { stdout } = await tmuxRun(['capture-pane', '-p', '-t', target], opts);
    if (!inputHasText(stdout)) return;
    await tmuxRun(['send-keys', '-t', target, 'Enter'], opts);
  }
}
