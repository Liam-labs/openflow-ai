import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSingleFlightPoll,
  readBackfill,
  readDelta,
} from '@/lib/agent-stream-tail';

describe('createSingleFlightPoll', () => {
  it('skips overlapping polls and allows the next poll after settlement', async () => {
    let release: (() => void) | undefined;
    const poll = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const pollOnce = createSingleFlightPoll(poll);

    const first = pollOnce();
    await Promise.resolve();
    await expect(pollOnce()).resolves.toBe(false);
    expect(poll).toHaveBeenCalledTimes(1);

    release!();
    await expect(first).resolves.toBe(true);

    const third = pollOnce();
    expect(poll).toHaveBeenCalledTimes(2);
    release!();
    await expect(third).resolves.toBe(true);
  });
});

describe('readBackfill', () => {
  let sandbox: string;
  let file: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'agent-stream-tail-backfill-'));
    file = join(sandbox, 'session.jsonl');
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns empty when file is empty', async () => {
    writeFileSync(file, '');
    const result = await readBackfill(file, 50);
    expect(result.lines).toEqual([]);
    expect(result.offset).toBe(0);
  });

  it('returns all lines when file has fewer than requested', async () => {
    writeFileSync(file, 'line1\nline2\nline3\n');
    const result = await readBackfill(file, 50);
    expect(result.lines).toEqual(['line1', 'line2', 'line3']);
    expect(result.offset).toBe(18);
  });

  it('returns exactly the last N lines when file has more', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    writeFileSync(file, lines.join('\n') + '\n');
    const result = await readBackfill(file, 5);
    expect(result.lines).toEqual(['line95', 'line96', 'line97', 'line98', 'line99']);
  });

  it('offset equals file size after backfill', async () => {
    const content = 'a\nb\nc\n';
    writeFileSync(file, content);
    const result = await readBackfill(file, 50);
    expect(result.offset).toBe(Buffer.byteLength(content));
  });

  it('handles file with no trailing newline', async () => {
    writeFileSync(file, 'line1\nline2\nline3');
    const result = await readBackfill(file, 50);
    expect(result.lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('ignores blank lines', async () => {
    writeFileSync(file, 'a\n\nb\n\n\nc\n');
    const result = await readBackfill(file, 50);
    expect(result.lines).toEqual(['a', 'b', 'c']);
  });

  it('returns empty when file does not exist', async () => {
    const result = await readBackfill(join(sandbox, 'nonexistent.jsonl'), 50);
    expect(result.lines).toEqual([]);
    expect(result.offset).toBe(0);
  });
});

describe('readDelta', () => {
  let sandbox: string;
  let file: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'agent-stream-tail-delta-'));
    file = join(sandbox, 'session.jsonl');
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns empty delta when file has not grown', async () => {
    writeFileSync(file, 'line1\nline2\n');
    const result = await readDelta(file, 12, '');
    expect(result.lines).toEqual([]);
    expect(result.offset).toBe(12);
    expect(result.leftover).toBe('');
  });

  it('returns new complete lines after append', async () => {
    writeFileSync(file, 'line1\n');
    const first = await readDelta(file, 0, '');
    expect(first.lines).toEqual(['line1']);
    expect(first.offset).toBe(6);

    appendFileSync(file, 'line2\nline3\n');
    const second = await readDelta(file, first.offset, first.leftover);
    expect(second.lines).toEqual(['line2', 'line3']);
    expect(second.offset).toBe(18);
  });

  it('carries partial trailing line in leftover', async () => {
    writeFileSync(file, 'complete\npartial');
    const result = await readDelta(file, 0, '');
    expect(result.lines).toEqual(['complete']);
    expect(result.leftover).toBe('partial');
    expect(result.offset).toBe(16);
  });

  it('completes a partial line on next append', async () => {
    writeFileSync(file, 'partial');
    const first = await readDelta(file, 0, '');
    expect(first.lines).toEqual([]);
    expect(first.leftover).toBe('partial');

    appendFileSync(file, '-tail\ndone\n');
    const second = await readDelta(file, first.offset, first.leftover);
    expect(second.lines).toEqual(['partial-tail', 'done']);
    expect(second.leftover).toBe('');
  });

  it('detects truncation: offset > fileSize → resets to 0', async () => {
    writeFileSync(file, 'old1\nold2\nold3\n');
    // Caller thinks offset is 15 from before
    // File gets truncated and replaced
    writeFileSync(file, 'new1\n');
    const result = await readDelta(file, 15, '');
    expect(result.lines).toEqual(['new1']);
    expect(result.offset).toBe(5);
  });

  it('drops leftover on truncation to avoid data bleed', async () => {
    writeFileSync(file, 'new\n');
    const result = await readDelta(file, 100, 'stale-leftover');
    expect(result.lines).toEqual(['new']);
    expect(result.leftover).toBe('');
  });

  it('returns empty when file does not exist', async () => {
    const result = await readDelta(join(sandbox, 'gone.jsonl'), 0, '');
    expect(result.lines).toEqual([]);
    expect(result.offset).toBe(0);
    expect(result.leftover).toBe('');
  });

  it('ignores blank lines in delta', async () => {
    writeFileSync(file, 'a\n\n\nb\n');
    const result = await readDelta(file, 0, '');
    expect(result.lines).toEqual(['a', 'b']);
  });

  it('handles utf8 multi-byte correctly', async () => {
    const content = '{"msg":"héllo wörld 🚀"}\n';
    writeFileSync(file, content);
    const result = await readDelta(file, 0, '');
    expect(result.lines).toEqual(['{"msg":"héllo wörld 🚀"}']);
    expect(result.offset).toBe(Buffer.byteLength(content));
  });
});
