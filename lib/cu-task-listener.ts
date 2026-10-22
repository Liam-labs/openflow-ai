/**
 * Computer-Use Task Listener
 *
 * Subscribes to `terminal:done` events from the event bus and reconciles the
 * owning ComputerUseTask record via the xref table. Also fires optional
 * caller-provided `callbackUrl` webhooks with the final payload.
 *
 * Registered once at boot (see app/instrumentation.ts).
 */

import { eventBus } from '@/lib/event-bus';
import type { ComputerUseSessionsData, ComputerUseTask, TerminalTask } from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';

let registered = false;

const TERMINAL_TO_CU_STATUS: Record<string, ComputerUseTask['status']> = {
  completed: 'completed',
  failed: 'failed',
  timeout: 'timeout',
  cancelled: 'killed',
};

// ─── Output normalisation ────────────────────────────────────────────────────
// `terminalTask.output` carries the raw stdout/stderr captured from a Claude
// TUI session. The buffer routinely contains:
//   • ANSI escape sequences (colour, cursor moves, OSC title-set, CSI K erase)
//   • The Claude welcome banner, drawn with Unicode box-drawing characters
//   • Leading prompt indicators on lines (`> `, `❯ `, `>>> `)
//   • Repeated trailing whitespace, trailing blank lines
// Downstream consumers (callbackUrl webhooks, dashboard task.status) want clean
// prose. The normaliser is deliberately non-destructive: it drops decoration
// only, never message content.

// Matches the bulk of ANSI escape sequences emitted by Claude's TUI:
//   • CSI:    ESC '[' ... final-byte-in-@-~     (covers SGR, cursor, erase)
//   • OSC:    ESC ']' ... BEL | ESC '\'           (window title / hyperlinks)
//   • Other:  ESC '(' / 'N' / 'O' single-byte    (charset selects)
const ANSI_REGEX = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][\x20-\x7e]|[NOM78cZ])/g;

// Box-drawing characters that frame the Claude TUI banner. Lines composed
// >50% of these characters are decorative chrome, not content — drop them.
// Range U+2500..U+257F covers all box-drawing variants used by the TUI.
const BOX_DRAWING_CHAR = /[─-╿]/;

// Common prompt prefixes the TUI prints at the start of a line. `> ` is
// Claude's interactive prompt marker; `❯ ` is the ZSH/Powerlevel echo when
// the CLI runs under an interactive shell wrapper; `>>> ` is the legacy
// Python-style fallback used by older terminals.
const PROMPT_PREFIX_REGEX = /^(?:>{1,3}|❯)\s+/;

/**
 * Strip Claude-TUI chrome from a raw terminal output buffer. Returns clean
 * prose suitable for downstream parsing (webhook payloads, task.status, etc).
 *
 * Order matters: ANSI is stripped first because banner-line detection looks
 * for box-drawing chars that ANSI sequences would otherwise mask.
 */
export function normaliseTaskOutput(raw: string | null | undefined): string {
  if (!raw) return '';

  // 1. Strip ANSI escape sequences entirely.
  let text = raw.replace(ANSI_REGEX, '');

  // 2. Drop banner lines: any line where >50% of non-whitespace chars are
  //    box-drawing — that's chrome, not message content. Threshold is per-line
  //    so an inline mention like "─ separator ─" inside prose is preserved.
  text = text.split('\n').filter((line) => {
    const stripped = line.replace(/\s+/g, '');
    if (stripped.length === 0) return true; // keep blank lines for now
    let boxCount = 0;
    for (const ch of stripped) {
      if (BOX_DRAWING_CHAR.test(ch)) boxCount++;
    }
    return boxCount * 2 < stripped.length; // < 50% box chars → keep
  }).join('\n');

  // 3. Strip prompt prefixes line-by-line.
  text = text.split('\n').map((line) => line.replace(PROMPT_PREFIX_REGEX, '')).join('\n');

  // 4. Trim trailing whitespace on each line, then collapse 3+ blank lines to 2.
  text = text.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  // 5. Trim leading and trailing blank lines on the whole buffer.
  return text.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '');
}

/**
 * Idempotent registration — safe to call multiple times (dev hot reload).
 */
export function registerCuTaskListener(): void {
  if (registered) return;
  registered = true;

  // SSEEventBus multiplexes all events through the 'sse-event' channel —
  // filter by type ourselves.
  eventBus.on('sse-event', async (event: { type: string; data: unknown }) => {
    if (event.type !== 'terminal:done') return;
    const terminalTask = event.data as TerminalTask | undefined;
    if (!terminalTask?.id) return;

    // Update the owning CU task (if any) under file lock
    type MatchedTask = { cuTask: ComputerUseTask; callbackUrl?: string };
    let matched: MatchedTask | null = null;

    try {
      await withFileLock(DataPaths.computerUseSessions, async () => {
        const data = await readJsonFile<ComputerUseSessionsData>(DataPaths.computerUseSessions, {
          sessions: [], tasks: [], bridgeStatus: null, xrefs: [],
        });
        const xref = (data.xrefs ?? []).find(x => x.terminalTaskId === terminalTask.id);
        if (!xref) return;

        const cuTask = data.tasks.find(t => t.id === xref.cuTaskId);
        if (!cuTask || cuTask.status !== 'running') return;

        const mapped = terminalTask.status
          ? TERMINAL_TO_CU_STATUS[terminalTask.status]
          : undefined;
        if (!mapped) return;

        cuTask.status = mapped;
        cuTask.result = terminalTask.output != null
          ? normaliseTaskOutput(terminalTask.output)
          : cuTask.result;
        cuTask.error = terminalTask.error ?? cuTask.error;
        cuTask.completedAt = terminalTask.completedAt ?? new Date().toISOString();
        cuTask.durationMs = terminalTask.durationMs
          ?? (Date.now() - new Date(cuTask.startedAt).getTime());

        await writeJsonFile(DataPaths.computerUseSessions, data);
        matched = { cuTask: { ...cuTask }, callbackUrl: xref.callbackUrl };
      });
    } catch (err) {
      console.error('[cu-task-listener] failed to reconcile CU task:', err);
      return;
    }

    const m = matched as MatchedTask | null;
    if (!m) return;

    // Fire the caller's webhook if provided — best-effort, non-blocking
    if (m.callbackUrl) {
      fetch(m.callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'computer-use.task.done',
          task: m.cuTask,
        }),
      }).catch(err => {
        console.error(`[cu-task-listener] callbackUrl POST failed: ${(err as Error).message}`);
      });
    }
  });

  console.log('[cu-task-listener] registered on terminal:done');
}
