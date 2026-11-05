/**
 * Hands a stored key to a starting agent without putting it in an argument, a log or a long-lived file.
 *
 * The broker's start-agent action calls handoffPrefix(). It writes the values to a file only the app can read (mode 0600, in a fresh
 * 0700 folder) and returns a shell prefix that names the file, never the values. The agent's launch shell runs the prefix first: it
 * exports each NAME=value into the agent's own environment, then deletes the folder. If the agent never starts, a timer deletes it.
 *
 * Known limit (broker-spec.md): the agent's process holds the key, so a tool with shell access in that agent could read its environment.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { secretNameAllowed, secretValueAllowed } from '@/lib/secrets-file';

export const HANDOFF_TTL_MS = 60_000;

export function handoffPrefix(secrets: Record<string, string>): string {
  const entries = Object.entries(secrets);
  if (entries.length === 0) return '';
  for (const [name, value] of entries) {
    if (!secretNameAllowed(name) || !secretValueAllowed(value) || /[\r\n\0]/.test(value)) throw new Error('That key cannot be handed to an agent.');
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dfl-handoff-'), { mode: 0o700 } as never);
  const file = path.join(dir, 'env');
  writeFileSync(file, entries.map(([n, v]) => `${n}=${v}`).join('\n') + '\n', { mode: 0o600 });
  const timer = setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }, HANDOFF_TTL_MS);
  timer.unref?.();
  return `while IFS== read -r _k _v; do export "$_k=$_v"; done < '${file}'; rm -rf '${dir}'; unset _k _v; `;
}
