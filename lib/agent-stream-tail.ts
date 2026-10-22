/**
 * JSONL tail reader for the agent live-feed SSE endpoint.
 *
 * Sprint 36 Phase 1 — pure file-tailing helpers used by `/api/agent-stream`.
 *
 * Two operations:
 *   - `readBackfill(path, n)` — returns the last `n` non-blank lines of a
 *     jsonl file, plus the byte offset at EOF. Used once on SSE connect so
 *     the client has immediate context before the tail loop engages.
 *   - `readDelta(path, offset, leftover)` — reads any bytes appended past
 *     `offset`, splits into complete lines, and carries a partial trailing
 *     line forward in `leftover`. Detects truncation (file size < offset)
 *     and resets. Called on a polling interval by the route.
 *
 * Both functions return empty on missing file. Callers drive the polling
 * cadence and own rotation detection (compare against a re-resolved path).
 */

import { promises as fs } from 'node:fs';
import { MAX_RANGE_BYTES, type StreamFs } from '@/lib/agent-stream-fs';

export interface BackfillResult {
  lines: string[];
  offset: number;
}

export interface DeltaResult {
  lines: string[];
  offset: number;
  leftover: string;
}

/**
 * Wrap an async poll so timer ticks cannot overlap and race shared offsets.
 * Returns false for a skipped overlapping call and true after a completed one.
 */
export function createSingleFlightPoll(
  poll: () => Promise<void>,
): () => Promise<boolean> {
  let inFlight = false;
  return async () => {
    if (inFlight) return false;
    inFlight = true;
    try {
      await poll();
      return true;
    } finally {
      inFlight = false;
    }
  };
}

/**
 * Read the last `lineCount` non-blank lines from a jsonl file. Returns empty
 * + offset=0 when the file does not exist or cannot be read.
 */
export async function readBackfill(
  path: string,
  lineCount: number,
  fsx?: StreamFs,
): Promise<BackfillResult> {
  if (fsx?.remote) return readBackfillRemote(path, lineCount, fsx);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch {
    return { lines: [], offset: 0 };
  }
  const offset = Buffer.byteLength(raw);
  const all = raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (all.length <= lineCount) {
    return { lines: all, offset };
  }
  return { lines: all.slice(-lineCount), offset };
}

/**
 * Read any bytes appended past `startOffset`, split into complete lines,
 * and carry a partial trailing line forward in `leftover`. Detects
 * truncation (file size < startOffset) and resets offset/leftover to 0/''.
 * Returns empty result when the file does not exist.
 */
export async function readDelta(
  path: string,
  startOffset: number,
  leftover: string,
  fsx?: StreamFs,
): Promise<DeltaResult> {
  if (fsx?.remote) return readDeltaRemote(path, startOffset, leftover, fsx);
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    return { lines: [], offset: 0, leftover: '' };
  }
  const size = stat.size;

  let effectiveOffset = startOffset;
  let effectiveLeftover = leftover;
  if (size < startOffset) {
    // Truncation or rotation replaced the file with a smaller one.
    effectiveOffset = 0;
    effectiveLeftover = '';
  }

  if (size === effectiveOffset) {
    return { lines: [], offset: effectiveOffset, leftover: effectiveLeftover };
  }

  const bytesToRead = size - effectiveOffset;
  const buf = Buffer.alloc(bytesToRead);
  let fh;
  try {
    fh = await fs.open(path, 'r');
    await fh.read(buf, 0, bytesToRead, effectiveOffset);
  } catch {
    if (fh) await fh.close().catch(() => {});
    return { lines: [], offset: effectiveOffset, leftover: effectiveLeftover };
  }
  await fh.close().catch(() => {});

  const chunk = effectiveLeftover + buf.toString('utf-8');
  const parts = chunk.split('\n');
  // Last element is either an empty string (if chunk ended with \n) or a
  // partial line that hasn't been terminated yet.
  const newLeftover = parts.pop() ?? '';
  const lines = parts.map((line) => line.trimEnd()).filter((line) => line.length > 0);

  return {
    lines,
    offset: size,
    leftover: newLeftover,
  };
}

// ── Files on another machine ─────────────────────────────────────────────────
// The agent host serves byte ranges (at most MAX_RANGE_BYTES per call), so a session file of any size is never sent whole.

/** The last `lineCount` lines, from the end of the file: a partial first line (the range began mid-line) is dropped. */
async function readBackfillRemote(path: string, lineCount: number, fsx: StreamFs): Promise<BackfillResult> {
  const tail = await fsx.readTail(path, MAX_RANGE_BYTES);
  if (!tail) return { lines: [], offset: 0 };
  let text = tail.data.toString('utf-8');
  if (tail.offset > 0) {
    const firstBreak = text.indexOf('\n');
    text = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  }
  const all = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
  return { lines: all.length <= lineCount ? all : all.slice(-lineCount), offset: tail.size };
}

/**
 * New complete lines since `startOffset`. When more than one range is waiting, this call takes whole lines up to the cap and the
 * rest follows on the next poll, so a multi-byte character is never cut between two reads.
 */
async function readDeltaRemote(path: string, startOffset: number, leftover: string, fsx: StreamFs): Promise<DeltaResult> {
  const st = await fsx.stat(path);
  if (!st || !st.isFile) return { lines: [], offset: 0, leftover: '' };
  let offset = startOffset;
  let carry = leftover;
  if (st.size < offset) { offset = 0; carry = ''; }               // truncation or rotation replaced the file with a smaller one
  if (st.size === offset) return { lines: [], offset, leftover: carry };

  const read = await fsx.readRange(path, offset, Math.min(st.size - offset, MAX_RANGE_BYTES));
  if (!read) return { lines: [], offset, leftover: carry };
  let data = read.data;
  if (offset + data.length < read.size) {                          // more is waiting: stop at the last complete line
    const lastBreak = data.lastIndexOf(0x0a);
    data = lastBreak !== -1 ? data.subarray(0, lastBreak + 1) : data.subarray(0, completeUtf8Length(data));   // one very long line: at least a whole character
  }
  const parts = (carry + data.toString('utf-8')).split('\n');
  const newLeftover = parts.pop() ?? '';
  const lines = parts.map((line) => line.trimEnd()).filter((line) => line.length > 0);
  return { lines, offset: offset + data.length, leftover: newLeftover };
}

/** How many leading bytes of `data` end on a whole UTF-8 character (a read cut mid-character must not turn into a replacement mark). */
function completeUtf8Length(data: Buffer): number {
  let i = data.length - 1;
  let back = 0;
  while (i >= 0 && back < 3 && (data[i] & 0xc0) === 0x80) { i--; back++; }      // skip continuation bytes
  if (i < 0) return data.length;
  const lead = data[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return data.length - i < need ? i : data.length;
}
