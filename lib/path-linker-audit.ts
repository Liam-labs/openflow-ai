/**
 * Audit log writer for Path Linker.
 * Sprint 37 P3-T4.
 *
 * Appends JSONL entries to event-logs/path-linker.jsonl.
 * Every open request (allowed or denied) is logged for forensics.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEntry {
  /** ISO timestamp */
  ts: string;
  /** Who triggered the open (if known) */
  actor?: string;
  /** The original Linux path */
  path: string;
  /** Decision: 'allowed' | 'denied:not-in-allowlist' | 'denied:not-found' | etc */
  decision: string;
  /** The translated Windows path (only on success) */
  winpath?: string;
}

export interface WriteAuditInput {
  path: string;
  decision: string;
  winpath?: string;
  actor?: string;
}

let dirEnsured = new Set<string>();

/**
 * Append an audit entry to the given JSONL log file.
 * Creates the file and parent directories if they don't exist.
 */
export async function writeAuditEntry(
  logPath: string,
  input: WriteAuditInput
): Promise<void> {
  const dir = dirname(logPath);
  if (!dirEnsured.has(dir)) {
    await mkdir(dir, { recursive: true });
    dirEnsured.add(dir);
  }

  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    path: input.path,
    decision: input.decision,
  };

  if (input.actor) entry.actor = input.actor;
  if (input.winpath) entry.winpath = input.winpath;

  const line = JSON.stringify(entry) + '\n';
  await appendFile(logPath, line, 'utf-8');
}

/**
 * Reset internal state — for testing only.
 */
export function resetAuditForTest(): void {
  dirEnsured = new Set();
}
