/**
 * Moves the provider keys the setup wizard used to keep in credentials.json (Anthropic, OpenRouter, Grok) into the encrypted secret store,
 * so the model feature card sees them as linked and no plain copy stays on disk.
 *
 * Order, so a crash or a failed check never loses a key:
 *   1. copy credentials.json to a private backup (mode 0600),
 *   2. write each key to the store and read it back,
 *   3. blank only the keys that read back the same,
 *   4. remove the backup once the blanked file is on disk and every key still reads back.
 * If any step fails the backup stays, the file keeps the keys it could not move, and the names are reported.
 */
import fs from 'fs';
import type { SecretStore } from './secret-store';

const KEYS: ReadonlyArray<readonly [field: string, secret: string]> = [
  ['anthropicApiKey', 'ANTHROPIC_API_KEY'],
  ['openrouterApiKey', 'OPENROUTER_API_KEY'],
  ['grokApiKey', 'GROK_API_KEY'],
];

export interface WizardKeyMigration {
  moved: string[];
  failed: string[];
}

export function migrateWizardKeys(credentialsPath: string, store: SecretStore): WizardKeyMigration {
  const result: WizardKeyMigration = { moved: [], failed: [] };
  let text: string;
  try {
    text = fs.readFileSync(credentialsPath, 'utf8');
  } catch {
    return result;
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    return result;   // not ours to repair
  }
  if (!data || typeof data !== 'object') return result;
  const pending = KEYS.filter(([field]) => typeof data[field] === 'string' && (data[field] as string).trim() !== '');
  if (pending.length === 0) return result;

  const backup = `${credentialsPath}.before-store`;
  fs.writeFileSync(backup, text, { mode: 0o600 });
  fs.chmodSync(backup, 0o600);

  const next = { ...data };
  for (const [field, secret] of pending) {
    const value = (data[field] as string).trim();
    try {
      if (store.get(secret) !== value) store.set(secret, value);
      if (store.get(secret) !== value) throw new Error('read-back differs');
      next[field] = '';
      result.moved.push(secret);
    } catch {
      result.failed.push(secret);
    }
  }
  if (result.moved.length === 0) return result;   // nothing changed on disk; backup kept only if something failed
  const tmp = `${credentialsPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, credentialsPath);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    result.failed.push(...result.moved);
    result.moved = [];
    return result;
  }
  const stillThere = result.moved.every((secret) => {
    const field = KEYS.find(([, s]) => s === secret)![0];
    return store.get(secret) === (data[field] as string).trim();
  });
  if (stillThere && result.failed.length === 0) {
    try { fs.unlinkSync(backup); } catch { /* none */ }
  } else if (!stillThere) {
    fs.writeFileSync(credentialsPath, text, { mode: 0o600 });   // put the original back
    result.failed.push(...result.moved);
    result.moved = [];
  }
  return result;
}
